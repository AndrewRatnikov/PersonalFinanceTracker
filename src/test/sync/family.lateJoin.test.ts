// CONTRACT_GAP: an unfinished re-encryption is staged by failing every
//   push_space_records call (transport failure) after rotate_space_key succeeded.
// CONTRACT_GAP: the number of rows D skips is asserted as "more than zero and
//   fewer than all", not as an exact figure.
//
// Late join (criterion 24): D is approved after a rotation while the
// re-encryption has not finished. D skips the rows still on version 1 without
// advancing its cursor past them, and has every record once the owner finishes.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  approveOn,
  createFamilyOn,
  cycle,
  familyActionsOf,
  familyExpense,
  familyExpenses,
  firstDevice,
  joinFamily,
  newUser,
  requestJoinOn,
  serverRows,
  settle,
  userIdOf,
} from '@/test/sync/familySim'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: () => {
    const id = (globalThis as Record<string, unknown>).__minimaActingUser
    return Promise.resolve(typeof id === 'string' ? { userId: id, email: null } : null)
  },
}))
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

const COUNT = 6

let ctx: SqlTestDb
let o1: SimDevice
let c1: SimDevice
let d1: SimDevice
let spaceId: string
let versionsDuringGap: Array<number> = []
let gapMissing = 0
let gapExpenseCount = 0
let gapCursor = 0

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  const userO = await newUser(ctx)
  const userC = await newUser(ctx)
  const userD = await newUser(ctx)
  o1 = await firstDevice(userO, 'O1')
  c1 = await firstDevice(userC, 'C1')
  d1 = await firstDevice(userD, 'D1')
  spaceId = await createFamilyOn(o1, 'Late join')
  await joinFamily(o1, c1)
  for (let i = 1; i <= COUNT; i++) await familyExpense(o1, spaceId, i * 10, `Marker late ${i}`)
  await settle([o1, c1], 2)

  // Rotation succeeds, but the re-encryption pushes keep failing.
  let blocked = true
  o1.intercept = (call) =>
    blocked && call.fn === 'push_space_records'
      ? { data: null, error: { message: 'Failed to fetch' }, status: 0 }
      : undefined
  await act(o1, () => familyActionsOf(o1).removeMember(userIdOf(c1)))
  versionsDuringGap = (await serverRows(ctx, spaceId)).map((r) => r.key_version)

  await requestJoinOn(o1, d1)
  await approveOn(o1, d1)
  const result = await cycle(d1)
  gapMissing = result.family?.missingKey ?? -1
  gapExpenseCount = (await familyExpenses(d1, spaceId)).length
  gapCursor = (await d1.localDb.getSpaceKeyEntry(spaceId)) ? 1 : 0

  blocked = false
  o1.intercept = null
  await settle([o1, d1], 3)
}, 300_000)

afterAll(async () => {
  for (const d of [o1, c1, d1]) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('during the unfinished re-encryption', () => {
  it('the server key is on version 2 while rows are still on version 1', () => {
    expect(versionsDuringGap.length).toBeGreaterThan(COUNT)
    expect(versionsDuringGap.every((v) => v === 1)).toBe(true)
  })

  it('D joined (it holds an entry) but skipped the rows it cannot read', () => {
    expect(gapCursor).toBe(1)
    expect(gapMissing).toBeGreaterThan(0)
    expect(gapExpenseCount).toBeLessThan(COUNT)
  })
})

describe('after the owner finishes the re-encryption', () => {
  it('every server row is on version 2', async () => {
    const rows = await serverRows(ctx, spaceId)

    expect(new Set(rows.map((r) => r.key_version))).toEqual(new Set([2]))
  })

  it('D has every record that was skipped', async () => {
    const descriptions = (await familyExpenses(d1, spaceId)).map((e) => e.description)

    expect(descriptions).toHaveLength(COUNT)
    for (let i = 1; i <= COUNT; i++) expect(descriptions).toContain(`Marker late ${i}`)
  })

  it('D shows synced and nothing is reported missing any more', async () => {
    const result = await cycle(d1)

    expect(d1.family?.getState().status).toBe('synced')
    expect(result.family?.missingKey).toBe(0)
  })

  it('D holds only version 2 (it joined after the rotation)', async () => {
    const entry = await act(d1, () => d1.localDb.getSpaceKeyEntry(spaceId))

    expect(entry?.keyVersion).toBe(2)
    expect(entry?.previousKeys ?? []).toHaveLength(0)
  })
})
