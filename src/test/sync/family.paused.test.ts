// CONTRACT_GAP: the plan to change is read from the owner's own sync status
//   (plan_id), because the contract names no plan id; the test only passes it to
//   withPlanFeatures from familyHarness.
//
// Paused (criteria 3 and 29): when the owner's plan loses shared_spaces the
// Family shows 'paused' for every member, personal sync keeps working, local
// Family edits queue and reach the server after access returns.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb, withPlanFeatures } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  cycle,
  familyExpense,
  familyExpenses,
  firstDevice,
  joinFamily,
  newUser,
  serverRows,
  settle,
} from '@/test/sync/familySim'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: () => {
    const id = (globalThis as Record<string, unknown>).__minimaActingUser
    return Promise.resolve(typeof id === 'string' ? { userId: id, email: null } : null)
  },
}))
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

let ctx: SqlTestDb
let o1: SimDevice
let b1: SimDevice
let spaceId: string
let planId = ''

let pausedOwner = ''
let pausedMember = ''
let personalWhilePaused = ''
let rowsWhilePaused = 0
let queuedId = ''
let serverSawQueued = true
let personalLandedOnServer = 0

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  o1 = await firstDevice(await newUser(ctx), 'O1')
  b1 = await firstDevice(await newUser(ctx), 'B1')
  spaceId = await createFamilyOn(o1, 'Paused')
  await joinFamily(o1, b1)
  await settle([o1, b1], 2)
  planId = (await act(o1, () => o1.api.getSyncStatus())).plan_id

  await withPlanFeatures(ctx, planId, { shared_spaces: false }, async () => {
    rowsWhilePaused = (await serverRows(ctx, spaceId)).length
    queuedId = (await familyExpense(b1, spaceId, 321, 'Marker queued while paused')).id
    await act(b1, () => b1.localDb.addCategory({ name: 'Marker personal while paused' }))
    await settle([o1, b1], 2)
    pausedOwner = o1.family?.getState().status ?? ''
    pausedMember = b1.family?.getState().status ?? ''
    personalWhilePaused = b1.engine.getState().status
    serverSawQueued = (await serverRows(ctx, spaceId)).length !== rowsWhilePaused
    personalLandedOnServer = (
      await ctx.admin<{ n: number }>("select count(*)::int as n from public.sync_records where user_id = $1", [b1.state.userId])
    )[0].n
  })
  await settle([b1, o1], 3)
}, 300_000)

afterAll(async () => {
  o1.dispose()
  b1.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('while the owner plan lacks shared_spaces', () => {
  it('every member sees paused', () => {
    expect(pausedOwner).toBe('paused')
    expect(pausedMember).toBe('paused')
  })

  it('personal sync keeps working and is not paused', () => {
    expect(personalWhilePaused).toBe('synced')
    expect(personalLandedOnServer).toBeGreaterThan(0)
  })

  it('a Family edit is kept locally and does not reach the server', async () => {
    expect(serverSawQueued).toBe(false)
    expect((await familyExpenses(b1, spaceId)).map((e) => e.id)).toContain(queuedId)
  })
})

describe('after access returns', () => {
  it('the queued edit syncs to the other member and the state is synced', async () => {
    expect((await familyExpenses(o1, spaceId)).map((e) => e.id)).toContain(queuedId)
    expect(b1.family?.getState().status).toBe('synced')
    expect(o1.family?.getState().status).toBe('synced')
    expect((await serverRows(ctx, spaceId)).length).toBeGreaterThan(rowsWhilePaused)
  })

  it('a Family error never changed the personal status', async () => {
    await cycle(b1)

    expect(b1.engine.getState().status).toBe('synced')
  })
})
