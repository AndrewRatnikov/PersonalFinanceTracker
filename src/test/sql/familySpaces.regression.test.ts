// @vitest-environment node
// No CONTRACT_GAPs. The run 2 behaviour must be identical after the family
// migration (criterion 2): the same matrix runs on a run-2-only database and on
// the family database and the answers must match. get_sync_status gains
// `space` (plan B4).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  buildSpace,
  createFamilySpace,
  expectOk,
  familyUser,
  grantPlan,
  readFamilyChecks,
  requestToJoin,
  setFreeForAll,
  startFamilyDb,
} from './familyHarness'
import { CHECKS_PATH, readChecks, startDb } from './harness'
import type { SqlTestDb } from './familyHarness'

let family: SqlTestDb
let run2: SqlTestDb

beforeAll(async () => {
  family = await startFamilyDb()
  run2 = await startDb()
}, 120_000)

afterAll(async () => {
  await family.close()
  await run2.close()
})

afterEach(async () => {
  await setFreeForAll(family, true)
  await setFreeForAll(run2, true)
})

interface Spec {
  name: string
  plan: string | null
  status: string
  periodEnd: string | null
}

const SPECS: Array<Spec> = [
  { name: 'no entitlement', plan: null, status: 'active', periodEnd: null },
  { name: 'active beta', plan: 'beta', status: 'active', periodEnd: null },
  { name: 'active sync', plan: 'sync', status: 'active', periodEnd: '30 days' },
  { name: 'active free', plan: 'free', status: 'active', periodEnd: null },
  { name: 'canceled sync', plan: 'sync', status: 'canceled', periodEnd: '30 days' },
  { name: 'expired sync', plan: 'sync', status: 'active', periodEnd: '-1 day' },
  { name: 'past_due in grace', plan: 'sync', status: 'past_due', periodEnd: '3 days' },
  { name: 'past_due lapsed', plan: 'sync', status: 'past_due', periodEnd: '-3 days' },
]

const FAMILY_ONLY_KEYS = ['shared_spaces', 'max_members', 'max_space_records', 'max_space_bytes']

interface Observed {
  plan: unknown
  hasSync: unknown
  hasTeleport: unknown
  status: Record<string, unknown>
}

async function observe(ctx: SqlTestDb, spec: Spec, freeForAll: boolean): Promise<Observed> {
  await setFreeForAll(ctx, freeForAll)
  const userId = await ctx.createUser()
  if (spec.plan !== null) {
    await grantPlan(ctx, userId, spec.plan, spec.status, spec.periodEnd)
  }
  const rpc = ctx.rpcAs(userId)
  const status = expectOk<Record<string, unknown>>(await rpc('get_sync_status'))
  const limits = { ...(status.limits as Record<string, unknown>) }
  for (const key of FAMILY_ONLY_KEYS) delete limits[key]
  const rest = { ...status, limits }
  delete rest.space
  // Timestamps differ between the two databases; only their presence counts.
  rest.current_period_end = rest.current_period_end !== null
  rest.beta_joined_at = rest.beta_joined_at !== null
  return {
    plan: expectOk(await rpc('effective_plan')),
    hasSync: expectOk(await rpc('has_feature', { p_feature: 'sync' })),
    hasTeleport: expectOk(await rpc('has_feature', { p_feature: 'teleport' })),
    status: rest,
  }
}

describe('run 2 behaviour is identical after the refactor (criterion 2)', () => {
  const CASES = [true, false].flatMap((ffa) => SPECS.map((spec) => ({ ffa, spec })))

  it.each(CASES)(
    'free_for_all=$ffa, $spec.name: same answers as a run-2-only database',
    async ({ ffa, spec }) => {
      const expected = await observe(run2, spec, ffa)
      const actual = await observe(family, spec, ffa)
      expect(actual).toEqual(expected)
    },
  )

  it('the matrix really covers different plans', async () => {
    const plans = new Set<unknown>()
    for (const ffa of [true, false]) {
      for (const spec of SPECS) plans.add((await observe(family, spec, ffa)).plan)
    }
    expect(plans).toEqual(new Set(['beta', 'free', 'sync']))
  })

  it.each([
    { ffa: true, name: 'no entitlement', plan: 'beta', granted: 'free_for_all' },
    { ffa: true, name: 'active free', plan: 'beta', granted: 'free_for_all' },
    { ffa: true, name: 'expired sync', plan: 'beta', granted: 'free_for_all' },
    { ffa: false, name: 'no entitlement', plan: 'free', granted: 'default' },
    { ffa: false, name: 'active beta', plan: 'beta', granted: 'entitlement' },
    { ffa: false, name: 'active sync', plan: 'sync', granted: 'entitlement' },
    { ffa: false, name: 'canceled sync', plan: 'free', granted: 'default' },
    { ffa: false, name: 'expired sync', plan: 'free', granted: 'default' },
    { ffa: false, name: 'past_due in grace', plan: 'sync', granted: 'entitlement' },
    { ffa: false, name: 'past_due lapsed', plan: 'free', granted: 'default' },
  ])(
    'free_for_all=$ffa, $name: plan $plan, granted_by $granted',
    async ({ ffa, name, plan, granted }) => {
      const spec = SPECS.find((s) => s.name === name)
      if (!spec) throw new Error(`no spec ${name}`)
      const seen = await observe(family, spec, ffa)
      expect(seen.plan).toBe(plan)
      expect(seen.status.granted_by).toBe(granted)
      expect(seen.hasSync).toBe(plan !== 'free')
      expect(seen.hasTeleport).toBe(false)
    },
  )

  it('effective_plan and has_feature still demand a signed-in user', async () => {
    const rpc = family.rpcAs(null)
    expect((await rpc('effective_plan')).error?.message).toBe('MINIMA:not_signed_in')
    expect((await rpc('has_feature', { p_feature: 'sync' })).error?.message).toBe(
      'MINIMA:not_signed_in',
    )
    expect((await rpc('get_sync_status')).error?.message).toBe('MINIMA:not_signed_in')
  })
})

describe('the run 2 check script on the family database', () => {
  it('uses the same script file as run 2', () => {
    expect(CHECKS_PATH).toBe('supabase/tests/sync_server_checks.sql')
  })

  it('still passes after the family migration', async () => {
    const users = async () =>
      (await family.admin<{ n: number }>('select count(*)::int as n from auth.users'))[0].n
    const before = await users()
    try {
      await family.db.exec(readChecks())
    } finally {
      await family.db.exec('rollback').catch(() => undefined)
    }
    expect(await users()).toBe(before)
  })

  it('the family script is a separate file', () => {
    expect(readFamilyChecks()).not.toBe(readChecks())
  })
})

describe('get_sync_status.space (plan B4)', () => {
  interface SpaceStatus {
    space: Record<string, unknown> | null
  }

  async function spaceOf(user: { rpc: (fn: string) => PromiseLike<unknown> }) {
    const res = (await user.rpc('get_sync_status')) as { data: SpaceStatus; error: unknown }
    expect(res.error).toBeNull()
    return res.data
  }

  it('is a null value (the key is present) for a user without a space', async () => {
    const user = await familyUser(family)
    const status = await spaceOf(user)
    expect(status).toHaveProperty('space', null)
  })

  it('shows a pending request, an active member and the owner', async () => {
    const space = await buildSpace(family, { active: 1 })
    const waiting = await familyUser(family)
    await requestToJoin(space.owner, space.spaceId, waiting)

    expect((await spaceOf(waiting)).space).toEqual({
      space_id: space.spaceId,
      role: 'member',
      status: 'pending',
      paused: false,
    })
    expect((await spaceOf(space.members[0])).space).toEqual({
      space_id: space.spaceId,
      role: 'member',
      status: 'active',
      paused: false,
    })
    expect((await spaceOf(space.owner)).space).toEqual({
      space_id: space.spaceId,
      role: 'owner',
      status: 'active',
      paused: false,
    })
  })

  it('is null again after leaving', async () => {
    const space = await buildSpace(family, { active: 1 })
    expectOk(await space.members[0].rpc('leave_space'))
    expect(await spaceOf(space.members[0])).toHaveProperty('space', null)
  })

  it('reports paused when the owner has no shared_spaces feature, and clears it with a family plan', async () => {
    const space = await buildSpace(family, { active: 1 })
    const waiting = await familyUser(family)
    await requestToJoin(space.owner, space.spaceId, waiting)

    await setFreeForAll(family, false)
    for (const user of [space.owner, space.members[0], waiting]) {
      expect(((await spaceOf(user)).space as { paused: boolean }).paused).toBe(true)
    }

    await grantPlan(family, space.owner.userId, 'family', 'active', '30 days')
    for (const user of [space.owner, space.members[0], waiting]) {
      expect(((await spaceOf(user)).space as { paused: boolean }).paused).toBe(false)
    }
  })

  it('a member plan does not matter: the owner decides', async () => {
    const space = await buildSpace(family, { active: 1 })
    await setFreeForAll(family, false)
    await grantPlan(family, space.members[0].userId, 'beta', 'active')
    expect(
      ((await spaceOf(space.members[0])).space as { paused: boolean }).paused,
    ).toBe(true)

    await grantPlan(family, space.owner.userId, 'beta', 'active')
    expect(
      ((await spaceOf(space.members[0])).space as { paused: boolean }).paused,
    ).toBe(false)
  })

  it('the rest of the status is unchanged for a user in a space', async () => {
    const owner = await familyUser(family)
    await createFamilySpace(owner)
    const res = expectOk<Record<string, unknown>>(await owner.rpc('get_sync_status'))
    expect(res.plan_id).toBe('beta')
    expect(res.has_sync).toBe(true)
    expect(res.devices_count).toBe(1)
    expect(res.limits).toMatchObject({ sync: true, max_devices: 5, shared_spaces: true })
  })
})
