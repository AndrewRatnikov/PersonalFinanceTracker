// CONTRACT_GAP: the recurring scenario uses mode 'auto' and processDueRecurring
//   with an explicit `today`, both from the existing spaceDb handle; that the
//   occurrence id is deterministic (so "exactly one entry") follows the
//   existing occurrenceId rules and is asserted through the visible result.
//
// Merging (criterion 30): O and B1 edit the Family offline and converge on the
// newer edit; delete vs edit is newest wins; a recurring item generated on both
// devices yields one entry; createdBy / updatedBy are per author.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { FamilyUser } from '@/test/sql/familyHarness'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  familyExpense,
  familyExpenses,
  firstDevice,
  joinFamily,
  newUser,
  settle,
} from '@/test/sync/familySim'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: () => {
    const id = (globalThis as Record<string, unknown>).__minimaActingUser
    return Promise.resolve(typeof id === 'string' ? { userId: id, email: null } : null)
  },
}))
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 })

const T0 = '2026-10-30T09:00:00.000Z'
const T1 = '2026-10-30T10:00:00.000Z'
const T2 = '2026-10-30T11:00:00.000Z'
const T3 = '2026-10-30T12:00:00.000Z'
const CREATED = '2026-10-20T12:00:00.000Z'

let ctx: SqlTestDb
let userO: FamilyUser
let userB: FamilyUser
let o1: SimDevice
let b1: SimDevice
let spaceId: string

function at(iso: string) {
  vi.setSystemTime(new Date(iso))
}

function amountOn(list: Awaited<ReturnType<typeof familyExpenses>>, id: string): number | undefined {
  return list.find((e) => e.id === id)?.amount
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0)
  ctx = await startFamilyDb()
  userO = await newUser(ctx)
  userB = await newUser(ctx)
  o1 = await firstDevice(userO, 'O1')
  b1 = await firstDevice(userB, 'B1')
  spaceId = await createFamilyOn(o1, 'Merge')
  await joinFamily(o1, b1)
  await settle([o1, b1])
}, 240_000)

afterAll(async () => {
  o1.dispose()
  b1.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('the same expense edited offline on both devices', () => {
  it('converges on the newer edit everywhere, whichever device syncs first', async () => {
    at(T0)
    const e = await familyExpense(o1, spaceId, 100, 'Marker shared dinner')
    await settle([o1, b1])
    expect(amountOn(await familyExpenses(b1, spaceId), e.id)).toBe(100)

    at(T1)
    await act(o1, () => o1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 111 }))
    at(T2)
    await act(b1, () => b1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 222 }))
    at(T3)
    await settle([o1, b1, o1, b1])

    expect(amountOn(await familyExpenses(o1, spaceId), e.id)).toBe(222)
    expect(amountOn(await familyExpenses(b1, spaceId), e.id)).toBe(222)
  })

  it('the older edit loses even when it reaches the server last', async () => {
    at(T0)
    const e = await familyExpense(b1, spaceId, 5, 'Marker second dinner')
    await settle([b1, o1])

    at(T2)
    await act(b1, () => b1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 55 }))
    at(T1)
    await act(o1, () => o1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 33 }))
    at(T3)
    await settle([b1, o1, b1, o1])

    expect(amountOn(await familyExpenses(o1, spaceId), e.id)).toBe(55)
    expect(amountOn(await familyExpenses(b1, spaceId), e.id)).toBe(55)
  })
})

describe('delete versus edit', () => {
  it('a newer edit beats an older delete', async () => {
    at(T0)
    const e = await familyExpense(o1, spaceId, 10, 'Marker edit wins')
    await settle([o1, b1])

    at(T1)
    await act(o1, () => o1.localDb.spaceDb(spaceId).deleteExpense(e.id, CREATED))
    at(T2)
    await act(b1, () => b1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 11 }))
    at(T3)
    await settle([o1, b1, o1, b1])

    expect(amountOn(await familyExpenses(o1, spaceId), e.id)).toBe(11)
    expect(amountOn(await familyExpenses(b1, spaceId), e.id)).toBe(11)
  })

  it('a newer delete beats an older edit', async () => {
    at(T0)
    const e = await familyExpense(o1, spaceId, 20, 'Marker delete wins')
    await settle([o1, b1])

    at(T1)
    await act(b1, () => b1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 21 }))
    at(T2)
    await act(o1, () => o1.localDb.spaceDb(spaceId).deleteExpense(e.id, CREATED))
    at(T3)
    await settle([o1, b1, o1, b1])

    expect(amountOn(await familyExpenses(o1, spaceId), e.id)).toBeUndefined()
    expect(amountOn(await familyExpenses(b1, spaceId), e.id)).toBeUndefined()
  })
})

describe('authors', () => {
  it('createdBy is the creator and updatedBy the last editor, on both devices', async () => {
    at(T0)
    const e = await familyExpense(o1, spaceId, 30, 'Marker authors')
    await settle([o1, b1])
    at(T1)
    await act(b1, () => b1.localDb.spaceDb(spaceId).updateExpense(e.id, CREATED, { amount: 31 }))
    at(T2)
    await settle([b1, o1])

    for (const d of [o1, b1]) {
      const found = (await familyExpenses(d, spaceId)).find((x) => x.id === e.id)
      expect(found?.createdBy, d.name).toBe(userO.userId)
      expect(found?.updatedBy, d.name).toBe(userB.userId)
      expect(found?.amount, d.name).toBe(31)
    }
  })
})

describe('a Family recurring item generated offline on both devices', () => {
  it('yields exactly one entry for the occurrence everywhere', async () => {
    at(T0)
    const category = (await act(o1, () => o1.localDb.spaceDb(spaceId).getAllCategories()))[0]
    await act(o1, () =>
      o1.localDb.spaceDb(spaceId).addRecurring(
        {
          kind: 'expense',
          amount: 313131,
          currency: 'UAH',
          categoryId: category.id,
          description: 'Marker rent monthly',
          frequency: { unit: 'month', interval: 1 },
          startDate: '2026-12-01',
          end: { type: 'never' },
          mode: 'auto',
        },
        { createThroughToday: false, today: '2026-10-30' },
      ),
    )
    await settle([o1, b1])

    at(T1)
    await act(o1, () => o1.localDb.spaceDb(spaceId).processDueRecurring('2026-12-02'))
    at(T2)
    await act(b1, () => b1.localDb.spaceDb(spaceId).processDueRecurring('2026-12-02'))
    at(T3)
    await settle([o1, b1, o1, b1])

    for (const d of [o1, b1]) {
      const generated = (await familyExpenses(d, spaceId)).filter((x) => x.description === 'Marker rent monthly')
      expect(generated, d.name).toHaveLength(1)
      expect(generated[0].amount).toBe(313131)
    }
  })
})
