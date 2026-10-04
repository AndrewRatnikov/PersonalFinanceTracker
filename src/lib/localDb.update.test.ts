// No CONTRACT_GAPs: the Interface Contract for `updateExpense` (src/lib/localDb.ts)
// fully specifies signature, return shape, chunk-move behavior and throw conditions.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addCategory,
  addExpense,
  getAllExpenses,
  getExpensesForRange,
  unlockLocalDb,
  updateExpense,
} from '@/lib/localDb'

// In-memory replacement for idb-keyval, hoisted so it exists before the
// `vi.mock` factory (which itself is hoisted above imports) runs.
const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

// vi.mock: idb-keyval is replaced with an in-memory Map-backed implementation
// of createStore/get/set/clear/keys, per the plan's Tests section.
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

describe('localDb.updateExpense', () => {
  beforeEach(async () => {
    mockStore.clear()
    // Real WebCrypto AES-GCM key, per the plan's unlock procedure.
    unlockLocalDb(
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    )
  })

  describe('criterion 1: same-month update, id unchanged, category resolved', () => {
    it('applies a patch within the same month and resolves the new category', async () => {
      const food = await addCategory({ name: 'Food', icon: '🍔' })
      const transport = await addCategory({ name: 'Transport', icon: '🚌' })
      const created = await addExpense({
        amount: 10,
        currency: 'UAH',
        categoryId: food.id,
        description: 'Lunch',
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      const updated = await updateExpense(created.id, created.createdAt, {
        amount: 25.5,
        categoryId: transport.id,
        description: 'Bus fare',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.amount).toBe(25.5)
      expect(updated.categoryId).toBe(transport.id)
      expect(updated.category?.id).toBe(transport.id)
      expect(updated.category?.name).toBe('Transport')
      expect(updated.description).toBe('Bus fare')
      // createdAt was not patched, so it stays as-is.
      expect(updated.createdAt).toBe('2026-03-15T12:00:00.000Z')

      const marchExpenses = await getExpensesForRange(
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
      )
      expect(marchExpenses).toHaveLength(1)
      expect(marchExpenses[0].id).toBe(created.id)
      expect(marchExpenses[0].amount).toBe(25.5)
    })

    it('leaves omitted patch fields at their existing values', async () => {
      const food = await addCategory({ name: 'Food', icon: '🍔' })
      const created = await addExpense({
        amount: 10,
        currency: 'EUR',
        categoryId: food.id,
        description: 'Lunch',
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      // Patch only the amount; currency, categoryId, description, createdAt
      // must survive unchanged.
      const updated = await updateExpense(created.id, created.createdAt, {
        amount: 99,
      })

      expect(updated.amount).toBe(99)
      expect(updated.currency).toBe('EUR')
      expect(updated.categoryId).toBe(food.id)
      expect(updated.description).toBe('Lunch')
      expect(updated.createdAt).toBe('2026-03-15T12:00:00.000Z')
    })

    it('stores an explicit empty-string description as null', async () => {
      const food = await addCategory({ name: 'Food', icon: '🍔' })
      const created = await addExpense({
        amount: 10,
        currency: 'UAH',
        categoryId: food.id,
        description: 'Lunch',
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      const updated = await updateExpense(created.id, created.createdAt, {
        description: '',
      })

      expect(updated.description).toBeNull()
    })
  })

  describe('criterion 2: cross-month chunk move', () => {
    it('moves the record from the old month chunk to the new one, keeping the id, when createdAt crosses a month boundary', async () => {
      const food = await addCategory({ name: 'Food', icon: '🍔' })
      const created = await addExpense({
        amount: 10,
        currency: 'UAH',
        categoryId: food.id,
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      const updated = await updateExpense(created.id, created.createdAt, {
        createdAt: '2026-04-15T12:00:00.000Z',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.createdAt).toBe('2026-04-15T12:00:00.000Z')

      const marchExpenses = await getExpensesForRange(
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
      )
      expect(marchExpenses.find((e) => e.id === created.id)).toBeUndefined()

      const aprilExpenses = await getExpensesForRange(
        '2026-04-01T00:00:00.000Z',
        '2026-04-30T23:59:59.999Z',
      )
      const moved = aprilExpenses.find((e) => e.id === created.id)
      expect(moved).toBeTruthy()
      expect(moved?.id).toBe(created.id)

      // The record exists exactly once overall — not duplicated across chunks.
      const all = await getAllExpenses()
      expect(all.filter((e) => e.id === created.id)).toHaveLength(1)
    })
  })

  describe('criterion 3: throws on unknown id, invalid date, unknown categoryId; no writes performed', () => {
    it('throws when the id does not exist in the chunk for originalCreatedAt', async () => {
      const food = await addCategory({ name: 'Food' })
      await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: food.id,
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      await expect(
        updateExpense('nonexistent-id', '2026-03-15T12:00:00.000Z', {
          amount: 20,
        }),
      ).rejects.toThrow(/not found/i)

      // No write happened: the chunk is unchanged.
      const marchExpenses = await getExpensesForRange(
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
      )
      expect(marchExpenses).toHaveLength(1)
      expect(marchExpenses[0].amount).toBe(5)
    })

    it('throws when the resulting createdAt is not a valid date', async () => {
      const food = await addCategory({ name: 'Food' })
      const created = await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: food.id,
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      await expect(
        updateExpense(created.id, created.createdAt, {
          createdAt: 'not-a-date',
        }),
      ).rejects.toThrow(/invalid createdAt/i)

      const marchExpenses = await getExpensesForRange(
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
      )
      expect(marchExpenses[0].createdAt).toBe('2026-03-15T12:00:00.000Z')
    })

    it('throws when patch.categoryId does not match any existing category', async () => {
      const food = await addCategory({ name: 'Food' })
      const created = await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: food.id,
        createdAt: '2026-03-15T12:00:00.000Z',
      })

      await expect(
        updateExpense(created.id, created.createdAt, {
          categoryId: 'unknown-category-id',
        }),
      ).rejects.toThrow(/unknown categoryId/i)

      const marchExpenses = await getExpensesForRange(
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
      )
      expect(marchExpenses[0].categoryId).toBe(food.id)
    })
  })
})
