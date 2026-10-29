// @vitest-environment node
// No CONTRACT_GAPs: error codes and check order are pinned in plan section B6
// (decision D6 for the cases the task leaves open).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  approveMember,
  buildSpace,
  createFamilySpace,
  eventKinds,
  eventsOf,
  expectMinima,
  expectOk,
  fakePublicJwk,
  fakeWrappedKey,
  familyUser,
  hashToken,
  joinAndApprove,
  makeInvite,
  newUuid,
  requestToJoin,
  rotateKey,
  setFreeForAll,
  startFamilyDb,
  withPlanFeatures,
} from './familyHarness'
import type { FamilyUser, SqlTestDb } from './familyHarness'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startFamilyDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

afterEach(async () => {
  await setFreeForAll(ctx, true)
})

async function myspace(user: FamilyUser): Promise<Record<string, unknown> | null> {
  return expectOk<Record<string, unknown> | null>(await user.rpc('get_my_space'))
}

describe('create_space (criterion 4)', () => {
  it('creates the space with the caller as active owner, key v1 and a created event', async () => {
    const owner = await familyUser(ctx)
    const spaceId = newUuid()
    const publicKey = fakePublicJwk()
    const wrapped = fakeWrappedKey()

    const res = expectOk(
      await owner.rpc('create_space', {
        p_space_id: spaceId,
        p_public_key: publicKey,
        p_wrapped_key_for_self: wrapped,
      }),
    )
    expect(res).toEqual({ space_id: spaceId, key_version: 1 })

    const space = await ctx.admin('select * from public.spaces where id = $1', [spaceId])
    expect(space[0]).toMatchObject({
      owner_id: owner.userId,
      key_version: 1,
      last_seq: 0,
      record_count: 0,
      total_bytes: 0,
    })
    const member = await ctx.admin('select * from public.space_members where space_id = $1', [
      spaceId,
    ])
    expect(member).toHaveLength(1)
    expect(member[0]).toMatchObject({
      user_id: owner.userId,
      role: 'owner',
      status: 'active',
      public_key: publicKey,
    })
    expect(member[0].joined_at).not.toBeNull()
    const keys = await ctx.admin('select * from public.space_keys where space_id = $1', [spaceId])
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      user_id: owner.userId,
      key_version: 1,
      wrapped_key: wrapped,
    })
    expect(await eventsOf(ctx, spaceId)).toEqual([
      { kind: 'created', actor_id: owner.userId, subject_id: null },
    ])
  })

  it('an active owner, an active member and a pending user all get already_in_space', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    for (const user of [space.owner, space.members[0], space.pending[0]]) {
      expectMinima(
        await user.rpc('create_space', {
          p_space_id: newUuid(),
          p_public_key: fakePublicJwk(),
          p_wrapped_key_for_self: fakeWrappedKey(),
        }),
        'already_in_space',
      )
    }
  })

  it('request_join gets already_in_space for an active member, a pending user and the same space', async () => {
    const one = await buildSpace(ctx, { active: 1, pending: 1 })
    const two = await buildSpace(ctx)

    for (const user of [one.members[0], one.pending[0], one.owner]) {
      const invite = await makeInvite(two.owner, two.spaceId)
      expectMinima(
        await user.rpc('request_join', {
          p_invite_id: invite.inviteId,
          p_token: invite.token,
          p_public_key: fakePublicJwk(),
        }),
        'already_in_space',
      )
      // The refused request did not use the invite up.
      const row = await ctx.admin('select used_at from public.space_invites where id = $1', [
        invite.inviteId,
      ])
      expect(row[0].used_at).toBeNull()
    }

    const sameSpaceInvite = await makeInvite(one.owner, one.spaceId)
    expectMinima(
      await one.members[0].rpc('request_join', {
        p_invite_id: sameSpaceInvite.inviteId,
        p_token: sameSpaceInvite.token,
        p_public_key: fakePublicJwk(),
      }),
      'already_in_space',
    )
  })

  it('a user who left can create a space (the old row is gone)', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    expectOk(await space.members[0].rpc('leave_space'))
    await createFamilySpace(space.members[0])
    expect((await myspace(space.members[0]))?.role).toBe('owner')
  })

  it('without the shared_spaces feature it raises sync_not_included and writes nothing', async () => {
    const owner = await familyUser(ctx)
    await setFreeForAll(ctx, false)
    const spaceId = newUuid()
    expectMinima(
      await owner.rpc('create_space', {
        p_space_id: spaceId,
        p_public_key: fakePublicJwk(),
        p_wrapped_key_for_self: fakeWrappedKey(),
      }),
      'sync_not_included',
    )
    const rows = await ctx.admin('select 1 from public.spaces where id = $1', [spaceId])
    expect(rows).toHaveLength(0)
  })

  it('a sync plan without shared_spaces cannot create, a family plan can', async () => {
    const owner = await familyUser(ctx)
    await setFreeForAll(ctx, false)
    await ctx.admin(
      `insert into public.entitlements (user_id, plan_id, status, source)
       values ($1, 'sync', 'active', 'manual')
       on conflict (user_id) do update set plan_id = 'sync', status = 'active'`,
      [owner.userId],
    )
    const args = () => ({
      p_space_id: newUuid(),
      p_public_key: fakePublicJwk(),
      p_wrapped_key_for_self: fakeWrappedKey(),
    })
    expectMinima(await owner.rpc('create_space', args()), 'sync_not_included')

    await ctx.admin("update public.entitlements set plan_id = 'family' where user_id = $1", [
      owner.userId,
    ])
    expectOk(await owner.rpc('create_space', args()))
  })

  it('validates the id, the public key and the wrapped key', async () => {
    const owner = await familyUser(ctx)
    const jwk = fakePublicJwk()
    const call = (over: Record<string, unknown>) =>
      owner.rpc('create_space', {
        p_space_id: newUuid(),
        p_public_key: jwk,
        p_wrapped_key_for_self: fakeWrappedKey(),
        ...over,
      })

    expectMinima(await call({ p_space_id: null }), 'invalid_input')
    expectMinima(await call({ p_public_key: null }), 'invalid_input')
    expectMinima(await call({ p_public_key: { ...jwk, kty: 'RSA' } }), 'invalid_input')
    expectMinima(await call({ p_public_key: { ...jwk, crv: 'P-384' } }), 'invalid_input')
    expectMinima(await call({ p_public_key: { kty: 'EC', crv: 'P-256', x: 'a' } }), 'invalid_input')
    expectMinima(await call({ p_public_key: { ...jwk, x: 5 } }), 'invalid_input')
    // A private key is never accepted.
    expectMinima(await call({ p_public_key: { ...jwk, d: 'c2VjcmV0' } }), 'invalid_input')
    expectMinima(await call({ p_public_key: { ...jwk, pad: 'p'.repeat(2100) } }), 'invalid_input')
    expectMinima(await call({ p_wrapped_key_for_self: null }), 'invalid_input')
    expectMinima(await call({ p_wrapped_key_for_self: { v: 2, epk: {}, iv: 'a', ct: 'b' } }), 'invalid_input')
    expectMinima(await call({ p_wrapped_key_for_self: { v: 1, iv: 'a', ct: 'b' } }), 'invalid_input')
    expectMinima(await call({ p_wrapped_key_for_self: { v: 1, epk: {}, iv: 1, ct: 'b' } }), 'invalid_input')
    expectMinima(await call({ p_wrapped_key_for_self: { v: 1, epk: {}, iv: 'a' } }), 'invalid_input')

    // None of the refused calls left a membership behind.
    expect(await myspace(owner)).toBeNull()
    expectOk(await call({}))
  })

  it('a space id that is already taken is invalid_input', async () => {
    const taken = await buildSpace(ctx)
    const other = await familyUser(ctx)
    expectMinima(
      await other.rpc('create_space', {
        p_space_id: taken.spaceId,
        p_public_key: fakePublicJwk(),
        p_wrapped_key_for_self: fakeWrappedKey(),
      }),
      'invalid_input',
    )
    expect(await myspace(other)).toBeNull()
  })

  it('the database itself allows one pending-or-active membership per user and one owner per space', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const other = await buildSpace(ctx)
    const insert = (spaceId: string, userId: string, role: string) =>
      ctx.admin(
        `insert into public.space_members (space_id, user_id, role, status, public_key)
         values ($1, $2, $3, 'active', $4::jsonb)`,
        [spaceId, userId, role, JSON.stringify(fakePublicJwk())],
      )
    // The member already belongs to a space.
    await expect(insert(other.spaceId, space.members[0].userId, 'member')).rejects.toThrow(
      /unique|duplicate/i,
    )
    // A second owner in the same space.
    const stranger = await familyUser(ctx)
    await expect(insert(space.spaceId, stranger.userId, 'owner')).rejects.toThrow(
      /unique|duplicate/i,
    )
    // A pending owner is impossible.
    await expect(
      ctx.admin(
        `insert into public.space_members (space_id, user_id, role, status, public_key)
         values ($1, $2, 'owner', 'pending', $3::jsonb)`,
        [space.spaceId, stranger.userId, JSON.stringify(fakePublicJwk())],
      ),
    ).rejects.toThrow()
  })
})

describe('invites (criterion 5)', () => {
  it('create_invite returns the id and expiry, and only the hash is stored', async () => {
    const space = await buildSpace(ctx)
    const invite = await makeInvite(space.owner, space.spaceId)

    const rows = await ctx.admin<Record<string, unknown>>(
      'select * from public.space_invites where id = $1',
      [invite.inviteId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(invite.hash)
    expect(rows[0].token_hash).toBe(hashToken(invite.token))
    expect(rows[0].created_by).toBe(space.owner.userId)
    expect(rows[0].used_at).toBeNull()
    expect(rows[0].revoked_at).toBeNull()
    expect(JSON.stringify(rows[0])).not.toContain(invite.token)
    expect(Object.keys(rows[0])).not.toContain('token')
  })

  it('the default expiry is 48 hours and the cap is 168', async () => {
    const space = await buildSpace(ctx)
    const hoursFromNow = (iso: string) => (Date.parse(iso) - Date.now()) / 3_600_000
    const create = async (hours?: number) => {
      return expectOk<{ invite_id: string; expires_at: string }>(
        await space.owner.rpc('create_invite', {
          p_space_id: space.spaceId,
          p_token_hash: hashToken(newUuid()),
          ...(hours === undefined ? {} : { p_expires_in_hours: hours }),
        }),
      )
    }

    const dflt = await create()
    expect(hoursFromNow(dflt.expires_at)).toBeGreaterThan(47.9)
    expect(hoursFromNow(dflt.expires_at)).toBeLessThan(48.1)
    const one = await create(1)
    expect(hoursFromNow(one.expires_at)).toBeGreaterThan(0.9)
    expect(hoursFromNow(one.expires_at)).toBeLessThan(1.1)
    const max = await create(168)
    expect(hoursFromNow(max.expires_at)).toBeGreaterThan(167.9)
    expect(hoursFromNow(max.expires_at)).toBeLessThan(168.1)
  })

  it('refuses a bad hash and an out-of-range expiry', async () => {
    const space = await buildSpace(ctx)
    const call = (hash: unknown, hours?: unknown) =>
      space.owner.rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: hash,
        p_expires_in_hours: hours,
      })
    const good = hashToken('x')

    for (const bad of ['abc', good.toUpperCase(), good.slice(1), `${good}0`, 'g'.repeat(64), null]) {
      expectMinima(await call(bad, 48), 'invalid_input')
    }
    for (const hours of [0, -1, 169, 1000, null]) {
      expectMinima(await call(good, hours), 'invalid_input')
    }
    const rows = await ctx.admin('select 1 from public.space_invites where space_id = $1', [
      space.spaceId,
    ])
    expect(rows).toHaveLength(0)
  })

  it('the sixth open invite fails, and a revoked or used one frees a slot', async () => {
    const space = await buildSpace(ctx)
    const invites = []
    for (let i = 0; i < 5; i++) invites.push(await makeInvite(space.owner, space.spaceId))

    expectMinima(
      await space.owner.rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: hashToken('sixth'),
      }),
      'quota_exceeded',
    )
    const count = await ctx.admin<{ n: number }>(
      'select count(*)::int as n from public.space_invites where space_id = $1',
      [space.spaceId],
    )
    expect(count[0].n).toBe(5)

    // Revoking one frees a slot.
    expectOk(await space.owner.rpc('revoke_invite', { p_invite_id: invites[0].inviteId }))
    await makeInvite(space.owner, space.spaceId)
    expectMinima(
      await space.owner.rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: hashToken('seventh'),
      }),
      'quota_exceeded',
    )

    // So does one that was used.
    const joiner = await familyUser(ctx)
    expectOk(
      await joiner.rpc('request_join', {
        p_invite_id: invites[1].inviteId,
        p_token: invites[1].token,
        p_public_key: fakePublicJwk(),
      }),
    )
    await makeInvite(space.owner, space.spaceId)
  })

  it('an expired invite does not count as open', async () => {
    const space = await buildSpace(ctx)
    const invites = []
    for (let i = 0; i < 5; i++) invites.push(await makeInvite(space.owner, space.spaceId))
    await ctx.admin(
      "update public.space_invites set expires_at = now() - interval '1 minute' where id = $1",
      [invites[0].inviteId],
    )
    await makeInvite(space.owner, space.spaceId)
  })

  it('only the owner creates and revokes invites', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    const outsider = await familyUser(ctx)
    const invite = await makeInvite(space.owner, space.spaceId)

    expectMinima(
      await space.members[0].rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: hashToken('m'),
      }),
      'not_space_owner',
    )
    expectMinima(
      await space.members[0].rpc('revoke_invite', { p_invite_id: invite.inviteId }),
      'not_space_owner',
    )
    for (const user of [outsider, space.pending[0]]) {
      expectMinima(
        await user.rpc('create_invite', {
          p_space_id: space.spaceId,
          p_token_hash: hashToken('o'),
        }),
        'not_space_member',
      )
      expectMinima(
        await user.rpc('revoke_invite', { p_invite_id: invite.inviteId }),
        'not_space_member',
      )
    }
    expectMinima(
      await space.owner.rpc('revoke_invite', { p_invite_id: newUuid() }),
      'invite_invalid',
    )
    // The invite is still open after all the refusals.
    const row = await ctx.admin('select revoked_at from public.space_invites where id = $1', [
      invite.inviteId,
    ])
    expect(row[0].revoked_at).toBeNull()
  })

  it('revoke_invite is idempotent and writes one event', async () => {
    const space = await buildSpace(ctx)
    const invite = await makeInvite(space.owner, space.spaceId)

    const first = expectOk<{ invite_id: string; revoked_at: string }>(
      await space.owner.rpc('revoke_invite', { p_invite_id: invite.inviteId }),
    )
    const second = expectOk<{ invite_id: string; revoked_at: string }>(
      await space.owner.rpc('revoke_invite', { p_invite_id: invite.inviteId }),
    )
    expect(first.invite_id).toBe(invite.inviteId)
    expect(first.revoked_at).not.toBeNull()
    expect(second.revoked_at).toEqual(first.revoked_at)
    expect((await eventKinds(ctx, space.spaceId)).filter((k) => k === 'invite_revoked')).toHaveLength(1)
  })

  it('get_invite shows the owner, the member count and the expiry to any signed-in user', async () => {
    const space = await buildSpace(ctx, { active: 2, pending: 1 })
    const invite = await makeInvite(space.owner, space.spaceId)
    const visitor = await familyUser(ctx)

    const info = expectOk<Record<string, unknown>>(
      await visitor.rpc('get_invite', { p_invite_id: invite.inviteId, p_token: invite.token }),
    )
    expect(info).toMatchObject({
      space_id: space.spaceId,
      owner_email: space.owner.email,
      members_count: 3,
    })
    expect(Date.parse(info.expires_at as string)).toBeGreaterThan(Date.now())
    expect(Object.keys(info).sort()).toEqual(['expires_at', 'members_count', 'owner_email', 'space_id'])
    // Looking at an invite does not use it up.
    const row = await ctx.admin('select used_at from public.space_invites where id = $1', [
      invite.inviteId,
    ])
    expect(row[0].used_at).toBeNull()
  })

  describe('invite_invalid is one answer for every reason', () => {
    async function brokenInvites() {
      const space = await buildSpace(ctx)
      const cases: Record<string, { id: string; token: string }> = {}

      const expired = await makeInvite(space.owner, space.spaceId)
      await ctx.admin(
        "update public.space_invites set expires_at = now() - interval '1 minute' where id = $1",
        [expired.inviteId],
      )
      cases.expired = { id: expired.inviteId, token: expired.token }

      const used = await makeInvite(space.owner, space.spaceId)
      const taker = await familyUser(ctx)
      expectOk(
        await taker.rpc('request_join', {
          p_invite_id: used.inviteId,
          p_token: used.token,
          p_public_key: fakePublicJwk(),
        }),
      )
      cases.used = { id: used.inviteId, token: used.token }

      const revoked = await makeInvite(space.owner, space.spaceId)
      expectOk(await space.owner.rpc('revoke_invite', { p_invite_id: revoked.inviteId }))
      cases.revoked = { id: revoked.inviteId, token: revoked.token }

      cases.unknown = { id: newUuid(), token: expired.token }

      const open = await makeInvite(space.owner, space.spaceId)
      cases['wrong token'] = { id: open.inviteId, token: open.token.slice(1) + 'x' }
      cases['empty token'] = { id: open.inviteId, token: '' }
      // The hash is not the token.
      cases['hash as token'] = { id: open.inviteId, token: open.hash }
      return { cases, open }
    }

    it('get_invite and request_join return the same error for all of them', async () => {
      const { cases, open } = await brokenInvites()
      const visitor = await familyUser(ctx)
      const messages = new Set<string>()

      expect(Object.keys(cases)).toHaveLength(7)
      for (const c of Object.values(cases)) {
        const info = await visitor.rpc('get_invite', { p_invite_id: c.id, p_token: c.token })
        expectMinima(info, 'invite_invalid')
        messages.add(`${info.error?.message}|${info.error?.details ?? ''}|${info.error?.code}`)

        const join = await visitor.rpc('request_join', {
          p_invite_id: c.id,
          p_token: c.token,
          p_public_key: fakePublicJwk(),
        })
        expectMinima(join, 'invite_invalid')
        messages.add(`${join.error?.message}|${join.error?.details ?? ''}|${join.error?.code}`)
      }
      expect(messages.size).toBe(1)

      // None of the refused attempts changed anything: the open invite works.
      expectOk(
        await visitor.rpc('request_join', {
          p_invite_id: open.inviteId,
          p_token: open.token,
          p_public_key: fakePublicJwk(),
        }),
      )
    })

    it('a null token is invite_invalid too', async () => {
      const space = await buildSpace(ctx)
      const invite = await makeInvite(space.owner, space.spaceId)
      const visitor = await familyUser(ctx)
      expectMinima(
        await visitor.rpc('get_invite', { p_invite_id: invite.inviteId, p_token: null }),
        'invite_invalid',
      )
      expectMinima(
        await visitor.rpc('request_join', {
          p_invite_id: invite.inviteId,
          p_token: null,
          p_public_key: fakePublicJwk(),
        }),
        'invite_invalid',
      )
    })
  })

  it('an invite works once, even after the request is rejected', async () => {
    const space = await buildSpace(ctx)
    const first = await familyUser(ctx)
    const second = await familyUser(ctx)
    const join = await requestToJoin(space.owner, space.spaceId, first)

    const row = await ctx.admin<{ used_by: string; used_at: string | null }>(
      'select used_by, used_at from public.space_invites where id = $1',
      [join.inviteId],
    )
    expect(row[0].used_by).toBe(first.userId)
    expect(row[0].used_at).not.toBeNull()

    expectOk(
      await space.owner.rpc('reject_member', { p_space_id: space.spaceId, p_user_id: first.userId }),
    )
    const retry = (user: FamilyUser) =>
      user.rpc('request_join', {
        p_invite_id: join.inviteId,
        p_token: join.token,
        p_public_key: fakePublicJwk(),
      })
    expectMinima(await retry(second), 'invite_invalid')
    // The rejected user cannot reuse it either.
    expectMinima(await retry(first), 'invite_invalid')
    expect(await myspace(first)).toBeNull()
  })

  it('request_join validates the public key and does not use the invite up when it fails', async () => {
    const space = await buildSpace(ctx)
    const invite = await makeInvite(space.owner, space.spaceId)
    const joiner = await familyUser(ctx)
    const join = (key: unknown) =>
      joiner.rpc('request_join', {
        p_invite_id: invite.inviteId,
        p_token: invite.token,
        p_public_key: key,
      })

    expectMinima(await join({ kty: 'EC', crv: 'P-256' }), 'invalid_input')
    expectMinima(await join({ ...fakePublicJwk(), d: 'c2VjcmV0' }), 'invalid_input')
    expectMinima(await join(null), 'invalid_input')
    expect(await myspace(joiner)).toBeNull()

    const ok = expectOk(await join(fakePublicJwk()))
    expect(ok).toEqual({ space_id: space.spaceId, status: 'pending' })
  })
})

describe('join and approval (criterion 6)', () => {
  it('a pending user sees only their own pending status', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    const view = await myspace(space.pending[0])
    expect(view).toEqual({
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
    expect(JSON.stringify(view)).not.toContain(space.owner.email)
  })

  it('request_join records the member, the invite and the event', async () => {
    const space = await buildSpace(ctx)
    const joiner = await familyUser(ctx)
    const join = await requestToJoin(space.owner, space.spaceId, joiner)

    const rows = await ctx.admin(
      'select * from public.space_members where space_id = $1 and user_id = $2',
      [space.spaceId, joiner.userId],
    )
    expect(rows[0]).toMatchObject({
      role: 'member',
      status: 'pending',
      invite_id: join.inviteId,
      public_key: join.publicKey,
      joined_at: null,
    })
    const keys = await ctx.admin('select 1 from public.space_keys where user_id = $1', [
      joiner.userId,
    ])
    expect(keys).toHaveLength(0)
    expect(await eventKinds(ctx, space.spaceId)).toEqual([
      'created',
      'invite_created',
      'join_requested',
    ])
  })

  it('approve_member activates the member and stores their wrapped key', async () => {
    const space = await buildSpace(ctx, { pending: 1 })
    const wrapped = fakeWrappedKey()
    const res = expectOk(
      await space.owner.rpc('approve_member', {
        p_space_id: space.spaceId,
        p_user_id: space.pending[0].userId,
        p_key_version: 1,
        p_wrapped_key: wrapped,
      }),
    )
    expect(res).toEqual({ user_id: space.pending[0].userId, status: 'active', key_version: 1 })

    const view = await myspace(space.pending[0])
    expect(view?.status).toBe('active')
    expect(view?.my_keys).toEqual([{ key_version: 1, wrapped_key: wrapped }])
    const events = await eventsOf(ctx, space.spaceId)
    expect(events.at(-1)).toEqual({
      kind: 'approved',
      actor_id: space.owner.userId,
      subject_id: space.pending[0].userId,
    })
    const row = await ctx.admin('select joined_at from public.space_members where user_id = $1', [
      space.pending[0].userId,
    ])
    expect(row[0].joined_at).not.toBeNull()
  })

  it('approve_member with a key_version other than the space version is wrong_key_version', async () => {
    const space = await buildSpace(ctx, { pending: 1 })
    const target = space.pending[0]
    for (const version of [0, 2, 5]) {
      expectMinima(
        await space.owner.rpc('approve_member', {
          p_space_id: space.spaceId,
          p_user_id: target.userId,
          p_key_version: version,
          p_wrapped_key: fakeWrappedKey(),
        }),
        'wrong_key_version',
      )
    }
    expect((await myspace(target))?.status).toBe('pending')
    await approveMember(space.owner, space.spaceId, target)
    expect((await myspace(target))?.status).toBe('active')
  })

  it('approve_member validates its input and its target', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    const call = (userId: string, version: unknown, wrapped: unknown) =>
      space.owner.rpc('approve_member', {
        p_space_id: space.spaceId,
        p_user_id: userId,
        p_key_version: version,
        p_wrapped_key: wrapped,
      })
    const target = space.pending[0].userId

    expectMinima(await call(target, null, fakeWrappedKey()), 'invalid_input')
    expectMinima(await call(target, 1, null), 'invalid_input')
    expectMinima(await call(target, 1, { v: 1, iv: 'a', ct: 'b' }), 'invalid_input')
    // The target must be pending in this space.
    expectMinima(await call(space.members[0].userId, 1, fakeWrappedKey()), 'not_space_member')
    expectMinima(await call(newUuid(), 1, fakeWrappedKey()), 'not_space_member')
    expect((await myspace(space.pending[0]))?.status).toBe('pending')
  })

  it('the member limit is enforced at request_join, counting active and pending', async () => {
    const space = await buildSpace(ctx, { active: 2, pending: 2 })
    // 1 owner + 2 active + 2 pending = 5: one more fits.
    const last = await familyUser(ctx)
    await requestToJoin(space.owner, space.spaceId, last)

    const extra = await familyUser(ctx)
    const invite = await makeInvite(space.owner, space.spaceId)
    expectMinima(
      await extra.rpc('request_join', {
        p_invite_id: invite.inviteId,
        p_token: invite.token,
        p_public_key: fakePublicJwk(),
      }),
      'member_limit',
    )
    expect(await myspace(extra)).toBeNull()
    const row = await ctx.admin('select used_at from public.space_invites where id = $1', [
      invite.inviteId,
    ])
    expect(row[0].used_at).toBeNull()
  })

  it('with 6 active members the next request is member_limit', async () => {
    const space = await buildSpace(ctx, { active: 5 })
    const extra = await familyUser(ctx)
    const invite = await makeInvite(space.owner, space.spaceId)
    expectMinima(
      await extra.rpc('request_join', {
        p_invite_id: invite.inviteId,
        p_token: invite.token,
        p_public_key: fakePublicJwk(),
      }),
      'member_limit',
    )
  })

  it('the limit comes from the owner plan and is re-checked at approve_member', async () => {
    const space = await buildSpace(ctx, { pending: 2 })
    await withPlanFeatures(ctx, 'beta', { max_members: 2 }, async () => {
      // 1 active + 2 pending is already above 2: new requests are refused.
      const late = await familyUser(ctx)
      const invite = await makeInvite(space.owner, space.spaceId)
      expectMinima(
        await late.rpc('request_join', {
          p_invite_id: invite.inviteId,
          p_token: invite.token,
          p_public_key: fakePublicJwk(),
        }),
        'member_limit',
      )

      await approveMember(space.owner, space.spaceId, space.pending[0])
      expectMinima(
        await space.owner.rpc('approve_member', {
          p_space_id: space.spaceId,
          p_user_id: space.pending[1].userId,
          p_key_version: 1,
          p_wrapped_key: fakeWrappedKey(),
        }),
        'member_limit',
      )
      expect((await myspace(space.pending[1]))?.status).toBe('pending')
    })

    // With the normal limit of 6 the same approval works.
    await approveMember(space.owner, space.spaceId, space.pending[1])
    expect((await myspace(space.pending[1]))?.status).toBe('active')
  })
})

describe('roles (criterion 8)', () => {
  it('an active member gets not_space_owner on every owner action', async () => {
    const space = await buildSpace(ctx, { active: 2, pending: 1 })
    const member = space.members[0]
    const pendingId = space.pending[0].userId
    const base = { p_space_id: space.spaceId }

    const results = [
      await member.rpc('approve_member', {
        ...base,
        p_user_id: pendingId,
        p_key_version: 1,
        p_wrapped_key: fakeWrappedKey(),
      }),
      await member.rpc('reject_member', { ...base, p_user_id: pendingId }),
      await member.rpc('remove_member', { ...base, p_user_id: space.members[1].userId }),
      await member.rpc('rotate_space_key', { ...base, p_new_version: 2, p_wraps: [] }),
      await member.rpc('transfer_ownership', { ...base, p_user_id: member.userId }),
      await member.rpc('delete_space', base),
    ]
    for (const res of results) expectMinima(res, 'not_space_owner')

    // Nothing changed.
    expect((await myspace(space.pending[0]))?.status).toBe('pending')
    expect((await myspace(space.members[1]))?.status).toBe('active')
    expect((await myspace(space.owner))?.role).toBe('owner')
    expect((await myspace(space.owner))?.key_version).toBe(1)
  })

  it('the owner cannot remove themselves or leave', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    expectMinima(
      await space.owner.rpc('remove_member', {
        p_space_id: space.spaceId,
        p_user_id: space.owner.userId,
      }),
      'cannot_remove_owner',
    )
    expectMinima(await space.owner.rpc('leave_space'), 'owner_must_transfer_or_delete')
    expect((await myspace(space.owner))?.role).toBe('owner')
  })

  it('after transfer_ownership the old owner can leave and the new owner has the powers', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    const [b, c] = space.members

    const res = expectOk(
      await space.owner.rpc('transfer_ownership', {
        p_space_id: space.spaceId,
        p_user_id: b.userId,
      }),
    )
    expect(res).toEqual({ space_id: space.spaceId, owner_id: b.userId })

    expect((await myspace(space.owner))?.role).toBe('member')
    expect((await myspace(b))?.role).toBe('owner')
    const owner = await ctx.admin<{ owner_id: string }>(
      'select owner_id from public.spaces where id = $1',
      [space.spaceId],
    )
    expect(owner[0].owner_id).toBe(b.userId)

    // The old owner is now an ordinary member.
    expectMinima(
      await space.owner.rpc('remove_member', { p_space_id: space.spaceId, p_user_id: c.userId }),
      'not_space_owner',
    )
    // The new owner has the powers.
    await makeInvite(b, space.spaceId)

    expect(expectOk(await space.owner.rpc('leave_space'))).toEqual({ space_id: space.spaceId })
    expect(await myspace(space.owner)).toBeNull()
    const events = await eventsOf(ctx, space.spaceId)
    expect(events.find((e) => e.kind === 'ownership_transferred')).toEqual({
      kind: 'ownership_transferred',
      actor_id: space.owner.userId,
      subject_id: b.userId,
    })
  })

  it('transferring back and forth always leaves exactly one owner', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    expectOk(
      await space.owner.rpc('transfer_ownership', {
        p_space_id: space.spaceId,
        p_user_id: space.members[0].userId,
      }),
    )
    expectOk(
      await space.members[0].rpc('transfer_ownership', {
        p_space_id: space.spaceId,
        p_user_id: space.owner.userId,
      }),
    )
    const owners = await ctx.admin<{ user_id: string }>(
      "select user_id from public.space_members where space_id = $1 and role = 'owner'",
      [space.spaceId],
    )
    expect(owners).toEqual([{ user_id: space.owner.userId }])
  })

  it('transfer to a pending user, an outsider or oneself fails', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    const outsider = await familyUser(ctx)
    const transfer = (userId: string) =>
      space.owner.rpc('transfer_ownership', { p_space_id: space.spaceId, p_user_id: userId })

    expectMinima(await transfer(space.pending[0].userId), 'not_space_member')
    expectMinima(await transfer(outsider.userId), 'not_space_member')
    expectMinima(await transfer(newUuid()), 'not_space_member')
    expectMinima(await transfer(space.owner.userId), 'invalid_input')
    expect((await myspace(space.owner))?.role).toBe('owner')
  })

  it('leave_space removes the row and the keys and writes a left event', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    const leaver = space.members[0]
    expect(expectOk(await leaver.rpc('leave_space'))).toEqual({ space_id: space.spaceId })

    expect(await myspace(leaver)).toBeNull()
    const keys = await ctx.admin('select 1 from public.space_keys where user_id = $1', [
      leaver.userId,
    ])
    expect(keys).toHaveLength(0)
    expect((await myspace(space.members[1]))?.status).toBe('active')
    expect((await eventsOf(ctx, space.spaceId)).at(-1)).toMatchObject({
      kind: 'left',
      actor_id: leaver.userId,
    })
    // The user is free again: leaving twice is not_space_member.
    expectMinima(await leaver.rpc('leave_space'), 'not_space_member')
  })

  it('a pending user can withdraw with leave_space', async () => {
    const space = await buildSpace(ctx, { pending: 1 })
    expectOk(await space.pending[0].rpc('leave_space'))
    expect(await myspace(space.pending[0])).toBeNull()
    expect((await eventsOf(ctx, space.spaceId)).at(-1)?.kind).toBe('left')
  })

  it('reject_member deletes the pending row and writes a rejected event', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    const res = expectOk(
      await space.owner.rpc('reject_member', {
        p_space_id: space.spaceId,
        p_user_id: space.pending[0].userId,
      }),
    )
    expect(res).toEqual({ user_id: space.pending[0].userId })
    expect(await myspace(space.pending[0])).toBeNull()
    expect((await eventsOf(ctx, space.spaceId)).at(-1)).toEqual({
      kind: 'rejected',
      actor_id: space.owner.userId,
      subject_id: space.pending[0].userId,
    })
    // Only a pending user can be rejected.
    expectMinima(
      await space.owner.rpc('reject_member', {
        p_space_id: space.spaceId,
        p_user_id: space.members[0].userId,
      }),
      'not_space_member',
    )
    expect((await myspace(space.members[0]))?.status).toBe('active')
  })

  it('remove_member deletes an active or a pending member and their keys', async () => {
    const space = await buildSpace(ctx, { active: 2, pending: 1 })
    const remove = (userId: string) =>
      space.owner.rpc('remove_member', { p_space_id: space.spaceId, p_user_id: userId })

    expect(expectOk(await remove(space.members[0].userId))).toEqual({
      user_id: space.members[0].userId,
    })
    expectOk(await remove(space.pending[0].userId))
    expect(await myspace(space.members[0])).toBeNull()
    expect(await myspace(space.pending[0])).toBeNull()
    const keys = await ctx.admin('select 1 from public.space_keys where user_id = $1', [
      space.members[0].userId,
    ])
    expect(keys).toHaveLength(0)
    // The other member keeps theirs.
    const kept = await ctx.admin('select 1 from public.space_keys where user_id = $1', [
      space.members[1].userId,
    ])
    expect(kept).toHaveLength(1)

    expectMinima(await remove(space.members[0].userId), 'not_space_member')
    expectMinima(await remove(newUuid()), 'not_space_member')
    const removed = (await eventsOf(ctx, space.spaceId)).filter((e) => e.kind === 'removed')
    expect(removed.map((e) => e.subject_id)).toEqual([
      space.members[0].userId,
      space.pending[0].userId,
    ])
  })

  it('a removed user can join another space', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const other = await buildSpace(ctx)
    expectOk(
      await space.owner.rpc('remove_member', {
        p_space_id: space.spaceId,
        p_user_id: space.members[0].userId,
      }),
    )
    await joinAndApprove(other.owner, other.spaceId, space.members[0])
    expect((await myspace(space.members[0]))?.space_id).toBe(other.spaceId)
  })
})

describe('events', () => {
  it('every action writes its event, in order, with actor and subject', async () => {
    const owner = await familyUser(ctx)
    const b = await familyUser(ctx)
    const c = await familyUser(ctx)
    const d = await familyUser(ctx)
    const spaceId = await createFamilySpace(owner)

    const bJoin = await requestToJoin(owner, spaceId, b)
    await approveMember(owner, spaceId, b)
    const cJoin = await requestToJoin(owner, spaceId, c)
    expectOk(await owner.rpc('reject_member', { p_space_id: spaceId, p_user_id: c.userId }))
    const dJoin = await requestToJoin(owner, spaceId, d)
    await approveMember(owner, spaceId, d)
    expectOk(await owner.rpc('revoke_invite', { p_invite_id: bJoin.inviteId }))
    expectOk(await owner.rpc('remove_member', { p_space_id: spaceId, p_user_id: d.userId }))
    expectOk(await rotateKey(owner, spaceId, 2, [owner.userId, b.userId]))
    expectOk(
      await owner.rpc('transfer_ownership', { p_space_id: spaceId, p_user_id: b.userId }),
    )
    expectOk(await owner.rpc('leave_space'))

    const events = await eventsOf(ctx, spaceId)
    expect(events.map((e) => e.kind)).toEqual([
      'created',
      'invite_created',
      'join_requested',
      'approved',
      'invite_created',
      'join_requested',
      'rejected',
      'invite_created',
      'join_requested',
      'approved',
      'invite_revoked',
      'removed',
      'key_rotated',
      'ownership_transferred',
      'left',
    ])
    expect(events[2]).toMatchObject({ actor_id: b.userId })
    expect(events[3]).toEqual({ kind: 'approved', actor_id: owner.userId, subject_id: b.userId })
    expect(events[6]).toEqual({ kind: 'rejected', actor_id: owner.userId, subject_id: c.userId })
    expect(events[11]).toEqual({ kind: 'removed', actor_id: owner.userId, subject_id: d.userId })
    expect(events[12]).toMatchObject({ actor_id: owner.userId })
    expect(events[14]).toMatchObject({ actor_id: owner.userId })
    expect(cJoin.inviteId).not.toBe(dJoin.inviteId)
  })

  it('refused calls write no events', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const before = await eventsOf(ctx, space.spaceId)
    expectMinima(
      await space.members[0].rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: hashToken('nope'),
      }),
      'not_space_owner',
    )
    expectMinima(await space.owner.rpc('leave_space'), 'owner_must_transfer_or_delete')
    expect(await eventsOf(ctx, space.spaceId)).toEqual(before)
  })
})
