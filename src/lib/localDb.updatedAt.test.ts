// No CONTRACT_GAPs: updatedAt behaviour per localDb function is specified in
// the Interface Contract (module: localDb changes). Income has no update
// operation (plan CONTRACT_GAP 7), so only create is tested for income.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addCategory,
  addExpense,
  addIncome,
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

const T1 = '2026-06-01T10:00:00.000Z'
const T2 = '2026-06-02T11:30:00.000Z'

beforeEach(async () => {
  mockStore.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T1))
  unlockLocalDb(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('updatedAt on expenses', () => {
  it('addExpense sets updatedAt to now, independent of a backdated createdAt', async () => {
    const cat = await addCategory({ name: 'Food' })

    const created = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: '2026-01-10T00:00:00.000Z',
    })

    expect(created.updatedAt).toBe(T1)
    expect(created.createdAt).toBe('2026-01-10T00:00:00.000Z')
    const stored = await getAllExpenses()
    expect(stored[0].updatedAt).toBe(T1)
  })

  it('updateExpense sets a new updatedAt and keeps createdAt', async () => {
    const cat = await addCategory({ name: 'Food' })
    const created = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: '2026-03-15T12:00:00.000Z',
    })
    vi.setSystemTime(new Date(T2))

    const updated = await updateExpense(created.id, created.createdAt, {
      amount: 9,
    })

    expect(created.updatedAt).toBe(T1)
    expect(updated.updatedAt).toBe(T2)
    expect(updated.createdAt).toBe('2026-03-15T12:00:00.000Z')
    const stored = await getAllExpenses()
    expect(stored[0].updatedAt).toBe(T2)
  })

  it('updateExpense sets updatedAt on a cross-month move too', async () => {
    const cat = await addCategory({ name: 'Food' })
    const created = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: '2026-03-15T12:00:00.000Z',
    })
    vi.setSystemTime(new Date(T2))

    const moved = await updateExpense(created.id, created.createdAt, {
      createdAt: '2026-04-15T12:00:00.000Z',
    })

    expect(moved.updatedAt).toBe(T2)
  })
})

describe('updatedAt on income', () => {
  it('addIncome sets updatedAt to now', async () => {
    const created = await addIncome({
      source: 'Job',
      amount: 100,
      currency: 'USD',
      createdAt: '2026-02-01T00:00:00.000Z',
    })

    expect(created.updatedAt).toBe(T1)
    expect((await getAllIncome())[0].updatedAt).toBe(T1)
  })

  it('gives later entries a later updatedAt', async () => {
    await addIncome({ source: 'A', amount: 1, currency: 'USD' })
    vi.setSystemTime(new Date(T2))
    await addIncome({ source: 'B', amount: 2, currency: 'USD' })

    const income = await getAllIncome()

    expect(income.find((i) => i.source === 'A')?.updatedAt).toBe(T1)
    expect(income.find((i) => i.source === 'B')?.updatedAt).toBe(T2)
  })
})

describe('updatedAt on categories', () => {
  it('addCategory sets updatedAt to now', async () => {
    const created = await addCategory({ name: 'Food' })
    expect(created.updatedAt).toBe(T1)
    expect((await getAllCategories())[0].updatedAt).toBe(T1)
  })

  it('updateCategory refreshes only the updated record', async () => {
    const food = await addCategory({ name: 'Food' })
    const transport = await addCategory({ name: 'Transport' })
    vi.setSystemTime(new Date(T2))

    const updated = await updateCategory({ id: food.id, name: 'Groceries' })

    expect(updated.updatedAt).toBe(T2)
    const all = await getAllCategories()
    expect(all.find((c) => c.id === food.id)?.updatedAt).toBe(T2)
    expect(all.find((c) => c.id === transport.id)?.updatedAt).toBe(T1)
  })

  it('provisionDefaultCategories stamps every default category', async () => {
    await provisionDefaultCategories()

    const all = await getAllCategories()

    expect(all.length).toBeGreaterThan(0)
    for (const c of all) expect(c.updatedAt).toBe(T1)
  })
})

describe('updatedAt on budgets', () => {
  it('upsertBudget sets updatedAt on create', async () => {
    const cat = await addCategory({ name: 'Food' })

    const created = await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 100,
      currency: 'UAH',
    })

    expect(created.updatedAt).toBe(T1)
    expect((await getAllBudgets())[0].updatedAt).toBe(T1)
  })

  it('upsertBudget refreshes updatedAt on update and keeps the id', async () => {
    const cat = await addCategory({ name: 'Food' })
    const created = await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 100,
      currency: 'UAH',
    })
    vi.setSystemTime(new Date(T2))

    const updated = await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 250,
      currency: 'UAH',
    })

    expect(updated.id).toBe(created.id)
    expect(updated.monthlyLimit).toBe(250)
    expect(updated.updatedAt).toBe(T2)
    const all = await getAllBudgets()
    expect(all).toHaveLength(1)
    expect(all[0].updatedAt).toBe(T2)
  })
})
