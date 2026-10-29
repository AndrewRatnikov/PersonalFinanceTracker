// @vitest-environment node
// No CONTRACT_GAPs: RLS policies (B3) and the common checks (B6, in order:
// not_signed_in, space_gone, not_space_member, not_space_owner) are specified.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  FAMILY_TABLES,
  approveMember,
  buildSpace,
  eventsOf,
  expectMinima,
  expectOk,
  expectPermissionDenied,
  fakeWrappedKey,
  familyUser,
  makeInvite,
  newUuid,
  pushSpace,
  requestToJoin,
  spaceRecord,
  startFamilyDb,
} from './familyHarness'
import type { FamilySpace, FamilyUser, SqlTestDb } from './familyHarness'

let ctx: SqlTestDb
let a: FamilySpace
let b: FamilySpace
let outsider: FamilyUser
let aWrap: Record<string, unknown>
let aMemberKey: Record<string, unknown>

beforeAll(async () => {
  ctx = await startFamilyDb()
  a = await buildSpace(ctx, { pending: 1 })
  // A member with a known wrapped key, so key visibility can be compared.
  const member = await familyUser(ctx)
  await requestToJoin(a.owner, a.spaceId, member)
  aMemberKey = fakeWrappedKey()
  await approveMember(a.owner, a.spaceId, member, aMemberKey)
  a.members.push(member)
  aWrap = aMemberKey

  b = await buildSpace(ctx, { active: 1 })
  outsider = await familyUser(ctx)
  expectOk(await pushSpace(a.owner, a.spaceId, [spaceRecord(1), spaceRecord(2)]))
  expectOk(await pushSpace(b.owner, b.spaceId, [spaceRecord(9)]))
}, 120_000)

afterAll(async () => {
  await ctx.close()
})

const SELECTABLE = ['spaces', 'space_members', 'space_keys', 'space_events'] as const

async function rowsAs(user: FamilyUser, table: string): Promise<Array<Record<string, unknown>>> {
  return ctx.asUser(user.userId, `select * from public.${table}`)
}

describe('outsiders and pending users read nothing (criterion 7)', () => {
  it('has data to protect', async () => {
    for (const table of FAMILY_TABLES) {
      const rows = await ctx.admin<{ n: number }>(`select count(*)::int as n from public.${table}`)
      expect(rows[0].n, table).toBeGreaterThan(0)
    }
  })

  it.each(SELECTABLE)('an outsider gets 0 rows from %s', async (table) => {
    expect(await rowsAs(outsider, table)).toEqual([])
  })

  it.each(SELECTABLE)('a pending user gets 0 rows from %s', async (table) => {
    expect(await rowsAs(a.pending[0], table)).toEqual([])
  })

  it.each(['space_invites', 'space_records'])('nobody can select from %s', async (table) => {
    await expectPermissionDenied(rowsAs(outsider, table))
    await expectPermissionDenied(rowsAs(a.pending[0], table))
    await expectPermissionDenied(rowsAs(a.members[0], table))
    await expectPermissionDenied(rowsAs(a.owner, table))
  })

  it('a pending user sees nothing through the functions either', async () => {
    const pending = a.pending[0]
    const view = expectOk<Record<string, unknown>>(await pending.rpc('get_my_space'))
    expect(view.status).toBe('pending')
    expect(view.members).toEqual([])
    expect(view.my_keys).toEqual([])
    expect(view.open_invites).toEqual([])

    expectMinima(await pushSpace(pending, a.spaceId, [spaceRecord(5)]), 'not_space_member')
    expectMinima(
      await pending.rpc('pull_space_records', {
        p_space_id: a.spaceId,
        p_device_id: pending.deviceId,
        p_since: 0,
      }),
      'not_space_member',
    )
    expectMinima(
      await pending.rpc('create_invite', {
        p_space_id: a.spaceId,
        p_token_hash: 'a'.repeat(64),
      }),
      'not_space_member',
    )
    expectMinima(
      await pending.rpc('rotate_space_key', { p_space_id: a.spaceId, p_new_version: 2, p_wraps: [] }),
      'not_space_member',
    )
    expect(expectOk(await pending.rpc('is_active_space_member', { p_space_id: a.spaceId }))).toBe(
      false,
    )
  })

  it('an outsider gets null from get_my_space and false from is_active_space_member', async () => {
    expect(expectOk(await outsider.rpc('get_my_space'))).toBeNull()
    expect(expectOk(await outsider.rpc('is_active_space_member', { p_space_id: a.spaceId }))).toBe(
      false,
    )
    expect(
      expectOk(await a.members[0].rpc('is_active_space_member', { p_space_id: a.spaceId })),
    ).toBe(true)
    expect(expectOk(await a.members[0].rpc('is_active_space_member', { p_space_id: b.spaceId }))).toBe(
      false,
    )
  })

  it('an outsider is refused by every function that takes a space', async () => {
    const o = outsider
    const calls = [
      o.rpc('create_invite', { p_space_id: a.spaceId, p_token_hash: 'a'.repeat(64) }),
      o.rpc('approve_member', {
        p_space_id: a.spaceId,
        p_user_id: a.pending[0].userId,
        p_key_version: 1,
        p_wrapped_key: fakeWrappedKey(),
      }),
      o.rpc('reject_member', { p_space_id: a.spaceId, p_user_id: a.pending[0].userId }),
      o.rpc('remove_member', { p_space_id: a.spaceId, p_user_id: a.members[0].userId }),
      o.rpc('rotate_space_key', { p_space_id: a.spaceId, p_new_version: 2, p_wraps: [] }),
      o.rpc('transfer_ownership', { p_space_id: a.spaceId, p_user_id: a.members[0].userId }),
      o.rpc('delete_space', { p_space_id: a.spaceId }),
      pushSpace(o, a.spaceId, [spaceRecord(3)]),
      o.rpc('pull_space_records', { p_space_id: a.spaceId, p_device_id: o.deviceId, p_since: 0 }),
      o.rpc('leave_space'),
    ]
    for (const res of await Promise.all(calls)) expectMinima(res, 'not_space_member')
  })
})

describe('what a member can see', () => {
  it('sees only their own space, with every member row and public key', async () => {
    const member = a.members[0]
    const spaces = await rowsAs(member, 'spaces')
    expect(spaces.map((s) => s.id)).toEqual([a.spaceId])

    const members = await rowsAs(member, 'space_members')
    expect(members.every((m) => m.space_id === a.spaceId)).toBe(true)
    const ids = members.map((m) => m.user_id).sort()
    expect(ids).toEqual(
      [a.owner.userId, a.pending[0].userId, ...a.members.map((m) => m.userId)].sort(),
    )
    expect(members.find((m) => m.user_id === a.pending[0].userId)?.status).toBe('pending')
    for (const m of members) expect(m.public_key).toMatchObject({ kty: 'EC', crv: 'P-256' })
  })

  it('sees the events of their own space only', async () => {
    const seen = await rowsAs(a.members[0], 'space_events')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((e) => e.space_id === a.spaceId)).toBe(true)
    expect(seen).toHaveLength((await eventsOf(ctx, a.spaceId)).length)
    expect((await rowsAs(b.members[0], 'space_events')).every((e) => e.space_id === b.spaceId)).toBe(
      true,
    )
  })

  it("never sees another member's space_keys rows", async () => {
    const member = a.members[0]
    const own = await rowsAs(member, 'space_keys')
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ user_id: member.userId, wrapped_key: aWrap })

    const ownerKeys = await rowsAs(a.owner, 'space_keys')
    expect(ownerKeys).toHaveLength(1)
    expect(ownerKeys[0].user_id).toBe(a.owner.userId)
    expect(ownerKeys[0].wrapped_key).not.toEqual(aWrap)

    // Asking for the other row by name returns nothing.
    const asked = await ctx.asUser(
      member.userId,
      'select * from public.space_keys where user_id = $1',
      [a.owner.userId],
    )
    expect(asked).toEqual([])
  })

  it('cannot write any table directly, even their own rows', async () => {
    const member = a.members[0]
    await expectPermissionDenied(
      ctx.asUser(member.userId, "update public.space_members set role = 'owner' where user_id = $1", [
        member.userId,
      ]),
    )
    await expectPermissionDenied(
      ctx.asUser(member.userId, 'delete from public.space_keys where user_id = $1', [member.userId]),
    )
    await expectPermissionDenied(
      ctx.asUser(member.userId, "insert into public.space_events (space_id, kind) values ($1, 'created')", [
        a.spaceId,
      ]),
    )
    await expectPermissionDenied(
      ctx.asUser(member.userId, 'update public.spaces set key_version = 99 where id = $1', [a.spaceId]),
    )
    const space = await ctx.admin<{ key_version: number }>(
      'select key_version from public.spaces where id = $1',
      [a.spaceId],
    )
    expect(space[0].key_version).toBe(1)
  })
})

describe('space A cannot touch space B (criterion 7)', () => {
  it.each([
    ['the owner of A', () => a.owner],
    ['a member of A', () => a.members[0]],
  ])('%s gets not_space_member on space B for every function', async (_name, who) => {
    const user = who()
    const target = b.members[0]
    const calls = [
      user.rpc('create_invite', { p_space_id: b.spaceId, p_token_hash: 'a'.repeat(64) }),
      user.rpc('approve_member', {
        p_space_id: b.spaceId,
        p_user_id: target.userId,
        p_key_version: 1,
        p_wrapped_key: fakeWrappedKey(),
      }),
      user.rpc('reject_member', { p_space_id: b.spaceId, p_user_id: target.userId }),
      user.rpc('remove_member', { p_space_id: b.spaceId, p_user_id: target.userId }),
      user.rpc('rotate_space_key', { p_space_id: b.spaceId, p_new_version: 2, p_wraps: [] }),
      user.rpc('transfer_ownership', { p_space_id: b.spaceId, p_user_id: target.userId }),
      user.rpc('delete_space', { p_space_id: b.spaceId }),
      pushSpace(user, b.spaceId, [spaceRecord(7)]),
      user.rpc('pull_space_records', {
        p_space_id: b.spaceId,
        p_device_id: user.deviceId,
        p_since: 0,
      }),
    ]
    for (const res of await Promise.all(calls)) expectMinima(res, 'not_space_member')

    // Space B is exactly as it was.
    const members = await ctx.admin<{ n: number }>(
      'select count(*)::int as n from public.space_members where space_id = $1',
      [b.spaceId],
    )
    expect(members[0].n).toBe(2)
    expect((await ctx.admin('select 1 from public.spaces where id = $1', [b.spaceId])).length).toBe(1)
    const records = await ctx.admin<{ n: number }>(
      'select count(*)::int as n from public.space_records where space_id = $1',
      [b.spaceId],
    )
    expect(records[0].n).toBe(1)
  })

  it("revoke_invite on space B's invite is not_space_member for an A member", async () => {
    const invite = await makeInvite(b.owner, b.spaceId)
    expectMinima(
      await a.owner.rpc('revoke_invite', { p_invite_id: invite.inviteId }),
      'not_space_member',
    )
    expectMinima(
      await a.members[0].rpc('revoke_invite', { p_invite_id: invite.inviteId }),
      'not_space_member',
    )
    const row = await ctx.admin('select revoked_at from public.space_invites where id = $1', [
      invite.inviteId,
    ])
    expect(row[0].revoked_at).toBeNull()
  })

  it("a member of A reading B's rows by id gets nothing", async () => {
    const rows = await ctx.asUser(
      a.members[0].userId,
      'select * from public.space_members where space_id = $1',
      [b.spaceId],
    )
    expect(rows).toEqual([])
    const spaces = await ctx.asUser(a.members[0].userId, 'select * from public.spaces where id = $1', [
      b.spaceId,
    ])
    expect(spaces).toEqual([])
  })
})

describe('space_gone', () => {
  it('an unknown or null space id is space_gone for every function that takes a space', async () => {
    const u = a.owner
    const ghost = newUuid()
    for (const id of [ghost, null]) {
      const calls = [
        u.rpc('create_invite', { p_space_id: id, p_token_hash: 'a'.repeat(64) }),
        u.rpc('approve_member', {
          p_space_id: id,
          p_user_id: a.pending[0].userId,
          p_key_version: 1,
          p_wrapped_key: fakeWrappedKey(),
        }),
        u.rpc('reject_member', { p_space_id: id, p_user_id: a.pending[0].userId }),
        u.rpc('remove_member', { p_space_id: id, p_user_id: a.members[0].userId }),
        u.rpc('rotate_space_key', { p_space_id: id, p_new_version: 2, p_wraps: [] }),
        u.rpc('transfer_ownership', { p_space_id: id, p_user_id: a.members[0].userId }),
        u.rpc('delete_space', { p_space_id: id }),
        pushSpace(u, id as string, [spaceRecord(3)]),
        u.rpc('pull_space_records', { p_space_id: id, p_device_id: u.deviceId, p_since: 0 }),
      ]
      for (const res of await Promise.all(calls)) expectMinima(res, 'space_gone')
    }
  })

  it('space_gone is checked before the caller is looked at, so it does not depend on membership', async () => {
    const res = await outsider.rpc('delete_space', { p_space_id: newUuid() })
    expectMinima(res, 'space_gone')
    const real = await outsider.rpc('delete_space', { p_space_id: a.spaceId })
    expectMinima(real, 'not_space_member')
  })
})

describe('the helper behind the policies', () => {
  it('is_active_space_member is the only thing deciding row access', async () => {
    // A pending user becomes able to read as soon as they are approved.
    const extra = await familyUser(ctx)
    await requestToJoin(a.owner, a.spaceId, extra)
    expect(await rowsAs(extra, 'space_members')).toEqual([])
    await approveMember(a.owner, a.spaceId, extra)
    expect((await rowsAs(extra, 'space_members')).length).toBeGreaterThan(1)
    expect((await rowsAs(extra, 'space_keys')).length).toBe(1)

    // And loses it again when removed.
    expectOk(
      await a.owner.rpc('remove_member', { p_space_id: a.spaceId, p_user_id: extra.userId }),
    )
    expect(await rowsAs(extra, 'space_members')).toEqual([])
    expect(await rowsAs(extra, 'space_events')).toEqual([])
  })
})
