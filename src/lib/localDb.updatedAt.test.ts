// No CONTRACT_GAPs: updatedAt behaviour per localDb function is specified in
// the Interface Contract (module: localDb changes). Income has no update
// operation (plan CONTRACT_GAP 7), so only create is tested for income.
// Every user write goes through setMany, so the idb-keyval mock has one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptValue } from '@/lib/crypto'
import {
  addCategory,
  addExpense,
  addIncome,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getLocalDbKey,
  provisionDefaultCategories,
  undeleteExpense,
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
  setMany: (entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) mockStore.set(key, value)
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
const T3 = '2026-06-03T09:00:00.000Z'

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

  it('undeleteExpense sets updatedAt to the undelete time', async () => {
    const cat = await addCategory({ name: 'Food' })
    const created = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: '2026-03-15T12:00:00.000Z',
    })
    vi.setSystemTime(new Date(T2))
    await deleteExpense(created.id, created.createdAt)
    vi.setSystemTime(new Date(T3))

    const revived = await undeleteExpense(created.id, created.createdAt)

    expect(revived.updatedAt).toBe(T3)
    expect((await getAllExpenses())[0].updatedAt).toBe(T3)
  })
})

describe('updatedAt on income', () => {
  it('addIncome sets updatedAt to now', async () => {
    const created = await addIncome({
      categoryId: 'ic1',
      amount: 100,
      currency: 'USD',
      createdAt: '2026-02-01T00:00:00.000Z',
    })

    expect(created.updatedAt).toBe(T1)
    expect((await getAllIncome())[0].updatedAt).toBe(T1)
  })

  it('gives later entries a later updatedAt', async () => {
    await addIncome({ categoryId: 'ic-a', amount: 1, currency: 'USD' })
    vi.setSystemTime(new Date(T2))
    await addIncome({ categoryId: 'ic-b', amount: 2, currency: 'USD' })

    const income = await getAllIncome()

    expect(income.find((i) => i.categoryId === 'ic-a')?.updatedAt).toBe(T1)
    expect(income.find((i) => i.categoryId === 'ic-b')?.updatedAt).toBe(T2)
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

describe('updatedAt on deletes', () => {
  // A delete is a change: the tombstone carries deletedAt = updatedAt = now, so
  // it wins a newest-wins merge against the live copy on another device.
  async function rawList(key: string): Promise<Array<Record<string, unknown>>> {
    const dek = getLocalDbKey()
    const raw = mockStore.get(key)
    if (!dek || !(raw instanceof Uint8Array)) throw new Error(`no ${key}`)
    return (await decryptValue(dek, raw)) as Array<Record<string, unknown>>
  }

  it('deleteExpense stamps deletedAt and updatedAt with the delete time', async () => {
    const cat = await addCategory({ name: 'Food' })
    const created = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: '2026-03-15T12:00:00.000Z',
    })
    vi.setSystemTime(new Date(T2))

    await deleteExpense(created.id, created.createdAt)

    const [tombstone] = await rawList('expenses_2026_03')
    expect(tombstone.id).toBe(created.id)
    expect(tombstone.deletedAt).toBe(T2)
    expect(tombstone.updatedAt).toBe(T2)
    expect(tombstone.createdAt).toBe('2026-03-15T12:00:00.000Z')
  })

  it('deleteIncome and deleteBudget stamp the delete time', async () => {
    const cat = await addCategory({ name: 'Food' })
    const income = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    const budget = await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 10,
      currency: 'UAH',
    })
    vi.setSystemTime(new Date(T3))

    await deleteIncome(income.id)
    await deleteBudget(budget.id)

    const [incomeTomb] = await rawList('income')
    const [budgetTomb] = await rawList('budgets')
    expect(incomeTomb.deletedAt).toBe(T3)
    expect(incomeTomb.updatedAt).toBe(T3)
    expect(budgetTomb.deletedAt).toBe(T3)
    expect(budgetTomb.updatedAt).toBe(T3)
  })

  it('deleteCategory stamps the category and its budget with the same time', async () => {
    const cat = await addCategory({ name: 'Food' })
    await upsertBudget({ categoryId: cat.id, monthlyLimit: 10, currency: 'UAH' })
    vi.setSystemTime(new Date(T2))

    await deleteCategory(cat.id)

    const [catTomb] = await rawList('categories')
    const [budgetTomb] = await rawList('budgets')
    expect(catTomb.deletedAt).toBe(T2)
    expect(catTomb.updatedAt).toBe(T2)
    expect(budgetTomb.deletedAt).toBe(T2)
    expect(budgetTomb.updatedAt).toBe(T2)
  })
})
