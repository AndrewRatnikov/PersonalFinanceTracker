// CONTRACT_GAP: how many cycles settle a record between two devices is not
//   specified; every step runs settle() with 2 rounds like the other Family
//   sync tests.
// CONTRACT_GAP: the `new-entries` event is read from SimDevice.familyEvents
//   (the events the Family stream emitted), not from the toast.
//
// PGlite multi-user harness (criteria 18, 24, 27): a shared budget is the same
// for both members, moved-in entries reach the other member and moved-out ones
// disappear for them, and the Family stream emits one new-entries event per
// cycle for records written by others, never during the first full download.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  cycle,
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
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

let ctx: SqlTestDb
let o1: SimDevice
let b1: SimDevice
let spaceId: string

function newEntryEvents(device: SimDevice) {
  return device.familyEvents.filter(
    (e): e is Extract<typeof e, { type: 'new-entries' }> => e.type === 'new-entries',
  )
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  o1 = await firstDevice(await newUser(ctx), 'O1')
  b1 = await firstDevice(await newUser(ctx), 'B1')
  spaceId = await createFamilyOn(o1, 'Our home')
}, 300_000)

afterAll(async () => {
  o1.dispose()
  b1.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('new-entries event', () => {
  it('is not emitted during the first full download of a joining member', async () => {
    await familyExpense(o1, spaceId, 10, 'Written before B joined')
    await familyExpense(o1, spaceId, 20, 'Also before B joined')
    await cycle(o1)

    await joinFamily(o1, b1)
    await settle([o1, b1], 2)

    expect((await familyExpenses(b1, spaceId)).length).toBeGreaterThanOrEqual(2)
    expect(newEntryEvents(b1)).toEqual([])
  })

  it('is emitted once per cycle with the count of entries written by others', async () => {
    const before = newEntryEvents(o1).length
    await familyExpense(b1, spaceId, 1, 'B one')
    await familyExpense(b1, spaceId, 2, 'B two')
    await familyExpense(b1, spaceId, 3, 'B three')
    await cycle(b1)

    await cycle(o1)

    const events = newEntryEvents(o1)
    expect(events.length).toBe(before + 1)
    expect(events.at(-1)).toMatchObject({ type: 'new-entries', spaceId, count: 3 })
  })

  it('does not repeat for a cycle with nothing new', async () => {
    const before = newEntryEvents(o1).length

    await cycle(o1)
    await cycle(o1)

    expect(newEntryEvents(o1).length).toBe(before)
  })

  it('does not count a member’s own entries', async () => {
    const before = newEntryEvents(o1).length
    await familyExpense(o1, spaceId, 99, 'Mine')

    await cycle(o1)
    await cycle(o1)

    expect(newEntryEvents(o1).length).toBe(before)
  })

  it('reports a different count for a different number of new entries', async () => {
    await settle([o1, b1], 2)
    await familyExpense(o1, spaceId, 5, 'O one')
    await cycle(o1)
    await cycle(b1)
    const afterOne = newEntryEvents(b1).at(-1)

    await familyExpense(o1, spaceId, 6, 'O two')
    await familyExpense(o1, spaceId, 7, 'O three')
    await cycle(o1)
    await cycle(b1)
    const afterTwo = newEntryEvents(b1).at(-1)

    expect(afterOne?.count).toBe(1)
    expect(afterTwo?.count).toBe(2)
  })
})

describe('moving entries between Personal and Family', () => {
  let movedIds: Array<string> = []

  it('entries moved into the Family reach the other member and leave Personal', async () => {
    const { ids } = await act(b1, async () => {
      const cat = await b1.localDb.addCategory({ name: 'Groceries' })
      const created = []
      for (const [i, amount] of [111, 222].entries()) {
        created.push(
          await b1.localDb.addExpense({
            amount,
            currency: 'UAH',
            categoryId: cat.id,
            description: `personal ${i}`,
            createdAt: '2026-10-20T10:00:00.000Z',
          }),
        )
      }
      const moved = await b1.localDb.moveRecords({
        from: 'personal',
        to: spaceId,
        type: 'expense',
        ids: created.map((e) => e.id),
      })
      expect(moved.moved).toBe(2)
      return { ids: created.map((e) => e.id) }
    })
    movedIds = ids

    await settle([b1, o1], 2)

    const seenByOwner = (await familyExpenses(o1, spaceId)).map((e) => e.id)
    for (const id of ids) expect(seenByOwner).toContain(id)
    expect(await act(b1, () => b1.localDb.getAllExpenses())).toEqual([])
    const mine = (await familyExpenses(b1, spaceId)).filter((e) => ids.includes(e.id))
    expect(mine.every((e) => e.paidBy === userIdOfDevice(b1))).toBe(true)
  })

  it('entries moved out of the Family disappear for the other member', async () => {
    vi.setSystemTime(new Date('2026-10-30T09:01:00.000Z'))
    const result = await act(o1, () =>
      o1.localDb.moveRecords({ from: spaceId, to: 'personal', type: 'expense', ids: movedIds }),
    )
    expect(result.moved).toBe(2)

    await settle([o1, b1], 2)

    const seenByB = (await familyExpenses(b1, spaceId)).map((e) => e.id)
    for (const id of movedIds) expect(seenByB).not.toContain(id)
    const ownerPersonal = await act(o1, () => o1.localDb.getAllExpenses())
    expect(ownerPersonal.map((e) => e.id).sort()).toEqual([...movedIds].sort())
  })
})

describe('shared budgets', () => {
  it('both members see the same limit, and an edit by either shows for the other', async () => {
    const categoryId = await act(o1, async () => {
      const db = o1.localDb.spaceDb(spaceId)
      const [cat] = await db.getAllCategories()
      await db.upsertBudget({ categoryId: cat.id, monthlyLimit: 5000, currency: 'UAH' })
      return cat.id
    })
    await settle([o1, b1], 2)

    const seenByB = await act(b1, () => b1.localDb.spaceDb(spaceId).getAllBudgets())
    expect(seenByB.find((b) => b.categoryId === categoryId)?.monthlyLimit).toBe(5000)

    vi.setSystemTime(new Date('2026-10-30T09:02:00.000Z'))
    await act(b1, () =>
      b1.localDb.spaceDb(spaceId).upsertBudget({ categoryId, monthlyLimit: 7000, currency: 'UAH' }),
    )
    await settle([b1, o1], 2)

    const seenByO = await act(o1, () => o1.localDb.spaceDb(spaceId).getAllBudgets())
    expect(seenByO.filter((b) => b.categoryId === categoryId)).toHaveLength(1)
    expect(seenByO.find((b) => b.categoryId === categoryId)?.monthlyLimit).toBe(7000)
  })
})

function userIdOfDevice(device: SimDevice): string {
  const id = device.state.userId
  if (id === null) throw new Error('signed out')
  return id
}
