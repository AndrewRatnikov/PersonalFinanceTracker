// CONTRACT_GAP: the offline rotation failure is injected as a transport failure
//   of rotate_space_key (status 0) through SimDevice.intercept.
//
// Remove, rotate and re-encrypt (criteria 21, 22, 28): O removes C; the first
// rotation attempt fails offline (rotation-pending, pushes wait), the next cycle
// rotates and re-encrypts every row to version 2; B1 hits key_outdated, adopts
// version 2 and succeeds; C gets nothing and ends read-only.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { FamilyUser } from '@/test/sql/familyHarness'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import { isSpaceReadOnlyError } from '@/lib/spaces/types'
import {
  act,
  createFamilyOn,
  cycle,
  familyActionsOf,
  familyExpense,
  familyExpenses,
  firstDevice,
  joinFamily,
  newUser,
  serverRows,
  settle,
  spacesOf,
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
let userC: FamilyUser
let o1: SimDevice
let b1: SimDevice
let c1: SimDevice
let spaceId: string
let beforeRows = 0
let pendingStatus = ''
let rowsWhilePending: Array<number> = []
let pushesWhilePending = 0

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  const userO = await newUser(ctx)
  const userB = await newUser(ctx)
  userC = await newUser(ctx)
  o1 = await firstDevice(userO, 'O1')
  b1 = await firstDevice(userB, 'B1')
  c1 = await firstDevice(userC, 'C1')
  spaceId = await createFamilyOn(o1, 'Rotation')
  await joinFamily(o1, b1)
  await joinFamily(o1, c1)
  for (let i = 1; i <= 5; i++) await familyExpense(o1, spaceId, i * 100, `Marker row ${i}`)
  await settle([o1, b1, c1], 3)
  beforeRows = (await serverRows(ctx, spaceId)).length

  // The first rotation attempt fails offline.
  let failed = 0
  o1.intercept = (call) => {
    if (call.fn === 'rotate_space_key' && failed === 0) {
      failed += 1
      return { data: null, error: { message: 'Failed to fetch' }, status: 0 }
    }
    return undefined
  }
  const pushesBefore = o1.count('push_space_records')
  await act(o1, () => familyActionsOf(o1).removeMember(userC.userId))
  pendingStatus = o1.family?.getState().status ?? 'missing'
  rowsWhilePending = (await serverRows(ctx, spaceId)).map((r) => r.key_version)
  pushesWhilePending = o1.count('push_space_records') - pushesBefore

  o1.intercept = null
  await cycle(o1)
}, 300_000)

afterAll(async () => {
  for (const d of [o1, b1, c1]) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('while the rotation has not succeeded', () => {
  it('the Family is rotation-pending and the rows are still on version 1', () => {
    expect(pendingStatus).toBe('rotation-pending')
    expect(rowsWhilePending.length).toBe(beforeRows)
    expect(new Set(rowsWhilePending)).toEqual(new Set([1]))
  })

  it('no push went out', () => {
    expect(pushesWhilePending).toBe(0)
  })
})

describe('after the rotation and the re-encryption', () => {
  it('the server is on key version 2 and every row carries version 2', async () => {
    const rows = await serverRows(ctx, spaceId)

    const my = await act(o1, () => spacesOf(o1).getMySpace())
    expect(my?.key_version).toBe(2)
    expect(rows.length).toBe(beforeRows)
    expect(new Set(rows.map((r) => r.key_version))).toEqual(new Set([2]))
  })

  it('the record keys did not change (rows were overwritten in place)', async () => {
    expect((await serverRows(ctx, spaceId)).length).toBe(beforeRows)
  })

  it('the owner holds both versions and lists the remaining members in the wrap set', async () => {
    const entry = await act(o1, () => o1.localDb.getSpaceKeyEntry(spaceId))

    expect(entry?.keyVersion).toBe(2)
    expect(entry?.previousKeys?.map((k) => k.keyVersion)).toContain(1)
    expect(entry?.wrappedFor?.keyVersion).toBe(2)
    expect(entry?.wrappedFor?.userIds).not.toContain(userC.userId)
    expect(entry?.wrappedFor?.userIds).toHaveLength(2)
  })

  it('the owner shows synced again', () => {
    expect(o1.family?.getState().status).toBe('synced')
  })
})

describe('B1 after the rotation', () => {
  it('its next push gets key_outdated, adopts version 2 and succeeds', async () => {
    const written = await familyExpense(b1, spaceId, 9999, 'Marker after rotation')

    await settle([b1, o1])

    const entry = await act(b1, () => b1.localDb.getSpaceKeyEntry(spaceId))
    expect(entry?.keyVersion).toBe(2)
    expect(entry?.previousKeys?.map((k) => k.keyVersion)).toContain(1)
    expect(b1.family?.getState().status).toBe('synced')
    expect((await familyExpenses(o1, spaceId)).map((e) => e.id)).toContain(written.id)
    const rows = await serverRows(ctx, spaceId)
    expect(new Set(rows.map((r) => r.key_version))).toEqual(new Set([2]))
  })

  it('still reads everything O wrote before the rotation', async () => {
    const descriptions = (await familyExpenses(b1, spaceId)).map((e) => e.description)

    for (let i = 1; i <= 5; i++) expect(descriptions).toContain(`Marker row ${i}`)
  })
})

describe('C after being removed', () => {
  it('can pull nothing from the server', async () => {
    const err = await act(c1, () => spacesOf(c1).pullSpaceRecords(spaceId, c1.deviceIds.id(), 0)).then(
      () => null,
      (e: unknown) => e,
    )

    expect((err as { code?: string } | null)?.code).toBe('not_space_member')
  })

  it('ends in removed, read-only, with the old copy still readable', async () => {
    await cycle(c1)

    expect(c1.family?.getState()).toMatchObject({ status: 'removed', readOnly: true })
    const entry = await act(c1, () => c1.localDb.getSpaceKeyEntry(spaceId))
    expect(entry?.status).toBe('removed')
    expect(entry?.keyVersion).toBe(1)
    const copy = (await familyExpenses(c1, spaceId)).map((e) => e.description)
    expect(copy).toContain('Marker row 1')
    expect(copy).not.toContain('Marker after rotation')
  })

  it('a Family write raises SpaceReadOnlyError', async () => {
    const err = await familyExpense(c1, spaceId, 1, 'Marker blocked').then(
      () => null,
      (e: unknown) => e,
    )

    expect(isSpaceReadOnlyError(err)).toBe(true)
  })

  it('Remove from this device forgets the copy', async () => {
    await act(c1, () => familyActionsOf(c1).forgetFamily(spaceId))
    await cycle(c1)

    expect(await act(c1, () => c1.localDb.getSpaceKeyEntry(spaceId))).toBeNull()
    expect(c1.family?.getState().status).toBe('none')
  })
})
