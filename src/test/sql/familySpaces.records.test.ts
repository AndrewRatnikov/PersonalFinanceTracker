// @vitest-environment node
// No CONTRACT_GAPs: push / pull / rotate semantics, check order and the
// MINIMA:key_outdated:<n> message come from plan section B6 and decision D4.
// The last_seq of a pull page that has more rows is not asserted (the plan
// only pins it on the final page).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  buildSpace,
  countRows,
  createFamilySpace,
  eventKinds,
  expectKeyOutdated,
  expectMinima,
  expectOk,
  fakeWrappedKey,
  familyUser,
  grantPlan,
  hashToken,
  joinAndApprove,
  makeInvite,
  newDeviceId,
  pullSpace,
  pushSpace,
  requestToJoin,
  rotateKey,
  setFreeForAll,
  spaceRecord,
  startFamilyDb,
  withPlanFeatures,
} from './familyHarness'
import type { FamilyUser, PullOutcome, PushOutcome, SqlTestDb } from './familyHarness'

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

async function push(
  user: FamilyUser,
  spaceId: string,
  records: Array<unknown>,
  keyVersion = 1,
): Promise<PushOutcome> {
  return expectOk<PushOutcome>(await pushSpace(user, spaceId, records, keyVersion))
}

async function pull(
  user: FamilyUser,
  spaceId: string,
  since = 0,
  limit?: number,
): Promise<PullOutcome> {
  return expectOk<PullOutcome>(await pullSpace(user, spaceId, since, limit))
}

async function keyVersionsOf(user: FamilyUser): Promise<Array<number>> {
  const view = expectOk<{ my_keys: Array<{ key_version: number }> }>(await user.rpc('get_my_space'))
  return view.my_keys.map((k) => k.key_version)
}

describe('push_space_records and seq (criterion 10)', () => {
  it('returns accepted results with strictly increasing seq per space', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const first = await push(space.owner, space.spaceId, [
      spaceRecord(1),
      spaceRecord(2),
      spaceRecord(3),
    ])
    expect(first.results).toEqual([
      { record_key: spaceRecord(1).record_key, status: 'accepted', seq: 1 },
      { record_key: spaceRecord(2).record_key, status: 'accepted', seq: 2 },
      { record_key: spaceRecord(3).record_key, status: 'accepted', seq: 3 },
    ])
    expect(first.last_seq).toBe(3)

    // Another member continues the same counter.
    const second = await push(space.members[0], space.spaceId, [spaceRecord(4)])
    expect(second.results[0]).toMatchObject({ status: 'accepted', seq: 4 })
    expect(second.last_seq).toBe(4)

    // An edit gets a new, higher seq.
    const edit = await push(space.owner, space.spaceId, [spaceRecord(1, 2000, 24, 'z')])
    expect(edit.results[0]).toMatchObject({ status: 'accepted', seq: 5 })
    expect(edit.last_seq).toBe(5)
  })

  it('every space has its own counter', async () => {
    const one = await buildSpace(ctx)
    const two = await buildSpace(ctx)
    await push(one.owner, one.spaceId, [spaceRecord(1), spaceRecord(2), spaceRecord(3)])
    const res = await push(two.owner, two.spaceId, [spaceRecord(1)])
    expect(res.results[0]).toMatchObject({ status: 'accepted', seq: 1 })
    expect(res.last_seq).toBe(1)
  })

  it('an empty batch is accepted and returns the current last_seq', async () => {
    const space = await buildSpace(ctx)
    await push(space.owner, space.spaceId, [spaceRecord(1), spaceRecord(2)])
    expect(await push(space.owner, space.spaceId, [])).toEqual({ results: [], last_seq: 2 })
  })

  it('seq follows the request order inside a batch', async () => {
    const space = await buildSpace(ctx)
    const res = await push(space.owner, space.spaceId, [spaceRecord(9), spaceRecord(3), spaceRecord(6)])
    expect(res.results.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(res.results.map((r) => r.record_key)).toEqual([
      spaceRecord(9).record_key,
      spaceRecord(3).record_key,
      spaceRecord(6).record_key,
    ])
  })

  it('an older or equal updated_at_ms is stale and returns the stored row', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    await push(space.owner, space.spaceId, [spaceRecord(1, 1000, 24, 'a')])

    for (const ms of [500, 1000]) {
      const res = await push(space.members[0], space.spaceId, [spaceRecord(1, ms, 30, 'b')])
      expect(res.results[0]).toEqual({
        record_key: spaceRecord(1).record_key,
        status: 'stale',
        current: {
          record_key: spaceRecord(1).record_key,
          ciphertext: 'a'.repeat(24),
          iv: spaceRecord(1).iv,
          enc_v: 1,
          updated_at_ms: 1000,
          key_version: 1,
          author_id: space.owner.userId,
          device_id: space.owner.deviceId,
          seq: 1,
        },
      })
      // A stale write consumes no seq.
      expect(res.last_seq).toBe(1)
    }
    const newer = await push(space.members[0], space.spaceId, [spaceRecord(1, 1001, 30, 'b')])
    expect(newer.results[0]).toMatchObject({ status: 'accepted', seq: 2 })

    const rows = (await pull(space.owner, space.spaceId)).records
    expect(rows).toHaveLength(1)
    expect(rows[0].ciphertext).toBe('b'.repeat(30))
  })

  it('a mixed batch reports each record on its own', async () => {
    const space = await buildSpace(ctx)
    await push(space.owner, space.spaceId, [spaceRecord(1, 1000)])
    const res = await push(space.owner, space.spaceId, [spaceRecord(1, 900), spaceRecord(2, 100)])
    expect(res.results.map((r) => r.status)).toEqual(['stale', 'accepted'])
    expect(res.results[1].seq).toBe(2)
  })

  it('author_id and device_id are the caller, and an edit changes them', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    const [b, c] = space.members
    await push(space.owner, space.spaceId, [spaceRecord(1, 1000)])
    await push(b, space.spaceId, [spaceRecord(2, 1000)])
    await push(c, space.spaceId, [spaceRecord(1, 2000)])

    const rows = (await pull(space.owner, space.spaceId)).records
    const byKey = new Map(rows.map((r) => [r.record_key, r]))
    expect(byKey.get(spaceRecord(2).record_key)).toMatchObject({
      author_id: b.userId,
      device_id: b.deviceId,
    })
    expect(byKey.get(spaceRecord(1).record_key)).toMatchObject({
      author_id: c.userId,
      device_id: c.deviceId,
    })
  })

  it('refuses a batch of more than 500 records and accepts exactly 500', async () => {
    const space = await buildSpace(ctx)
    const many = (n: number) => Array.from({ length: n }, (_, i) => spaceRecord(i + 1, 1000, 4))
    expectMinima(await pushSpace(space.owner, space.spaceId, many(501)), 'batch_too_large')
    expect((await pull(space.owner, space.spaceId)).records).toHaveLength(0)
    const ok = await push(space.owner, space.spaceId, many(500))
    expect(ok.results).toHaveLength(500)
    expect(ok.last_seq).toBe(500)
  })

  it('refuses more than 1,048,576 ciphertext characters in a batch', async () => {
    const space = await buildSpace(ctx)
    const big = (n: number) =>
      Array.from({ length: n }, (_, i) => spaceRecord(i + 1, 1000, 65536))
    expectMinima(await pushSpace(space.owner, space.spaceId, big(17)), 'batch_too_large')
    expect((await pull(space.owner, space.spaceId)).records).toHaveLength(0)
    // 16 x 65,536 is exactly the limit.
    const ok = await push(space.owner, space.spaceId, big(16))
    expect(ok.results).toHaveLength(16)
  })

  it('validates every record like run 2 and writes nothing when one is bad', async () => {
    const space = await buildSpace(ctx)
    const good = spaceRecord(1)
    const bad: Array<Record<string, unknown>> = [
      { ...spaceRecord(2), record_key: 'short' },
      { ...spaceRecord(2), record_key: 'k'.repeat(129) },
      { ...spaceRecord(2), record_key: 'has space in the key!' },
      { ...spaceRecord(2), ciphertext: '' },
      { ...spaceRecord(2), ciphertext: 'c'.repeat(65537) },
      { ...spaceRecord(2), iv: '' },
      { ...spaceRecord(2), iv: 'i'.repeat(33) },
      { ...spaceRecord(2), enc_v: 2 },
      { ...spaceRecord(2), enc_v: '1' },
      { ...spaceRecord(2), updated_at_ms: -1 },
      { ...spaceRecord(2), updated_at_ms: 1.5 },
      { ...spaceRecord(2), updated_at_ms: 9007199254740992 },
    ]
    for (const record of bad) {
      expectMinima(await pushSpace(space.owner, space.spaceId, [good, record]), 'invalid_input')
    }
    expectMinima(await pushSpace(space.owner, space.spaceId, [good, good]), 'invalid_input')
    expectMinima(
      await space.owner.rpc('push_space_records', {
        p_space_id: space.spaceId,
        p_device_id: space.owner.deviceId,
        p_key_version: 1,
        p_records: {},
      }),
      'invalid_input',
    )
    expectMinima(
      await space.owner.rpc('push_space_records', {
        p_space_id: space.spaceId,
        p_device_id: space.owner.deviceId,
        p_key_version: null,
        p_records: [good],
      }),
      'invalid_input',
    )
    expect((await pull(space.owner, space.spaceId)).records).toEqual([])

    // The boundary values themselves are fine.
    const edge = await push(space.owner, space.spaceId, [
      { ...spaceRecord(3), updated_at_ms: 0 },
      { ...spaceRecord(4), updated_at_ms: 9007199254740991 },
      { ...spaceRecord(5), record_key: 'k'.repeat(128) },
      { ...spaceRecord(6), record_key: 'k'.repeat(16) },
      { ...spaceRecord(7), ciphertext: 'c'.repeat(65536), iv: 'i'.repeat(32) },
    ])
    expect(edge.results.every((r) => r.status === 'accepted')).toBe(true)
  })

  it('space totals follow the pushes', async () => {
    const space = await buildSpace(ctx)
    await push(space.owner, space.spaceId, [
      spaceRecord(1, 1000, 10),
      spaceRecord(2, 1000, 20),
      spaceRecord(3, 1000, 30),
    ])
    const get = async () =>
      expectOk<{ last_seq: number; record_count: number; total_bytes: number }>(
        await space.owner.rpc('get_my_space'),
      )
    expect(await get()).toMatchObject({ last_seq: 3, record_count: 3, total_bytes: 60 })

    // Replacing a record changes the bytes, not the count.
    await push(space.owner, space.spaceId, [spaceRecord(1, 2000, 50)])
    expect(await get()).toMatchObject({ last_seq: 4, record_count: 3, total_bytes: 100 })
    // A stale write changes nothing.
    await push(space.owner, space.spaceId, [spaceRecord(1, 5, 7)])
    expect(await get()).toMatchObject({ last_seq: 4, record_count: 3, total_bytes: 100 })
  })
})

describe('pull_space_records', () => {
  it('pages by seq with has_more, and the final page reports the last seq', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    await push(
      space.owner,
      space.spaceId,
      [1, 2, 3, 4, 5].map((n) => spaceRecord(n)),
    )

    const seen: Array<number> = []
    let since = 0
    let pages = 0
    for (;;) {
      const page = await pull(space.members[0], space.spaceId, since, 2)
      pages += 1
      expect(page.records.length).toBeLessThanOrEqual(2)
      expect(page.key_version).toBe(1)
      for (const r of page.records) seen.push(r.seq)
      if (!page.has_more) {
        expect(page.last_seq).toBe(5)
        break
      }
      expect(page.records).toHaveLength(2)
      since = page.records[1].seq
    }
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(pages).toBe(3)
  })

  it('returns only rows after `since`, with every field', async () => {
    const space = await buildSpace(ctx)
    await push(space.owner, space.spaceId, [spaceRecord(1), spaceRecord(2), spaceRecord(3)])
    const page = await pull(space.owner, space.spaceId, 1)
    expect(page.records.map((r) => r.seq)).toEqual([2, 3])
    expect(page.has_more).toBe(false)
    expect(page.records[0]).toEqual({
      record_key: spaceRecord(2).record_key,
      ciphertext: spaceRecord(2).ciphertext,
      iv: spaceRecord(2).iv,
      enc_v: 1,
      updated_at_ms: 1000,
      key_version: 1,
      author_id: space.owner.userId,
      device_id: space.owner.deviceId,
      seq: 2,
    })
    expect((await pull(space.owner, space.spaceId, 3)).records).toEqual([])
  })

  it('defaults to 500 rows per page', async () => {
    const space = await buildSpace(ctx)
    const all = Array.from({ length: 501 }, (_, i) => spaceRecord(i + 1, 1000, 4))
    await push(space.owner, space.spaceId, all.slice(0, 500))
    await push(space.owner, space.spaceId, all.slice(500))

    const first = await pull(space.owner, space.spaceId, 0)
    expect(first.records).toHaveLength(500)
    expect(first.has_more).toBe(true)
    const rest = await pull(space.owner, space.spaceId, 500)
    expect(rest.records.map((r) => r.seq)).toEqual([501])
    expect(rest.has_more).toBe(false)
    expect(rest.last_seq).toBe(501)
  })

  it('accepts limits 1 to 1000 and refuses others', async () => {
    const space = await buildSpace(ctx)
    await push(space.owner, space.spaceId, [spaceRecord(1), spaceRecord(2)])
    expect((await pull(space.owner, space.spaceId, 0, 1)).records).toHaveLength(1)
    expect((await pull(space.owner, space.spaceId, 0, 1000)).records).toHaveLength(2)
    for (const limit of [0, -1, 1001, null]) {
      expectMinima(
        await space.owner.rpc('pull_space_records', {
          p_space_id: space.spaceId,
          p_device_id: space.owner.deviceId,
          p_since: 0,
          p_limit: limit,
        }),
        'invalid_input',
      )
    }
    for (const since of [-1, null]) {
      expectMinima(
        await space.owner.rpc('pull_space_records', {
          p_space_id: space.spaceId,
          p_device_id: space.owner.deviceId,
          p_since: since,
        }),
        'invalid_input',
      )
    }
  })

  it('every active member sees the same rows', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    await push(space.members[0], space.spaceId, [spaceRecord(1), spaceRecord(2)])
    const views = await Promise.all(
      [space.owner, ...space.members].map((u) => pull(u, space.spaceId)),
    )
    expect(views[1]).toEqual(views[0])
    expect(views[2]).toEqual(views[0])
    expect(views[0].records).toHaveLength(2)
  })
})

describe('devices', () => {
  it('push and pull need a registered, non-removed device of the caller', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const member = space.members[0]
    const stranger = newDeviceId()

    expectMinima(
      await pushSpace(member, space.spaceId, [spaceRecord(1)], 1, stranger),
      'device_not_registered',
    )
    expectMinima(await pullSpace(member, space.spaceId, 0, undefined, stranger), 'device_not_registered')
    // Another user's device is not the caller's device.
    expectMinima(
      await pushSpace(member, space.spaceId, [spaceRecord(1)], 1, space.owner.deviceId),
      'device_not_registered',
    )

    expectOk(await member.rpc('remove_device', { p_device_id: member.deviceId }))
    expectMinima(await pushSpace(member, space.spaceId, [spaceRecord(1)]), 'device_removed')
    expectMinima(await pullSpace(member, space.spaceId), 'device_removed')
    expect((await pull(space.owner, space.spaceId)).records).toEqual([])
  })
})

describe('quotas come from the owner plan (criterion 10)', () => {
  it('max_space_records is enforced with the owner plan limit and rolls the push back', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    await withPlanFeatures(ctx, 'beta', { max_space_records: 3 }, async () => {
      await push(space.owner, space.spaceId, [spaceRecord(1), spaceRecord(2)])
      // The member's write counts against the same space limit.
      expectMinima(
        await pushSpace(space.members[0], space.spaceId, [spaceRecord(3), spaceRecord(4)]),
        'quota_exceeded',
      )
      expect((await pull(space.owner, space.spaceId)).records).toHaveLength(2)

      await push(space.members[0], space.spaceId, [spaceRecord(3)])
      // Editing an existing record does not add to the count.
      await push(space.owner, space.spaceId, [spaceRecord(1, 5000)])
      expectMinima(await pushSpace(space.owner, space.spaceId, [spaceRecord(4)]), 'quota_exceeded')
    })
    // With the normal limit the same write goes through.
    await push(space.owner, space.spaceId, [spaceRecord(4)])
  })

  it('max_space_bytes is enforced on the total, and exactly the limit is allowed', async () => {
    const space = await buildSpace(ctx)
    await withPlanFeatures(ctx, 'beta', { max_space_bytes: 100 }, async () => {
      await push(space.owner, space.spaceId, [spaceRecord(1, 1000, 60)])
      expectMinima(await pushSpace(space.owner, space.spaceId, [spaceRecord(2, 1000, 60)]), 'quota_exceeded')
      await push(space.owner, space.spaceId, [spaceRecord(2, 1000, 40)])
      expectMinima(await pushSpace(space.owner, space.spaceId, [spaceRecord(3, 1000, 1)]), 'quota_exceeded')
    })
  })

  it('a member whose own plan is free can push while the owner has beta', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const member = space.members[0]
    await push(space.owner, space.spaceId, [spaceRecord(1)])

    // Devices were registered while the beta switch was on. Now it is off.
    await setFreeForAll(ctx, false)
    await grantPlan(ctx, space.owner.userId, 'beta', 'active')
    expect(expectOk(await member.rpc('effective_plan'))).toBe('free')
    expect(expectOk(await member.rpc('has_feature', { p_feature: 'sync' }))).toBe(false)

    const res = await push(member, space.spaceId, [spaceRecord(2)])
    expect(res.results[0]).toMatchObject({ status: 'accepted', seq: 2 })
    expect((await pull(member, space.spaceId)).records).toHaveLength(2)

    // The limit that applies is the owner's, not the member's.
    await withPlanFeatures(ctx, 'beta', { max_space_records: 2 }, async () => {
      expectMinima(await pushSpace(member, space.spaceId, [spaceRecord(3)]), 'quota_exceeded')
    })
  })
})

describe('removal (criterion 9)', () => {
  it('a removed member is refused at once, loses their keys and the event is written', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    const [b, c] = space.members
    await push(b, space.spaceId, [spaceRecord(1)])

    expectOk(await space.owner.rpc('remove_member', { p_space_id: space.spaceId, p_user_id: b.userId }))

    expectMinima(await pushSpace(b, space.spaceId, [spaceRecord(2)]), 'not_space_member')
    expectMinima(await pullSpace(b, space.spaceId), 'not_space_member')
    const keys = await ctx.admin('select 1 from public.space_keys where user_id = $1', [b.userId])
    expect(keys).toHaveLength(0)
    expect(await eventKinds(ctx, space.spaceId)).toContain('removed')

    // Everyone else is unaffected, and the records stay.
    expect((await pull(c, space.spaceId)).records).toHaveLength(1)
    expect(await keyVersionsOf(c)).toEqual([1])
    expect((await pull(space.owner, space.spaceId)).key_version).toBe(1)
  })
})

describe('rotation (criterion 9)', () => {
  async function afterRemoval() {
    const space = await buildSpace(ctx, { active: 2 })
    const [b, c] = space.members
    expectOk(await space.owner.rpc('remove_member', { p_space_id: space.spaceId, p_user_id: b.userId }))
    return { space, b, c }
  }

  it('a wrap missing for an active member or an extra non-member is members_mismatch', async () => {
    const { space, b, c } = await afterRemoval()
    const outsider = await familyUser(ctx)
    const owner = space.owner

    expectMinima(await rotateKey(owner, space.spaceId, 2, [owner.userId]), 'members_mismatch')
    expectMinima(await rotateKey(owner, space.spaceId, 2, [c.userId]), 'members_mismatch')
    expectMinima(await rotateKey(owner, space.spaceId, 2, [owner.userId, c.userId, b.userId]), 'members_mismatch')
    expectMinima(
      await rotateKey(owner, space.spaceId, 2, [owner.userId, c.userId, outsider.userId]),
      'members_mismatch',
    )
    expectMinima(await rotateKey(owner, space.spaceId, 2, []), 'members_mismatch')

    // Nothing was written by the refused attempts.
    const view = expectOk<{ key_version: number }>(await owner.rpc('get_my_space'))
    expect(view.key_version).toBe(1)
    const rows = await ctx.admin('select 1 from public.space_keys where key_version = 2 and space_id = $1', [
      space.spaceId,
    ])
    expect(rows).toHaveLength(0)
    expect(await eventKinds(ctx, space.spaceId)).not.toContain('key_rotated')
  })

  it('a pending member is not part of the set', async () => {
    const space = await buildSpace(ctx, { active: 1, pending: 1 })
    const [member] = space.members
    const [waiting] = space.pending
    expectMinima(
      await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, member.userId, waiting.userId]),
      'members_mismatch',
    )
    expectOk(await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, member.userId]))
  })

  it('refuses a wrong version, malformed wraps and duplicates', async () => {
    const { space, c } = await afterRemoval()
    const owner = space.owner
    const ids = [owner.userId, c.userId]
    const rotate = (version: unknown, wraps: unknown) =>
      owner.rpc('rotate_space_key', {
        p_space_id: space.spaceId,
        p_new_version: version,
        p_wraps: wraps,
      })
    const wrap = (userId: string) => ({ user_id: userId, wrapped_key: fakeWrappedKey() })

    for (const version of [1, 3, 0, 10]) {
      expectMinima(await rotateKey(owner, space.spaceId, version, ids), 'wrong_key_version')
    }
    // The version is checked before the member set.
    expectMinima(await rotateKey(owner, space.spaceId, 3, [owner.userId]), 'wrong_key_version')

    expectMinima(await rotate(null, ids.map(wrap)), 'invalid_input')
    expectMinima(await rotate(2, {}), 'invalid_input')
    expectMinima(await rotate(2, null), 'invalid_input')
    expectMinima(await rotate(2, [wrap(owner.userId), { user_id: c.userId }]), 'invalid_input')
    expectMinima(await rotate(2, [wrap(owner.userId), { wrapped_key: fakeWrappedKey() }]), 'invalid_input')
    expectMinima(
      await rotate(2, [wrap(owner.userId), { user_id: 'not-a-uuid', wrapped_key: fakeWrappedKey() }]),
      'invalid_input',
    )
    expectMinima(
      await rotate(2, [wrap(owner.userId), { user_id: c.userId, wrapped_key: { v: 1 } }]),
      'invalid_input',
    )
    expectMinima(await rotate(2, [wrap(owner.userId), wrap(c.userId), wrap(c.userId)]), 'invalid_input')
    expectMinima(await rotate(2, [wrap(owner.userId), 5]), 'invalid_input')

    expect(expectOk<{ key_version: number }>(await owner.rpc('get_my_space')).key_version).toBe(1)
    expect(await keyVersionsOf(c)).toEqual([1])
  })

  it('a valid rotation raises key_version, keeps old keys and writes the event', async () => {
    const { space, b, c } = await afterRemoval()
    const owner = space.owner
    await push(owner, space.spaceId, [spaceRecord(1)])

    const res = expectOk(await rotateKey(owner, space.spaceId, 2, [owner.userId, c.userId]))
    expect(res).toEqual({ space_id: space.spaceId, key_version: 2 })

    const stored = await ctx.admin<{ user_id: string; key_version: number }>(
      'select user_id, key_version from public.space_keys where space_id = $1 order by key_version, user_id',
      [space.spaceId],
    )
    const pairs = stored.map((r) => `${r.user_id === owner.userId ? 'owner' : r.user_id === c.userId ? 'c' : 'x'}:${r.key_version}`)
    expect(pairs.sort()).toEqual(['c:1', 'c:2', 'owner:1', 'owner:2'])
    expect(stored.some((r) => r.user_id === b.userId)).toBe(false)

    expect(await keyVersionsOf(owner)).toEqual([1, 2])
    expect(await keyVersionsOf(c)).toEqual([1, 2])
    expect((await pull(c, space.spaceId)).key_version).toBe(2)
    expect((await pull(c, space.spaceId)).records).toHaveLength(1)
    expect((await eventKinds(ctx, space.spaceId)).at(-1)).toBe('key_rotated')

    // And again: the next version is 3.
    expectMinima(await rotateKey(owner, space.spaceId, 2, [owner.userId, c.userId]), 'wrong_key_version')
    expectOk(await rotateKey(owner, space.spaceId, 3, [owner.userId, c.userId]))
    expect(await keyVersionsOf(c)).toEqual([1, 2, 3])
  })

  it('a push with the old version is key_outdated with the current version in the message', async () => {
    const { space, c } = await afterRemoval()
    expectOk(await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, c.userId]))

    expectKeyOutdated(await pushSpace(space.owner, space.spaceId, [spaceRecord(1)], 1), 2)
    expectKeyOutdated(await pushSpace(c, space.spaceId, [spaceRecord(1)], 1), 2)
    // A version from the future is refused the same way.
    expectKeyOutdated(await pushSpace(c, space.spaceId, [spaceRecord(1)], 3), 2)
    // The check comes before the records are looked at.
    const garbage = await c.rpc('push_space_records', {
      p_space_id: space.spaceId,
      p_device_id: c.deviceId,
      p_key_version: 1,
      p_records: {},
    })
    expectKeyOutdated(garbage, 2)

    const ok = await push(c, space.spaceId, [spaceRecord(1)], 2)
    expect(ok.results[0]).toMatchObject({ status: 'accepted' })
  })

  it('re-pushing an equal updated_at_ms with the new version is accepted, with the same version stale', async () => {
    const { space, c } = await afterRemoval()
    await push(space.owner, space.spaceId, [spaceRecord(1, 1000, 24, 'a')])
    expectOk(await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, c.userId]))

    const again = await push(c, space.spaceId, [spaceRecord(1, 1000, 24, 'n')], 2)
    expect(again.results[0]).toMatchObject({ status: 'accepted', seq: 2 })
    const row = (await pull(space.owner, space.spaceId)).records[0]
    expect(row).toMatchObject({ ciphertext: 'n'.repeat(24), key_version: 2, author_id: c.userId })

    const third = await push(c, space.spaceId, [spaceRecord(1, 1000, 24, 'q')], 2)
    expect(third.results[0]).toMatchObject({ status: 'stale' })
    expect(third.results[0].current?.ciphertext).toBe('n'.repeat(24))
    // An older timestamp is still stale under the new version.
    const older = await push(c, space.spaceId, [spaceRecord(1, 999, 24, 'r')], 2)
    expect(older.results[0]).toMatchObject({ status: 'stale' })
  })
})

describe('paused spaces (criterion 11)', () => {
  it('push and pull give space_paused, outsiders still get not_space_member', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    const outsider = await familyUser(ctx)
    await push(space.owner, space.spaceId, [spaceRecord(1)])
    await setFreeForAll(ctx, false)

    for (const user of [space.owner, space.members[0]]) {
      expectMinima(await pushSpace(user, space.spaceId, [spaceRecord(2)]), 'space_paused')
      expectMinima(await pullSpace(user, space.spaceId), 'space_paused')
    }
    expectMinima(await pushSpace(outsider, space.spaceId, [spaceRecord(2)]), 'not_space_member')
    expectMinima(await pullSpace(outsider, space.spaceId), 'not_space_member')
    expect(await countRows(ctx, 'space_records', space.spaceId)).toBe(1)
  })

  it('a member plan does not unpause a space, only the owner plan does', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    await setFreeForAll(ctx, false)
    await grantPlan(ctx, space.members[0].userId, 'beta', 'active')
    expectMinima(await pullSpace(space.members[0], space.spaceId), 'space_paused')

    // A sync plan has no shared_spaces.
    await grantPlan(ctx, space.owner.userId, 'sync', 'active', '30 days')
    expectMinima(await pullSpace(space.members[0], space.spaceId), 'space_paused')
  })

  it('a family entitlement for the owner restores access, and losing it pauses again', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    await push(space.owner, space.spaceId, [spaceRecord(1)])
    await setFreeForAll(ctx, false)
    expectMinima(await pullSpace(space.members[0], space.spaceId), 'space_paused')

    await grantPlan(ctx, space.owner.userId, 'family', 'active', '30 days')
    expect((await pull(space.members[0], space.spaceId)).records).toHaveLength(1)
    const res = await push(space.members[0], space.spaceId, [spaceRecord(2)])
    expect(res.results[0]).toMatchObject({ status: 'accepted', seq: 2 })

    await grantPlan(ctx, space.owner.userId, 'family', 'canceled', '30 days')
    expectMinima(await pullSpace(space.members[0], space.spaceId), 'space_paused')
    await grantPlan(ctx, space.owner.userId, 'beta', 'active')
    expect((await pull(space.members[0], space.spaceId)).records).toHaveLength(2)
  })

  it('get_my_space, leave_space, transfer_ownership and delete_space still work', async () => {
    const space = await buildSpace(ctx, { active: 2 })
    const [b, c] = space.members
    await setFreeForAll(ctx, false)

    const view = expectOk<{ paused: boolean; status: string; members: Array<unknown> }>(
      await b.rpc('get_my_space'),
    )
    expect(view.paused).toBe(true)
    expect(view.status).toBe('active')
    expect(view.members).toHaveLength(3)

    expectOk(await c.rpc('leave_space'))
    expect(expectOk(await space.owner.rpc('transfer_ownership', {
      p_space_id: space.spaceId,
      p_user_id: b.userId,
    }))).toEqual({ space_id: space.spaceId, owner_id: b.userId })
    expect(expectOk(await b.rpc('delete_space', { p_space_id: space.spaceId }))).toEqual({
      space_id: space.spaceId,
    })
    expect(expectOk(await b.rpc('get_my_space'))).toBeNull()
  })

  it('the security actions still work: revoke, reject, remove and rotate', async () => {
    const space = await buildSpace(ctx, { active: 2, pending: 1 })
    const invite = await makeInvite(space.owner, space.spaceId)
    await setFreeForAll(ctx, false)
    const [b, c] = space.members

    expectOk(await space.owner.rpc('revoke_invite', { p_invite_id: invite.inviteId }))
    expectOk(
      await space.owner.rpc('reject_member', {
        p_space_id: space.spaceId,
        p_user_id: space.pending[0].userId,
      }),
    )
    expectOk(await space.owner.rpc('remove_member', { p_space_id: space.spaceId, p_user_id: b.userId }))
    expectOk(await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, c.userId]))
    expect(await keyVersionsOf(c)).toEqual([1, 2])
  })

  it('the growth actions are paused: invites, join requests and approvals', async () => {
    const space = await buildSpace(ctx, { pending: 1 })
    const open = await makeInvite(space.owner, space.spaceId)
    const visitor = await familyUser(ctx)
    await setFreeForAll(ctx, false)

    expectMinima(
      await space.owner.rpc('create_invite', {
        p_space_id: space.spaceId,
        p_token_hash: hashToken('paused'),
      }),
      'space_paused',
    )
    expectMinima(
      await visitor.rpc('get_invite', { p_invite_id: open.inviteId, p_token: open.token }),
      'space_paused',
    )
    expectMinima(
      await visitor.rpc('request_join', {
        p_invite_id: open.inviteId,
        p_token: open.token,
        p_public_key: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' },
      }),
      'space_paused',
    )
    expectMinima(
      await space.owner.rpc('approve_member', {
        p_space_id: space.spaceId,
        p_user_id: space.pending[0].userId,
        p_key_version: 1,
        p_wrapped_key: fakeWrappedKey(),
      }),
      'space_paused',
    )
    expect(
      expectOk<{ status: string }>(await space.pending[0].rpc('get_my_space')).status,
    ).toBe('pending')

    // Back on: the same calls work, and the refused request did not use the invite up.
    await setFreeForAll(ctx, true)
    expectOk(await visitor.rpc('get_invite', { p_invite_id: open.inviteId, p_token: open.token }))
  })

  it('creating a space needs the shared_spaces feature, and a family entitlement gives it', async () => {
    const owner = await familyUser(ctx)
    await setFreeForAll(ctx, false)
    expectMinima(
      await owner.rpc('create_space', {
        p_space_id: crypto.randomUUID(),
        p_public_key: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' },
        p_wrapped_key_for_self: fakeWrappedKey(),
      }),
      'sync_not_included',
    )
    await grantPlan(ctx, owner.userId, 'family', 'active', '30 days')
    await createFamilySpace(owner)
  })
})

describe('joining after removal and rotation', () => {
  it('a member who joins after a rotation gets the current version', async () => {
    const space = await buildSpace(ctx, { active: 1 })
    expectOk(await rotateKey(space.owner, space.spaceId, 2, [space.owner.userId, space.members[0].userId]))

    const late = await familyUser(ctx)
    await requestToJoin(space.owner, space.spaceId, late)
    expectMinima(
      await space.owner.rpc('approve_member', {
        p_space_id: space.spaceId,
        p_user_id: late.userId,
        p_key_version: 1,
        p_wrapped_key: fakeWrappedKey(),
      }),
      'wrong_key_version',
    )
    const other = await familyUser(ctx)
    await joinAndApprove(space.owner, space.spaceId, other, 2)
    expect(await keyVersionsOf(other)).toEqual([2])
  })
})
