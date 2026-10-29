// @vitest-environment node
// No CONTRACT_GAPs: delete_space, the owner_id cascade, the before-delete
// trigger for members (D5) and the get_my_space shape come from plan B2, B5
// and B6.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  FAMILY_TABLES,
  approveMember,
  buildSpace,
  countRows,
  createFamilySpace,
  eventsOf,
  expectMinima,
  expectOk,
  fakePublicJwk,
  fakeWrappedKey,
  familyUser,
  makeInvite,
  pullSpace,
  pushSpace,
  requestToJoin,
  rotateKey,
  spaceRecord,
  startFamilyDb,
} from './familyHarness'
import type { FamilySpace, FamilyUser, SqlTestDb } from './familyHarness'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startFamilyDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

// A space with an active member, a pending request, an open invite, records, a
// rotated key and therefore rows in all six tables.
async function fullSpace(): Promise<FamilySpace> {
  const space = await buildSpace(ctx, { active: 1, pending: 1 })
  await makeInvite(space.owner, space.spaceId)
  expectOk(await pushSpace(space.owner, space.spaceId, [spaceRecord(1), spaceRecord(2)]))
  expectOk(await pushSpace(space.members[0], space.spaceId, [spaceRecord(3)]))
  expectOk(await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, space.members[0].userId]))
  return space
}

async function counts(spaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of FAMILY_TABLES) out[table] = await countRows(ctx, table, spaceId)
  return out
}

describe('delete_space (criterion 12)', () => {
  it('removes every row of all six tables for that space, and only that space', async () => {
    const doomed = await fullSpace()
    const other = await fullSpace()

    const before = await counts(doomed.spaceId)
    for (const table of FAMILY_TABLES) expect(before[table], table).toBeGreaterThan(0)
    const otherBefore = await counts(other.spaceId)

    const res = expectOk(await doomed.owner.rpc('delete_space', { p_space_id: doomed.spaceId }))
    expect(res).toEqual({ space_id: doomed.spaceId })

    expect(await counts(doomed.spaceId)).toEqual({
      spaces: 0,
      space_members: 0,
      space_invites: 0,
      space_keys: 0,
      space_records: 0,
      space_events: 0,
    })
    expect(await counts(other.spaceId)).toEqual(otherBefore)
  })

  it('former members get null from get_my_space and space_gone elsewhere', async () => {
    const space = await fullSpace()
    expectOk(await space.owner.rpc('delete_space', { p_space_id: space.spaceId }))

    for (const user of [space.owner, space.members[0], space.pending[0]]) {
      expect(expectOk(await user.rpc('get_my_space'))).toBeNull()
    }
    expectMinima(await pushSpace(space.members[0], space.spaceId, [spaceRecord(9)]), 'space_gone')
    expectMinima(await pullSpace(space.members[0], space.spaceId), 'space_gone')
    expectMinima(
      await space.members[0].rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: 'a'.repeat(64),
      }),
      'space_gone',
    )
    expectMinima(await space.owner.rpc('delete_space', { p_space_id: space.spaceId }), 'space_gone')
    expectMinima(await space.members[0].rpc('leave_space'), 'not_space_member')
  })

  it('frees everybody to join or create a space again', async () => {
    const space = await fullSpace()
    const other = await buildSpace(ctx)
    expectOk(await space.owner.rpc('delete_space', { p_space_id: space.spaceId }))

    await createFamilySpace(space.owner)
    const joiner = space.members[0]
    await requestToJoin(other.owner, other.spaceId, joiner)
    const view = expectOk<{ status: string; space_id: string }>(await joiner.rpc('get_my_space'))
    expect(view).toMatchObject({ status: 'pending', space_id: other.spaceId })
  })

  it('refuses a member, a pending user and an outsider, and leaves the space alone', async () => {
    const space = await fullSpace()
    const outsider = await familyUser(ctx)
    const before = await counts(space.spaceId)
    expectMinima(
      await space.members[0].rpc('delete_space', { p_space_id: space.spaceId }),
      'not_space_owner',
    )
    expectMinima(
      await space.pending[0].rpc('delete_space', { p_space_id: space.spaceId }),
      'not_space_member',
    )
    expectMinima(
      await outsider.rpc('delete_space', { p_space_id: space.spaceId }),
      'not_space_member',
    )
    expect(await counts(space.spaceId)).toEqual(before)
  })
})

describe('deleting accounts (criterion 12)', () => {
  it("deleting the owner's auth user deletes the space and everything in it", async () => {
    const space = await fullSpace()
    const other = await fullSpace()
    const otherBefore = await counts(other.spaceId)

    await ctx.admin('delete from auth.users where id = $1', [space.owner.userId])

    expect(await counts(space.spaceId)).toEqual({
      spaces: 0,
      space_members: 0,
      space_invites: 0,
      space_keys: 0,
      space_records: 0,
      space_events: 0,
    })
    expect(await counts(other.spaceId)).toEqual(otherBefore)
    // The members are free and see no space.
    expect(expectOk(await space.members[0].rpc('get_my_space'))).toBeNull()
    expect(expectOk(await space.pending[0].rpc('get_my_space'))).toBeNull()
  })

  it('delete_own_account by the owner does the same', async () => {
    const space = await fullSpace()
    expectOk(await space.owner.rpc('delete_own_account'))
    expect(await countRows(ctx, 'spaces', space.spaceId)).toBe(0)
    expect(await countRows(ctx, 'space_members', space.spaceId)).toBe(0)
    expect(await countRows(ctx, 'space_records', space.spaceId)).toBe(0)
  })

  it("deleting a member's auth user removes their membership and keys and writes a left event", async () => {
    const space = await buildSpace(ctx, { active: 2 })
    const [leaving, staying] = space.members
    expectOk(await pushSpace(leaving, space.spaceId, [spaceRecord(1)]))
    expectOk(await rotateKey(space.owner, space.spaceId, 2, [
      space.owner.userId,
      leaving.userId,
      staying.userId,
    ]))
    const keysBefore = await ctx.admin<{ n: number }>(
      'select count(*)::int as n from public.space_keys where user_id = $1',
      [leaving.userId],
    )
    expect(keysBefore[0].n).toBe(2)
    const eventsBefore = (await eventsOf(ctx, space.spaceId)).length

    await ctx.admin('delete from auth.users where id = $1', [leaving.userId])

    expect(
      await ctx.admin('select 1 from public.space_members where user_id = $1', [leaving.userId]),
    ).toHaveLength(0)
    expect(
      await ctx.admin('select 1 from public.space_keys where user_id = $1', [leaving.userId]),
    ).toHaveLength(0)

    const events = await eventsOf(ctx, space.spaceId)
    expect(events).toHaveLength(eventsBefore + 1)
    expect(events.at(-1)).toMatchObject({ kind: 'left', actor_id: leaving.userId })

    // The space, the other members and the record they wrote are untouched.
    expect(await countRows(ctx, 'spaces', space.spaceId)).toBe(1)
    expect(expectOk<{ status: string }>(await staying.rpc('get_my_space')).status).toBe('active')
    const pulled = expectOk<{ records: Array<{ author_id: string }> }>(
      await pullSpace(space.owner, space.spaceId),
    )
    expect(pulled.records).toHaveLength(1)
    expect(pulled.records[0].author_id).toBe(leaving.userId)
    // The owner can rotate again for the remaining members.
    expectOk(await rotateKey(space.owner, space.spaceId, 3, [space.owner.userId, staying.userId]))
  })

  it('a pending request also leaves a left event when its account is deleted', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    await ctx.admin('delete from auth.users where id = $1', [space.pending[0].userId])
    expect(
      await ctx.admin('select 1 from public.space_members where user_id = $1', [
        space.pending[0].userId,
      ]),
    ).toHaveLength(0)
    expect((await eventsOf(ctx, space.spaceId)).at(-1)).toMatchObject({
      kind: 'left',
      actor_id: space.pending[0].userId,
    })
    expect(await countRows(ctx, 'spaces', space.spaceId)).toBe(1)
  })

  it('deleting a user who is in no space writes no event anywhere', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const loner = await familyUser(ctx)
    const before = await ctx.admin<{ n: number }>('select count(*)::int as n from public.space_events')
    await ctx.admin('delete from auth.users where id = $1', [loner.userId])
    const after = await ctx.admin<{ n: number }>('select count(*)::int as n from public.space_events')
    expect(after[0].n).toBe(before[0].n)
    expect(await countRows(ctx, 'space_members', space.spaceId)).toBe(2)
  })
})

describe('get_my_space shape (criterion 12)', () => {
  const KEYS = [
    'last_seq',
    'key_version',
    'limits',
    'members',
    'my_keys',
    'open_invites',
    'owner_id',
    'paused',
    'record_count',
    'role',
    'space_id',
    'status',
    'total_bytes',
  ].sort()

  interface View {
    space_id: string
    role: string
    status: string
    key_version: number | null
    owner_id: string | null
    members: Array<Record<string, unknown>>
    my_keys: Array<{ key_version: number; wrapped_key: unknown }>
    open_invites: Array<{ id: string; expires_at: string }>
    paused: boolean
    limits: Record<string, unknown> | null
    last_seq: number | null
    record_count: number | null
    total_bytes: number | null
  }

  async function view(user: FamilyUser): Promise<View> {
    return expectOk<View>(await user.rpc('get_my_space'))
  }

  it('is null for a user without a space', async () => {
    expect(expectOk(await (await familyUser(ctx)).rpc('get_my_space'))).toBeNull()
  })

  it('the owner sees members, the key, open invites, limits and totals', async () => {
    const owner = await familyUser(ctx)
    const ownerKey = fakeWrappedKey()
    const ownerPub = fakePublicJwk()
    const spaceId = await createFamilySpace(owner, undefined, ownerPub, ownerKey)

    const bob = await familyUser(ctx)
    const bobJoin = await requestToJoin(owner, spaceId, bob)
    const carol = await familyUser(ctx)
    await requestToJoin(owner, spaceId, carol)
    const bobKey = fakeWrappedKey()
    await approveMember(owner, spaceId, bob, bobKey)
    const open = await makeInvite(owner, spaceId)
    expectOk(await pushSpace(owner, spaceId, [spaceRecord(1, 1000, 10), spaceRecord(2, 1000, 15)]))

    const v = await view(owner)
    expect(Object.keys(v).sort()).toEqual(KEYS)
    expect(v).toMatchObject({
      space_id: spaceId,
      role: 'owner',
      status: 'active',
      key_version: 1,
      owner_id: owner.userId,
      paused: false,
      last_seq: 2,
      record_count: 2,
      total_bytes: 25,
    })
    expect(v.limits).toMatchObject({
      shared_spaces: true,
      max_members: 6,
      max_space_records: 100000,
      max_space_bytes: 104857600,
    })
    expect(v.my_keys).toEqual([{ key_version: 1, wrapped_key: ownerKey }])

    // The owner comes first, then by request time.
    expect(v.members.map((m) => m.user_id)).toEqual([owner.userId, bob.userId, carol.userId])
    for (const m of v.members) {
      expect(Object.keys(m).sort()).toEqual([
        'email',
        'joined_at',
        'public_key',
        'requested_at',
        'role',
        'status',
        'user_id',
      ])
    }
    expect(v.members[0]).toMatchObject({
      email: owner.email,
      role: 'owner',
      status: 'active',
      public_key: ownerPub,
    })
    expect(v.members[1]).toMatchObject({
      email: bob.email,
      role: 'member',
      status: 'active',
      public_key: bobJoin.publicKey,
    })
    expect(v.members[1].joined_at).not.toBeNull()
    expect(v.members[2]).toMatchObject({ email: carol.email, status: 'pending', joined_at: null })

    // Only the open invites: bob's was used.
    expect(v.open_invites.map((i) => i.id)).toEqual([open.inviteId])
    expect(Date.parse(v.open_invites[0].expires_at)).toBeGreaterThan(Date.now())
  })

  it('a member sees members and their own key, but no invites', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    await makeInvite(space.owner, space.spaceId)
    const [b, c] = space.members

    const v = await view(b)
    expect(Object.keys(v).sort()).toEqual(KEYS)
    expect(v).toMatchObject({
      space_id: space.spaceId,
      role: 'member',
      status: 'active',
      key_version: 1,
      owner_id: space.owner.userId,
      paused: false,
    })
    expect(v.open_invites).toEqual([])
    expect(v.my_keys).toHaveLength(1)
    const stored = await ctx.admin<{ wrapped_key: unknown }>(
      'select wrapped_key from public.space_keys where user_id = $1',
      [b.userId],
    )
    expect(v.my_keys[0].wrapped_key).toEqual(stored[0].wrapped_key)
    const other = await view(c)
    expect(other.my_keys[0].wrapped_key).not.toEqual(v.my_keys[0].wrapped_key)

    expect(v.members.map((m) => m.email).sort()).toEqual(
      [space.owner.email, b.email, c.email].sort(),
    )
    expect(v.limits).toMatchObject({ max_members: 6 })
    expect(typeof v.last_seq).toBe('number')
  })

  it('a pending user sees only their own pending status', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    await makeInvite(space.owner, space.spaceId)
    const v = await view(space.pending[0])
    expect(Object.keys(v).sort()).toEqual(KEYS)
    expect(v).toEqual({
      space_id: space.spaceId,
      role: 'member',
      status: 'pending',
      key_version: null,
      owner_id: null,
      members: [],
      my_keys: [],
      open_invites: [],
      paused: false,
      limits: null,
      last_seq: null,
      record_count: null,
      total_bytes: null,
    })
  })

  it('emails are shown to members of the same space only', async () => {
    const one = await buildSpace(ctx, { active: 1 })
    const two = await buildSpace(ctx, { active: 1 })
    const text = JSON.stringify(await view(one.members[0]))
    expect(text).toContain(one.owner.email)
    expect(text).not.toContain(two.owner.email)
    expect(text).not.toContain(two.members[0].email)
    expect(JSON.stringify(await view(two.members[0]))).not.toContain(one.owner.email)
  })

  it('after a rotation my_keys is ascending by version', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    expectOk(
      await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, space.members[0].userId]),
    )
    expectOk(
      await rotateKey(space.owner, space.spaceId, 3, [space.owner.userId, space.members[0].userId]),
    )
    const v = await view(space.members[0])
    expect(v.my_keys.map((k) => k.key_version)).toEqual([1, 2, 3])
    expect(v.key_version).toBe(3)
  })
})
