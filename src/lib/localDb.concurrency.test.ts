// No CONTRACT_GAPs: write serialization (#3-#5) and the `changed` broadcasts
// (#14) are fully specified in the Interface Contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import {
  DecryptError,
  addCategory,
  addExpense,
  addIncome,
  deleteBudget,
  deleteCategory,
  deleteIncome,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  provisionDefaultCategories,
  unlockLocalDb,
  updateCategory,
  updateExpense,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

const MARCH = '2024-03-15T12:00:00.000Z'
const MARCH_2 = '2024-03-20T12:00:00.000Z'
const APRIL = '2024-04-10T12:00:00.000Z'
const MARCH_CHUNK = 'expenses_2024_03'
const APRIL_CHUNK = 'expenses_2024_04'

function expenseInput(createdAt: string, amount = 5) {
  return { amount, currency: 'UAH' as const, categoryId: 'c1', createdAt }
}

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function postedKeys(channel: ReturnType<typeof fakeChannel>) {
  return channel.postMessage.mock.calls.flatMap((c) => c[0].keys)
}

describe('localDb write serialization', () => {
  beforeEach(async () => {
    mockStore.clear()
    unlockLocalDb(
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    )
  })

  afterEach(() => {
    setSyncChannel(undefined)
  })

  describe('concurrent writes lose nothing', () => {
    it('5 concurrent addIncome() store 5 entries', async () => {
      const created = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          addIncome({ source: `Job ${n}`, amount: n * 10, currency: 'UAH' }),
        ),
      )

      const stored = await getAllIncome()
      expect(stored).toHaveLength(5)
      expect(new Set(stored.map((i) => i.id)).size).toBe(5)
      expect(stored.map((i) => i.id).sort()).toEqual(
        created.map((i) => i.id).sort(),
      )
      expect(stored.map((i) => i.amount).sort((a, b) => a - b)).toEqual([
        10, 20, 30, 40, 50,
      ])
    })

    it('2 concurrent upsertBudget() for different categories store 2 budgets', async () => {
      await Promise.all([
        upsertBudget({ categoryId: 'c1', monthlyLimit: 100, currency: 'UAH' }),
        upsertBudget({ categoryId: 'c2', monthlyLimit: 200, currency: 'UAH' }),
      ])

      const stored = await getAllBudgets()
      expect(stored).toHaveLength(2)
      expect(stored.map((b) => b.categoryId).sort()).toEqual(['c1', 'c2'])
      expect(stored.find((b) => b.categoryId === 'c2')?.monthlyLimit).toBe(200)
    })

    it('concurrent upsertBudget() for the same category keeps a single budget', async () => {
      await Promise.all([
        upsertBudget({ categoryId: 'c1', monthlyLimit: 100, currency: 'UAH' }),
        upsertBudget({ categoryId: 'c1', monthlyLimit: 300, currency: 'UAH' }),
      ])

      const stored = await getAllBudgets()
      expect(stored).toHaveLength(1)
      expect(stored[0].monthlyLimit).toBe(300)
    })

    it('10 concurrent addExpense() into the same month store 10 expenses', async () => {
      const created = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          addExpense(expenseInput(MARCH, i + 1)),
        ),
      )

      const stored = await getAllExpenses()
      expect(stored).toHaveLength(10)
      expect(new Set(stored.map((e) => e.id)).size).toBe(10)
      expect(stored.map((e) => e.id).sort()).toEqual(
        created.map((e) => e.id).sort(),
      )
    })

    it('concurrent addExpense() into different months store everything', async () => {
      await Promise.all([
        addExpense(expenseInput(MARCH)),
        addExpense(expenseInput(APRIL)),
        addExpense(expenseInput(MARCH_2)),
        addExpense(expenseInput(APRIL)),
      ])

      expect(await getAllExpenses()).toHaveLength(4)
      expect(mockStore.has(MARCH_CHUNK)).toBe(true)
      expect(mockStore.has(APRIL_CHUNK)).toBe(true)
    })

    it('3 concurrent addCategory() with distinct names store 3 categories', async () => {
      await Promise.all([
        addCategory({ name: 'Food' }),
        addCategory({ name: 'Rent' }),
        addCategory({ name: 'Coffee' }),
      ])

      const names = (await getAllCategories()).map((c) => c.name).sort()
      expect(names).toEqual(['Coffee', 'Food', 'Rent'])
    })

    it('concurrent addCategory() with the same name stores one and rejects the other', async () => {
      const results = await Promise.allSettled([
        addCategory({ name: 'Food' }),
        addCategory({ name: 'food' }),
      ])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      expect(await getAllCategories()).toHaveLength(1)
    })

    it('concurrent provisionDefaultCategories() provisions the defaults once', async () => {
      await Promise.all([
        provisionDefaultCategories(),
        provisionDefaultCategories(),
        provisionDefaultCategories(),
      ])

      const categories = await getAllCategories()
      expect(categories).toHaveLength(6)
      expect(new Set(categories.map((c) => c.name)).size).toBe(6)
    })

    it('addIncome() racing deleteIncome() keeps both effects', async () => {
      const keep = await addIncome({
        source: 'Keep',
        amount: 1,
        currency: 'UAH',
      })
      const drop = await addIncome({
        source: 'Drop',
        amount: 2,
        currency: 'UAH',
      })

      await Promise.all([
        deleteIncome(drop.id),
        addIncome({ source: 'New', amount: 3, currency: 'UAH' }),
      ])

      const sources = (await getAllIncome()).map((i) => i.source).sort()
      expect(sources).toEqual(['Keep', 'New'])
      expect((await getAllIncome()).some((i) => i.id === keep.id)).toBe(true)
    })

    it('updateCategory() racing addCategory() keeps both effects', async () => {
      const food = await addCategory({ name: 'Food' })

      await Promise.all([
        updateCategory({ id: food.id, name: 'Groceries' }),
        addCategory({ name: 'Rent' }),
      ])

      const names = (await getAllCategories()).map((c) => c.name).sort()
      expect(names).toEqual(['Groceries', 'Rent'])
    })

    it('deleteCategory() racing upsertBudget() leaves no budget for the deleted category', async () => {
      const food = await addCategory({ name: 'Food' })
      const rent = await addCategory({ name: 'Rent' })
      await upsertBudget({
        categoryId: food.id,
        monthlyLimit: 100,
        currency: 'UAH',
      })

      await Promise.all([
        deleteCategory(food.id),
        upsertBudget({
          categoryId: rent.id,
          monthlyLimit: 50,
          currency: 'UAH',
        }),
      ])

      const budgets = await getAllBudgets()
      expect(budgets.map((b) => b.categoryId)).toEqual([rent.id])
      expect((await getAllCategories()).map((c) => c.id)).toEqual([rent.id])
    })
  })

  describe('updateExpense moving a record to another month', () => {
    it('loses nothing when a concurrent addExpense targets the destination month', async () => {
      const moving = await addExpense(expenseInput(MARCH, 11))

      const [updated, added] = await Promise.all([
        updateExpense(moving.id, moving.createdAt, { createdAt: APRIL }),
        addExpense(expenseInput(APRIL, 22)),
      ])

      const stored = await getAllExpenses()
      expect(stored).toHaveLength(2)
      expect(stored.map((e) => e.id).sort()).toEqual(
        [updated.id, added.id].sort(),
      )
      const movedStored = stored.find((e) => e.id === moving.id)
      expect(movedStored?.createdAt).toBe(APRIL)
      expect(movedStored?.amount).toBe(11)
    })

    it('loses nothing with several concurrent addExpense() into destination and source months', async () => {
      const moving = await addExpense(expenseInput(MARCH, 1))
      const staying = await addExpense(expenseInput(MARCH_2, 2))

      await Promise.all([
        addExpense(expenseInput(APRIL, 3)),
        updateExpense(moving.id, moving.createdAt, { createdAt: APRIL }),
        addExpense(expenseInput(APRIL, 4)),
        addExpense(expenseInput(MARCH, 5)),
        addExpense(expenseInput(APRIL, 6)),
      ])

      const stored = await getAllExpenses()
      expect(stored.map((e) => e.amount).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6,
      ])
      expect(stored.filter((e) => e.id === moving.id)).toHaveLength(1)
      expect(stored.some((e) => e.id === staying.id)).toBe(true)
    })

    it('moves the record out of its old month', async () => {
      const moving = await addExpense(expenseInput(MARCH, 11))

      await updateExpense(moving.id, moving.createdAt, { createdAt: APRIL })

      const stored = await getAllExpenses()
      expect(stored).toHaveLength(1)
      expect(stored[0].createdAt).toBe(APRIL)
    })

    it('two opposite moves between the same months finish without deadlock', async () => {
      const a = await addExpense(expenseInput(MARCH, 1))
      const b = await addExpense(expenseInput(APRIL, 2))

      await Promise.all([
        updateExpense(a.id, a.createdAt, { createdAt: APRIL }),
        updateExpense(b.id, b.createdAt, { createdAt: MARCH }),
      ])

      const stored = await getAllExpenses()
      expect(stored).toHaveLength(2)
      expect(stored.find((e) => e.id === a.id)?.createdAt).toBe(APRIL)
      expect(stored.find((e) => e.id === b.id)?.createdAt).toBe(MARCH)
    })
  })

  describe('a failed mutation releases the lock', () => {
    it('a DecryptError in one call does not block the next one', async () => {
      mockStore.set('income', new Uint8Array(40))

      await expect(
        addIncome({ source: 'A', amount: 1, currency: 'UAH' }),
      ).rejects.toBeInstanceOf(DecryptError)

      mockStore.delete('income')
      await addIncome({ source: 'B', amount: 2, currency: 'UAH' })

      expect((await getAllIncome()).map((i) => i.source)).toEqual(['B'])
    })
  })

  describe('changed broadcasts', () => {
    it('addIncome posts the income key after committing', async () => {
      const channel = fakeChannel()
      setSyncChannel(channel)

      await addIncome({ source: 'Job', amount: 10, currency: 'UAH' })

      expect(channel.postMessage).toHaveBeenCalledWith({
        type: 'changed',
        keys: ['income'],
      })
      expect(mockStore.has('income')).toBe(true)
    })

    it('deleteIncome posts the income key', async () => {
      const entry = await addIncome({
        source: 'Job',
        amount: 10,
        currency: 'UAH',
      })
      const channel = fakeChannel()
      setSyncChannel(channel)

      await deleteIncome(entry.id)

      expect(postedKeys(channel)).toEqual(['income'])
    })

    it('addExpense posts the chunk key of its month', async () => {
      const channel = fakeChannel()
      setSyncChannel(channel)

      await addExpense(expenseInput(MARCH))
      await addExpense(expenseInput(APRIL))

      expect(channel.postMessage).toHaveBeenNthCalledWith(1, {
        type: 'changed',
        keys: [MARCH_CHUNK],
      })
      expect(channel.postMessage).toHaveBeenNthCalledWith(2, {
        type: 'changed',
        keys: [APRIL_CHUNK],
      })
    })

    it('updateExpense moving months posts both written chunk keys', async () => {
      const moving = await addExpense(expenseInput(MARCH))
      const channel = fakeChannel()
      setSyncChannel(channel)

      await updateExpense(moving.id, moving.createdAt, { createdAt: APRIL })

      expect(postedKeys(channel).sort()).toEqual([MARCH_CHUNK, APRIL_CHUNK])
    })

    it('updateExpense within the same month posts that chunk key only', async () => {
      const entry = await addExpense(expenseInput(MARCH))
      const channel = fakeChannel()
      setSyncChannel(channel)

      await updateExpense(entry.id, entry.createdAt, { amount: 99 })

      expect(postedKeys(channel)).toEqual([MARCH_CHUNK])
    })

    it('upsertBudget and deleteBudget post the budgets key', async () => {
      const channel = fakeChannel()
      setSyncChannel(channel)

      const budget = await upsertBudget({
        categoryId: 'c1',
        monthlyLimit: 100,
        currency: 'UAH',
      })
      await deleteBudget(budget.id)

      expect(channel.postMessage).toHaveBeenCalledTimes(2)
      expect(postedKeys(channel)).toEqual(['budgets', 'budgets'])
    })

    it('addCategory posts the categories key', async () => {
      const channel = fakeChannel()
      setSyncChannel(channel)

      await addCategory({ name: 'Food' })

      expect(postedKeys(channel)).toEqual(['categories'])
    })

    it('provisionDefaultCategories posts only when it wrote something', async () => {
      const channel = fakeChannel()
      setSyncChannel(channel)

      await provisionDefaultCategories()
      expect(postedKeys(channel)).toEqual(['categories'])

      await provisionDefaultCategories()
      expect(channel.postMessage).toHaveBeenCalledTimes(1)
    })

    it('deleteCategory posts categories, plus budgets when a budget was removed', async () => {
      const food = await addCategory({ name: 'Food' })
      const rent = await addCategory({ name: 'Rent' })
      await upsertBudget({
        categoryId: food.id,
        monthlyLimit: 100,
        currency: 'UAH',
      })

      const withBudget = fakeChannel()
      setSyncChannel(withBudget)
      await deleteCategory(food.id)
      expect(postedKeys(withBudget).sort()).toEqual(['budgets', 'categories'])

      const withoutBudget = fakeChannel()
      setSyncChannel(withoutBudget)
      await deleteCategory(rent.id)
      expect(postedKeys(withoutBudget)).toEqual(['categories'])
    })

    it('posts nothing when the mutation fails', async () => {
      mockStore.set('income', new Uint8Array(40))
      const channel = fakeChannel()
      setSyncChannel(channel)

      await expect(
        addIncome({ source: 'A', amount: 1, currency: 'UAH' }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(channel.postMessage).not.toHaveBeenCalled()
    })

    it('a failing channel does not fail a committed write', async () => {
      const channel = fakeChannel()
      channel.postMessage.mockImplementation(() => {
        throw new Error('channel closed')
      })
      setSyncChannel(channel)

      await addIncome({ source: 'Job', amount: 10, currency: 'UAH' })

      expect(await getAllIncome()).toHaveLength(1)
    })

    it('with syncing disabled (null channel) writes still succeed', async () => {
      setSyncChannel(null)

      await addIncome({ source: 'Job', amount: 10, currency: 'UAH' })

      expect(await getAllIncome()).toHaveLength(1)
    })
  })
})
