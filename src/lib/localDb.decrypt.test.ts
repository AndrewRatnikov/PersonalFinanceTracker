// No CONTRACT_GAPs: DecryptError and the mutation behaviour (#1) are fully
// specified in the Interface Contract.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DecryptError,
  addCategory,
  addExpense,
  addIncome,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  provisionDefaultCategories,
  unlockLocalDb,
  updateCategory,
  updateExpense,
  upsertBudget,
  wipeLocalDbKey,
} from '@/lib/localDb'

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
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

const MARCH = '2024-03-15T12:00:00.000Z'
const CHUNK = 'expenses_2024_03'

// 40 bytes of zeros: a Uint8Array that can never be a valid AES-GCM payload.
function garbage(): Uint8Array {
  return new Uint8Array(40)
}

describe('localDb decrypt failures (#1)', () => {
  beforeEach(async () => {
    mockStore.clear()
    unlockLocalDb(
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    )
  })

  describe('mutations on an undecryptable categories store', () => {
    const mutations: Array<[string, () => Promise<unknown>]> = [
      ['addCategory', () => addCategory({ name: 'Food' })],
      ['updateCategory', () => updateCategory({ id: 'x', name: 'Food' })],
      ['deleteCategory', () => deleteCategory('x')],
      ['provisionDefaultCategories', () => provisionDefaultCategories()],
    ]

    it.each(mutations)(
      '%s rejects with DecryptError and leaves the stored bytes untouched',
      async (_name, run) => {
        const bytes = garbage()
        mockStore.set('categories', bytes)

        await expect(run()).rejects.toBeInstanceOf(DecryptError)

        expect(mockStore.get('categories')).toBe(bytes)
      },
    )

    it('exposes the storage key and name on the error', async () => {
      mockStore.set('categories', garbage())

      const err = await addCategory({ name: 'Food' }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(DecryptError)
      expect(err).toBeInstanceOf(Error)
      expect((err as DecryptError).name).toBe('DecryptError')
      expect((err as DecryptError).storageKey).toBe('categories')
    })
  })

  describe('mutations on an undecryptable income / budgets store', () => {
    it('addIncome rejects and keeps the income bytes', async () => {
      const bytes = garbage()
      mockStore.set('income', bytes)

      await expect(
        addIncome({ source: 'Job', amount: 10, currency: 'UAH' }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get('income')).toBe(bytes)
    })

    it('deleteIncome rejects and keeps the income bytes', async () => {
      const bytes = garbage()
      mockStore.set('income', bytes)

      await expect(deleteIncome('x')).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get('income')).toBe(bytes)
    })

    it('upsertBudget rejects and keeps the budgets bytes', async () => {
      const bytes = garbage()
      mockStore.set('budgets', bytes)

      await expect(
        upsertBudget({ categoryId: 'c1', monthlyLimit: 100, currency: 'UAH' }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get('budgets')).toBe(bytes)
    })

    it('deleteBudget rejects and keeps the budgets bytes', async () => {
      const bytes = garbage()
      mockStore.set('budgets', bytes)

      await expect(deleteBudget('x')).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get('budgets')).toBe(bytes)
    })
  })

  describe('mutations on an undecryptable expense chunk', () => {
    it('addExpense rejects and keeps the chunk bytes', async () => {
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)

      await expect(
        addExpense({
          amount: 5,
          currency: 'UAH',
          categoryId: 'c1',
          createdAt: MARCH,
        }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get(CHUNK)).toBe(bytes)
    })

    it('deleteExpense rejects and keeps the chunk bytes', async () => {
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)

      await expect(deleteExpense('x', MARCH)).rejects.toBeInstanceOf(
        DecryptError,
      )

      expect(mockStore.get(CHUNK)).toBe(bytes)
    })

    it('updateExpense rejects with DecryptError (not "not found") and keeps the chunk bytes', async () => {
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)

      await expect(
        updateExpense('x', MARCH, { amount: 9 }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get(CHUNK)).toBe(bytes)
    })

    it('deleteCategory rejects and keeps both stores when a chunk cannot be read', async () => {
      const food = await addCategory({ name: 'Food' })
      const categoriesBefore = mockStore.get('categories')
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)

      await expect(deleteCategory(food.id)).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get(CHUNK)).toBe(bytes)
      expect(mockStore.get('categories')).toBe(categoriesBefore)
    })

    it('a value encrypted under a different key is rejected the same way', async () => {
      const food = await addCategory({ name: 'Food' })
      const created = await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: food.id,
        createdAt: MARCH,
      })
      const chunkBefore = mockStore.get(CHUNK)
      // Unlock with a brand new key: existing data is now undecryptable.
      unlockLocalDb(
        await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      )

      await expect(
        updateExpense(created.id, created.createdAt, { amount: 99 }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get(CHUNK)).toBe(chunkBefore)
    })
  })

  describe('reads', () => {
    it('getAllCategories and getAllIncome reject on undecryptable data', async () => {
      mockStore.set('categories', garbage())
      mockStore.set('income', garbage())

      await expect(getAllCategories()).rejects.toBeInstanceOf(DecryptError)
      await expect(getAllIncome()).rejects.toBeInstanceOf(DecryptError)
    })

    it('getAllExpenses rejects when a chunk is undecryptable', async () => {
      mockStore.set(CHUNK, garbage())

      await expect(getAllExpenses()).rejects.toBeInstanceOf(DecryptError)
    })
  })

  describe('cases that must keep returning empty values', () => {
    it('with no key unlocked, reads return [] and nothing throws', async () => {
      mockStore.set('categories', garbage())
      mockStore.set(CHUNK, garbage())
      wipeLocalDbKey()

      expect(await getAllCategories()).toEqual([])
      expect(await getAllExpenses()).toEqual([])
    })

    it('a missing record reads as empty and a mutation on it succeeds', async () => {
      expect(await getAllCategories()).toEqual([])

      const created = await addCategory({ name: 'Food' })

      expect(created.name).toBe('Food')
      expect(await getAllCategories()).toHaveLength(1)
    })

    it('a non-Uint8Array stored value reads as empty', async () => {
      mockStore.set('categories', 'not-bytes')

      expect(await getAllCategories()).toEqual([])
    })
  })
})
