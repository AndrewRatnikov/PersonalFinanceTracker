// CONTRACT_GAP: "personal lists, totals, analytics, CSV" are checked through the
//   personal read functions of localDb (getAllExpenses, getAllIncome,
//   getAllCategories); analytics / CSV modules are not driven here.
//
// Isolation (criterion 31): Family records never appear in personal lists or in
// the personal sync stream, and personal records never enter the Family stream.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  familyExpense,
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

const FAMILY_DESC = 'Marker family only'
const PERSONAL_DESC = 'Marker personal only'

let ctx: SqlTestDb
let o1: SimDevice
let b1: SimDevice
let spaceId: string
let familyId = ''
let personalId = ''
let ownerUserId = ''

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  const userO = await newUser(ctx)
  o1 = await firstDevice(userO, 'O1')
  b1 = await firstDevice(await newUser(ctx), 'B1')
  ownerUserId = userO.userId
  spaceId = await createFamilyOn(o1, 'Isolation')
  await joinFamily(o1, b1)
  familyId = (await familyExpense(o1, spaceId, 111, FAMILY_DESC)).id
  const personalCategory = await act(o1, () => o1.localDb.addCategory({ name: 'Marker personal category' }))
  personalId = (
    await act(o1, () =>
      o1.localDb.addExpense({
        amount: 222,
        currency: 'UAH',
        categoryId: personalCategory.id,
        description: PERSONAL_DESC,
        createdAt: '2026-10-21T12:00:00.000Z',
      }),
    )
  ).id
  await settle([o1, b1], 3)
}, 300_000)

afterAll(async () => {
  o1.dispose()
  b1.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('Family records stay out of personal data', () => {
  it('personal lists do not contain the Family expense or its categories', async () => {
    const expenses = await act(o1, () => o1.localDb.getAllExpenses())
    const categories = await act(o1, () => o1.localDb.getAllCategories())
    const family = await act(o1, () => o1.localDb.spaceDb(spaceId).getAllCategories())

    expect(expenses.map((e) => e.id)).toContain(personalId)
    expect(expenses.map((e) => e.id)).not.toContain(familyId)
    const familyCategoryIds = new Set(family.map((c) => c.id))
    expect(categories.some((c) => familyCategoryIds.has(c.id))).toBe(false)
  })

  it('the personal change list holds no Family record', async () => {
    const { records } = await act(o1, () => o1.localDb.listChangedRecords(-1))

    expect(records.some((r) => r.id === familyId)).toBe(false)
    expect(records.some((r) => r.type === 'spaceInfo' || r.type === 'memberProfile')).toBe(false)
  })

  it('the personal server store does not hold the Family expense, and the Family store does not hold the personal one', async () => {
    const personalRows = (await ctx.admin<{ record_key: string }>('select record_key from public.sync_records where user_id = $1', [ownerUserId])).length
    const familyRows = (await serverRows(ctx, spaceId)).length
    const personalLocal = (await act(o1, () => o1.localDb.listChangedRecords(-1))).records.length

    expect(personalLocal).toBeGreaterThan(0)
    expect(familyRows).toBeGreaterThan(0)
    // Exactly the personal records are in the personal store: no Family row leaked in.
    expect(personalRows).toBe(personalLocal)
  })

  it('the Family change list holds no personal expense or personal category', async () => {
    const { records } = await act(o1, () => o1.localDb.listChangedRecords(spaceId, -1))

    expect(records.some((r) => r.id === personalId)).toBe(false)
    expect(records.some((r) => r.type === 'identity' || r.type === 'spaceKey')).toBe(false)
    expect(records.some((r) => r.id === familyId)).toBe(true)
  })

  it('the other member never receives the personal expense, and has no Family expense in personal data', async () => {
    const personalOnB = await act(b1, () => b1.localDb.getAllExpenses())
    const familyOnB = await act(b1, () => b1.localDb.spaceDb(spaceId).getAllExpenses())

    expect(personalOnB.map((e) => e.id)).not.toContain(personalId)
    expect(personalOnB.map((e) => e.id)).not.toContain(familyId)
    expect(familyOnB.map((e) => e.id)).toContain(familyId)
    expect(familyOnB.map((e) => e.id)).not.toContain(personalId)
  })
})
