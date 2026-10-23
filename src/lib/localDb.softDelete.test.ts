// CONTRACT_GAP 1 (plan): deleting a missing or already-deleted record writes
//   nothing, announces nothing and resolves. Tested as stated in the plan.
// CONTRACT_GAP 3 (plan): compactTombstones announces the changed keys but sets
//   no lastDataChangeAt and requests no conversion. Tested as stated.
// CONTRACT_GAP: the plan does not say whether updateExpense accepts a patch
//   whose categoryId points at a deleted category. Not tested.
//
// Integration style (as localDb.incomeCategories.test.ts): real crypto and
// real localDb, idb-keyval backed by a Map. Records are read back raw by
// decrypting the stored blobs with the key the test unlocked the db with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BudgetEntry,
  Category,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { SyncChannel } from '@/lib/syncChannel'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  addRecurring,
  clearLocalDb,
  compactTombstones,
  confirmRecurringOccurrence,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  deleteIncomeCategory,
  deleteRecurring,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getDueRecurring,
  getExpensesForRange,
  getLocalRev,
  onConversionNeeded,
  processDueRecurring,
  provisionDefaultCategories,
  setRecurringPaused,
  skipRecurringOccurrence,
  undeleteExpense,
  unlockLocalDb,
  updateCategory,
  updateExpense,
  updateIncomeCategory,
  updateRecurring,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { setManyCalls: [] as Array<Array<string>> },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    ctl.setManyCalls.push(entries.map(([key]) => key))
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

const T0 = '2026-01-01T09:00:00.000Z'
const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T11:30:00.000Z'
const T3 = '2026-03-03T12:45:00.000Z'
const MARCH_15 = '2026-03-15T12:00:00.000Z'
const MARCH_16 = '2026-03-16T12:00:00.000Z'
const MARCH_CHUNK = 'expenses_2026_03'

let dek: CryptoKey

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
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

async function readRaw<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

function expenseInput(categoryId: string, createdAt = MARCH_15, amount = 5) {
  return { amount, currency: 'UAH' as const, categoryId, createdAt }
}

function recurringItem(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'r1',
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'cat1',
    description: 'Gym',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-02-15',
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

beforeEach(async () => {
  mockStore.clear()
  ctl.setManyCalls.length = 0
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setSyncChannel(undefined)
})

// ── Each type keeps the record and hides it ───────────────────────────────────

describe('a delete keeps the record with deletedAt = updatedAt = now', () => {
  it('expense: stays in its month chunk, in place, and the readers skip it', async () => {
    const cat = await addCategory({ name: 'Food' })
    const a = await addExpense(expenseInput(cat.id, MARCH_15, 5))
    const b = await addExpense(expenseInput(cat.id, MARCH_16, 6))
    setNow(T2)

    await deleteExpense(a.id, a.createdAt)

    const raw = await readRaw<Expense>(MARCH_CHUNK)
    expect(raw.map((e) => e.id)).toEqual([a.id, b.id])
    expect(raw[0].deletedAt).toBe(T2)
    expect(raw[0].updatedAt).toBe(T2)
    expect(raw[0].amount).toBe(5)
    expect(raw[0].createdAt).toBe(MARCH_15)
    expect('deletedAt' in raw[1]).toBe(false)
    expect(raw[1].updatedAt).toBe(T1)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([b.id])
    expect(
      (
        await getExpensesForRange(
          '2026-03-01T00:00:00.000Z',
          '2026-03-31T23:59:59.999Z',
        )
      ).map((e) => e.id),
    ).toEqual([b.id])
  })

  it('income', async () => {
    const keep = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    const drop = await addIncome({ categoryId: 'ic1', amount: 2, currency: 'UAH' })
    setNow(T2)

    await deleteIncome(drop.id)

    const raw = await readRaw<IncomeEntry>('income')
    expect(raw.map((i) => i.id)).toEqual([keep.id, drop.id])
    expect(raw[1].deletedAt).toBe(T2)
    expect(raw[1].updatedAt).toBe(T2)
    expect(raw[1].amount).toBe(2)
    expect((await getAllIncome()).map((i) => i.id)).toEqual([keep.id])
  })

  it('expense category', async () => {
    const keep = await addCategory({ name: 'Rent' })
    const drop = await addCategory({ name: 'Food' })
    setNow(T2)

    await deleteCategory(drop.id)

    const raw = await readRaw<Category>('categories')
    expect(raw.map((c) => c.id)).toEqual([keep.id, drop.id])
    expect(raw[1].deletedAt).toBe(T2)
    expect(raw[1].updatedAt).toBe(T2)
    expect(raw[1].name).toBe('Food')
    expect((await getAllCategories()).map((c) => c.id)).toEqual([keep.id])
  })

  it('income category', async () => {
    const keep = await addIncomeCategory({ name: 'Gifts' })
    const drop = await addIncomeCategory({ name: 'Salary' })
    setNow(T2)

    await deleteIncomeCategory(drop.id)

    const raw = await readRaw<Category>('incomeCategories')
    expect(raw.map((c) => c.id)).toEqual([keep.id, drop.id])
    expect(raw[1].deletedAt).toBe(T2)
    expect(raw[1].updatedAt).toBe(T2)
    expect((await getAllIncomeCategories()).map((c) => c.id)).toEqual([keep.id])
  })

  it('budget', async () => {
    const a = await upsertBudget({ categoryId: 'c1', monthlyLimit: 10, currency: 'UAH' })
    const b = await upsertBudget({ categoryId: 'c2', monthlyLimit: 20, currency: 'UAH' })
    setNow(T2)

    await deleteBudget(a.id)

    const raw = await readRaw<BudgetEntry>('budgets')
    expect(raw.map((x) => x.id)).toEqual([a.id, b.id])
    expect(raw[0].deletedAt).toBe(T2)
    expect(raw[0].updatedAt).toBe(T2)
    expect(raw[0].monthlyLimit).toBe(10)
    expect((await getAllBudgets()).map((x) => x.id)).toEqual([b.id])
  })

  it('recurring item', async () => {
    await seed('recurring', [
      recurringItem({ id: 'keep' }),
      recurringItem({ id: 'drop', mode: 'ask' }),
    ])
    setNow(T2)

    await deleteRecurring('drop')

    const raw = await readRaw<RecurringItem>('recurring')
    expect(raw.map((r) => r.id)).toEqual(['keep', 'drop'])
    expect(raw[1].deletedAt).toBe(T2)
    expect(raw[1].updatedAt).toBe(T2)
    expect(raw[1].mode).toBe('ask')
    expect((await getAllRecurring()).map((r) => r.id)).toEqual(['keep'])
    expect(await getDueRecurring('2026-03-20')).toEqual([])
  })

  it('a different clock gives a different stamp (not a fixed value)', async () => {
    const cat = await addCategory({ name: 'Food' })
    setNow(T3)

    await deleteCategory(cat.id)

    const [raw] = await readRaw<Category>('categories')
    expect(raw.deletedAt).toBe(T3)
    expect(raw.updatedAt).toBe(T3)
  })
})

describe('deleting something that is not there, or already deleted', () => {
  it('a second delete of the same expense writes and announces nothing', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    setNow(T2)
    await deleteExpense(e.id, e.createdAt)
    const blob = mockStore.get(MARCH_CHUNK)
    const rev = await getLocalRev()
    ctl.setManyCalls.length = 0
    const channel = fakeChannel()
    setSyncChannel(channel)
    setNow(T3)

    await expect(deleteExpense(e.id, e.createdAt)).resolves.toBeUndefined()

    expect(mockStore.get(MARCH_CHUNK)).toBe(blob)
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(await getLocalRev()).toBe(rev)
    const [raw] = await readRaw<Expense>(MARCH_CHUNK)
    expect(raw.deletedAt).toBe(T2)
  })

  it('an unknown id resolves and writes nothing, for every type', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id))
    const inc = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    const budget = await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 1,
      currency: 'UAH',
    })
    const snapshot = new Map(mockStore)
    ctl.setManyCalls.length = 0
    const channel = fakeChannel()
    setSyncChannel(channel)

    await deleteExpense('missing', MARCH_15)
    await deleteIncome('missing')
    await deleteBudget('missing')
    await deleteRecurring('missing')

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    for (const [key, value] of snapshot) expect(mockStore.get(key)).toBe(value)
    expect((await getAllIncome()).map((i) => i.id)).toEqual([inc.id])
    expect((await getAllBudgets()).map((b) => b.id)).toEqual([budget.id])
  })

  it('deleting a deleted category, budget, income or recurring item changes nothing', async () => {
    const cat = await addCategory({ name: 'Food' })
    const inc = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    const budget = await upsertBudget({
      categoryId: 'other',
      monthlyLimit: 1,
      currency: 'UAH',
    })
    await seed('recurring', [recurringItem()])
    setNow(T2)
    await deleteCategory(cat.id)
    await deleteIncome(inc.id)
    await deleteBudget(budget.id)
    await deleteRecurring('r1')
    const snapshot = new Map(mockStore)
    ctl.setManyCalls.length = 0
    setNow(T3)

    await deleteCategory(cat.id)
    await deleteIncome(inc.id)
    await deleteBudget(budget.id)
    await deleteRecurring('r1')

    expect(ctl.setManyCalls).toHaveLength(0)
    for (const key of ['categories', 'income', 'budgets', 'recurring']) {
      expect(mockStore.get(key)).toBe(snapshot.get(key))
    }
  })
})

// ── Refusals count live records only ──────────────────────────────────────────

describe('the delete refusals count live records only', () => {
  it('deleteCategory is refused while live expenses use it, with the count', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id))
    await addExpense(expenseInput(cat.id, MARCH_16))
    const before = mockStore.get('categories')

    await expect(deleteCategory(cat.id)).rejects.toThrow('2 expenses use this category')

    expect(mockStore.get('categories')).toBe(before)
  })

  it('a category used only by deleted expenses can be deleted', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    await expect(deleteCategory(cat.id)).rejects.toThrow('1 expense use this category')
    await deleteExpense(e.id, e.createdAt)

    await deleteCategory(cat.id)

    expect(await getAllCategories()).toEqual([])
    const [raw] = await readRaw<Category>('categories')
    expect(raw.deletedAt).toBeDefined()
  })

  it('counts only the live ones when some expenses are deleted', async () => {
    const cat = await addCategory({ name: 'Food' })
    const gone = await addExpense(expenseInput(cat.id))
    await addExpense(expenseInput(cat.id, MARCH_16))
    await deleteExpense(gone.id, gone.createdAt)

    await expect(deleteCategory(cat.id)).rejects.toThrow('1 expense use this category')
  })

  it('counts expenses in every month chunk', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id, '2026-01-10T12:00:00.000Z'))
    const april = await addExpense(expenseInput(cat.id, '2026-04-10T12:00:00.000Z'))
    await deleteExpense(april.id, april.createdAt)

    await expect(deleteCategory(cat.id)).rejects.toThrow('1 expense use this category')
  })

  it('a deleted recurring item no longer blocks deleteCategory, a live one still does', async () => {
    const cat = await addCategory({ name: 'Gym' })
    await seed('recurring', [
      recurringItem({ id: 'live', categoryId: cat.id }),
      recurringItem({ id: 'dead', categoryId: cat.id, deletedAt: T0 }),
    ])

    await expect(deleteCategory(cat.id)).rejects.toThrow('Used by 1 recurring item')

    await deleteRecurring('live')
    await deleteCategory(cat.id)
    expect(await getAllCategories()).toEqual([])
  })

  it('deleteIncomeCategory counts live income entries and live income items only', async () => {
    const cat = await addIncomeCategory({ name: 'Salary' })
    const entry = await addIncome({ categoryId: cat.id, amount: 1, currency: 'UAH' })
    await seed('recurring', [
      recurringItem({ id: 'inc', kind: 'income', categoryId: cat.id }),
    ])

    await expect(deleteIncomeCategory(cat.id)).rejects.toThrow(
      '1 income entry uses this category',
    )
    await deleteIncome(entry.id)
    await expect(deleteIncomeCategory(cat.id)).rejects.toThrow('Used by 1 recurring item')
    await deleteRecurring('inc')

    await deleteIncomeCategory(cat.id)

    expect(await getAllIncomeCategories()).toEqual([])
  })

  it('deleteCategory also tombstones the live budgets of that category, in one step', async () => {
    const food = await addCategory({ name: 'Food' })
    const rent = await addCategory({ name: 'Rent' })
    const foodBudget = await upsertBudget({
      categoryId: food.id,
      monthlyLimit: 10,
      currency: 'UAH',
    })
    const rentBudget = await upsertBudget({
      categoryId: rent.id,
      monthlyLimit: 20,
      currency: 'UAH',
    })
    setNow(T2)
    ctl.setManyCalls.length = 0

    await deleteCategory(food.id)

    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(['budgets', 'categories', 'meta:sync'])
    const budgets = await readRaw<BudgetEntry>('budgets')
    expect(budgets.find((b) => b.id === foodBudget.id)?.deletedAt).toBe(T2)
    expect(budgets.find((b) => b.id === foodBudget.id)?.updatedAt).toBe(T2)
    expect('deletedAt' in (budgets.find((b) => b.id === rentBudget.id) ?? {})).toBe(false)
    expect((await getAllBudgets()).map((b) => b.id)).toEqual([rentBudget.id])
  })

  it('a budget that was already deleted keeps its own deletedAt when its category is deleted later', async () => {
    const food = await addCategory({ name: 'Food' })
    const first = await upsertBudget({
      categoryId: food.id,
      monthlyLimit: 10,
      currency: 'UAH',
    })
    setNow(T2)
    await deleteBudget(first.id)
    setNow(T3)

    await deleteCategory(food.id)

    const [raw] = await readRaw<BudgetEntry>('budgets')
    expect(raw.deletedAt).toBe(T2)
    expect(raw.updatedAt).toBe(T2)
  })

  it('a refused delete writes nothing', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id))
    ctl.setManyCalls.length = 0
    const channel = fakeChannel()
    setSyncChannel(channel)

    await expect(deleteCategory(cat.id)).rejects.toThrow()

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
  })
})

// ── Names and ids ─────────────────────────────────────────────────────────────

describe('re-adding the name of a deleted category creates a new category', () => {
  it('expense categories: a new id, the tombstone stays', async () => {
    const first = await addCategory({ name: 'Food' })
    await deleteCategory(first.id)

    const second = await addCategory({ name: ' food ' })

    expect(second.id).not.toBe(first.id)
    expect(second.name).toBe('food')
    expect((await getAllCategories()).map((c) => c.id)).toEqual([second.id])
    const raw = await readRaw<Category>('categories')
    expect(raw.map((c) => c.id)).toEqual([first.id, second.id])
    expect(raw[0].deletedAt).toBeDefined()
    expect('deletedAt' in raw[1]).toBe(false)
  })

  it('income categories too', async () => {
    const first = await addIncomeCategory({ name: 'Salary' })
    await deleteIncomeCategory(first.id)

    const second = await addIncomeCategory({ name: 'Salary' })

    expect(second.id).not.toBe(first.id)
    expect((await getAllIncomeCategories()).map((c) => c.id)).toEqual([second.id])
  })

  it('a live category still blocks the same name', async () => {
    await addCategory({ name: 'Food' })
    const other = await addCategory({ name: 'Rent' })
    await deleteCategory(other.id)

    await expect(addCategory({ name: 'FOOD' })).rejects.toThrow(/already exists/)
  })

  it('renaming a category to the name of a deleted one is allowed', async () => {
    const dead = await addCategory({ name: 'Food' })
    const live = await addCategory({ name: 'Meals' })
    await deleteCategory(dead.id)

    const renamed = await updateCategory({ id: live.id, name: 'Food' })

    expect(renamed.name).toBe('Food')
    expect(renamed.id).toBe(live.id)
  })

  it('renaming an income category to a deleted name is allowed too', async () => {
    const dead = await addIncomeCategory({ name: 'Salary' })
    const live = await addIncomeCategory({ name: 'Wages' })
    await deleteIncomeCategory(dead.id)

    const renamed = await updateIncomeCategory({ id: live.id, name: 'Salary' })

    expect(renamed.name).toBe('Salary')
  })

  it('upsertBudget after a delete creates a new budget with a new id', async () => {
    const first = await upsertBudget({ categoryId: 'c1', monthlyLimit: 10, currency: 'UAH' })
    await deleteBudget(first.id)

    const second = await upsertBudget({ categoryId: 'c1', monthlyLimit: 30, currency: 'UAH' })

    expect(second.id).not.toBe(first.id)
    expect((await getAllBudgets()).map((b) => b.id)).toEqual([second.id])
    const raw = await readRaw<BudgetEntry>('budgets')
    expect(raw.map((b) => b.id)).toEqual([first.id, second.id])
  })

  it('upsertBudget still updates the live budget of the category in place', async () => {
    const first = await upsertBudget({ categoryId: 'c1', monthlyLimit: 10, currency: 'UAH' })

    const second = await upsertBudget({ categoryId: 'c1', monthlyLimit: 30, currency: 'UAH' })

    expect(second.id).toBe(first.id)
    expect(await readRaw('budgets')).toHaveLength(1)
  })

  it('provisionDefaultCategories treats a store with only deleted categories as empty', async () => {
    await seed('categories', [
      { id: 'old', name: 'Food', icon: null, updatedAt: T0, deletedAt: T0 },
    ])

    await provisionDefaultCategories()

    expect(await getAllCategories()).toHaveLength(6)
    const raw = await readRaw<Category>('categories')
    expect(raw).toHaveLength(7)
    expect(raw[0].id).toBe('old')
  })

  it('provisionDefaultCategories does nothing while a live category exists', async () => {
    await seed('categories', [
      { id: 'old', name: 'Food', icon: null, updatedAt: T0, deletedAt: T0 },
      { id: 'live', name: 'Mine', icon: null, updatedAt: T0 },
    ])
    const before = mockStore.get('categories')

    await provisionDefaultCategories()

    expect(mockStore.get('categories')).toBe(before)
  })
})

// ── A deleted record behaves like a missing one ───────────────────────────────

describe('mutations treat a deleted record as missing', () => {
  it('updateExpense says "not found" and writes nothing', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    await deleteExpense(e.id, e.createdAt)
    const blob = mockStore.get(MARCH_CHUNK)
    ctl.setManyCalls.length = 0

    await expect(
      updateExpense(e.id, e.createdAt, { amount: 99 }),
    ).rejects.toThrow(/not found/i)

    expect(mockStore.get(MARCH_CHUNK)).toBe(blob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('updateCategory and updateIncomeCategory give category-not-found before writing', async () => {
    const cat = await addCategory({ name: 'Food' })
    const income = await addIncomeCategory({ name: 'Salary' })
    await deleteCategory(cat.id)
    await deleteIncomeCategory(income.id)
    const categoriesBlob = mockStore.get('categories')
    const incomeBlob = mockStore.get('incomeCategories')
    ctl.setManyCalls.length = 0

    await expect(updateCategory({ id: cat.id, name: 'Meals' })).rejects.toMatchObject({
      code: 'category-not-found',
    })
    await expect(
      updateIncomeCategory({ id: income.id, name: 'Wages' }),
    ).rejects.toMatchObject({ code: 'category-not-found' })

    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(mockStore.get('incomeCategories')).toBe(incomeBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('updateCategory with an unknown id fails before writing too', async () => {
    await addCategory({ name: 'Food' })
    const blob = mockStore.get('categories')
    ctl.setManyCalls.length = 0

    await expect(updateCategory({ id: 'nope', name: 'X' })).rejects.toMatchObject({
      code: 'category-not-found',
    })

    expect(mockStore.get('categories')).toBe(blob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('recurring mutations give recurring-not-found for a deleted item', async () => {
    await seed('recurring', [
      recurringItem({ id: 'dead', mode: 'ask', deletedAt: T0, categoryId: 'cat1' }),
    ])
    await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
    const blob = mockStore.get('recurring')
    ctl.setManyCalls.length = 0

    await expect(updateRecurring('dead', { amount: 5 })).rejects.toMatchObject({
      code: 'recurring-not-found',
    })
    await expect(setRecurringPaused('dead', true)).rejects.toMatchObject({
      code: 'recurring-not-found',
    })
    await expect(
      confirmRecurringOccurrence('dead', '2026-02-15'),
    ).rejects.toMatchObject({ code: 'recurring-not-found' })
    await expect(
      skipRecurringOccurrence('dead', '2026-02-15'),
    ).rejects.toMatchObject({ code: 'recurring-not-found' })

    expect(mockStore.get('recurring')).toBe(blob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('processDueRecurring skips a deleted item', async () => {
    await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
    await seed('recurring', [
      recurringItem({ id: 'dead', deletedAt: T0 }),
      recurringItem({ id: 'live' }),
    ])

    const result = await processDueRecurring('2026-04-20')

    expect(result.itemsTouched).toBe(1)
    const expenses = await getAllExpenses()
    expect(expenses.every((e) => e.recurringId === 'live')).toBe(true)
    expect(expenses).toHaveLength(3)
  })

  it('addRecurring refuses a deleted category like an unknown one', async () => {
    const cat = await addCategory({ name: 'Gym' })
    await deleteCategory(cat.id)

    await expect(
      addRecurring(
        {
          kind: 'expense',
          amount: 5,
          currency: 'UAH',
          categoryId: cat.id,
          frequency: { unit: 'month', interval: 1 },
          startDate: '2026-02-15',
          end: { type: 'never' },
          mode: 'auto',
        },
        { createThroughToday: false, today: '2026-03-01' },
      ),
    ).rejects.toThrow('Category not found')
  })
})

describe('the category joins ignore deleted categories', () => {
  it('an expense of a deleted category has no joined category', async () => {
    await seed('categories', [
      { id: 'dead', name: 'Gone', icon: null, updatedAt: T0, deletedAt: T0 },
      { id: 'live', name: 'Here', icon: null, updatedAt: T0 },
    ])
    await seed(MARCH_CHUNK, [
      { id: 'e1', amount: 1, currency: 'UAH', categoryId: 'dead', createdAt: MARCH_15 },
      { id: 'e2', amount: 2, currency: 'UAH', categoryId: 'live', createdAt: MARCH_16 },
    ])

    const expenses = await getAllExpenses()

    expect(expenses.find((e) => e.id === 'e1')?.category).toBeUndefined()
    expect(expenses.find((e) => e.id === 'e2')?.category?.name).toBe('Here')
  })

  it('an income entry of a deleted income category has no joined category', async () => {
    await seed('incomeCategories', [
      { id: 'dead', name: 'Gone', icon: null, updatedAt: T0, deletedAt: T0 },
    ])
    await seed('income', [
      { id: 'i1', categoryId: 'dead', amount: 1, currency: 'UAH', createdAt: MARCH_15 },
    ])

    const [entry] = await getAllIncome()

    expect(entry.category).toBeUndefined()
  })

  it('a budget of a deleted category gets an empty name', async () => {
    await seed('categories', [
      { id: 'dead', name: 'Gone', icon: '💀', updatedAt: T0, deletedAt: T0 },
    ])
    await seed('budgets', [
      { id: 'b1', categoryId: 'dead', monthlyLimit: 10, currency: 'UAH', updatedAt: T0 },
    ])

    const [budget] = await getAllBudgets()

    expect(budget.categoryName).toBe('')
    expect(budget.categoryIcon).toBeNull()
  })

  it('a recurring item whose category was deleted is skipped like one with a missing category', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seed('categories', [
      { id: 'cat1', name: 'Gym', icon: null, updatedAt: T0, deletedAt: T0 },
    ])
    await seed('recurring', [recurringItem()])

    const result = await processDueRecurring('2026-04-20')

    expect(result).toEqual({ created: 0, itemsTouched: 0 })
    expect(warn).toHaveBeenCalled()
  })
})

// ── Undelete ──────────────────────────────────────────────────────────────────

describe('undeleteExpense', () => {
  it('clears deletedAt, bumps updatedAt and brings the expense back', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    setNow(T2)
    await deleteExpense(e.id, e.createdAt)
    expect(await getAllExpenses()).toEqual([])
    setNow(T3)

    const revived = await undeleteExpense(e.id, e.createdAt)

    expect(revived.id).toBe(e.id)
    expect(revived.updatedAt).toBe(T3)
    expect(revived.deletedAt).toBeUndefined()
    expect(revived.category?.name).toBe('Food')
    expect('rev' in revived).toBe(false)
    const [raw] = await readRaw<Expense>(MARCH_CHUNK)
    expect('deletedAt' in raw).toBe(false)
    expect(raw.updatedAt).toBe(T3)
    expect(raw.amount).toBe(5)
    expect((await getAllExpenses()).map((x) => x.id)).toEqual([e.id])
  })

  it('stamps a new rev in the same setMany as meta:sync', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    await deleteExpense(e.id, e.createdAt)
    const rev = await getLocalRev()
    ctl.setManyCalls.length = 0

    await undeleteExpense(e.id, e.createdAt)

    expect(await getLocalRev()).toBe(rev + 1)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual([MARCH_CHUNK, 'meta:sync'])
    const [raw] = await readRaw<Expense & { rev?: number }>(MARCH_CHUNK)
    expect(raw.rev).toBe(rev + 1)
  })

  it('an expense that is already live is returned unchanged and nothing is written', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    const blob = mockStore.get(MARCH_CHUNK)
    const rev = await getLocalRev()
    ctl.setManyCalls.length = 0
    setNow(T3)

    const result = await undeleteExpense(e.id, e.createdAt)

    expect(result.id).toBe(e.id)
    expect(result.updatedAt).toBe(T1)
    expect(mockStore.get(MARCH_CHUNK)).toBe(blob)
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(await getLocalRev()).toBe(rev)
  })

  it('an unknown id is an error and nothing is written', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id))
    ctl.setManyCalls.length = 0

    await expect(undeleteExpense('missing-id', MARCH_15)).rejects.toThrow(
      'undeleteExpense: expense not found: missing-id',
    )

    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('announces the chunk and asks for a conversion like any other expense write', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    await deleteExpense(e.id, e.createdAt)
    const channel = fakeChannel()
    setSyncChannel(channel)
    const listener = vi.fn()
    const stop = onConversionNeeded(listener)

    await undeleteExpense(e.id, e.createdAt)
    stop()

    expect(postedKeys(channel)).toEqual([MARCH_CHUNK])
    expect(listener).toHaveBeenCalled()
  })

  it('a DecryptError propagates and the chunk is not touched', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set(MARCH_CHUNK, garbage)

    await expect(undeleteExpense('x', MARCH_15)).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get(MARCH_CHUNK)).toBe(garbage)
  })
})

// ── Real removal ──────────────────────────────────────────────────────────────

describe('compactTombstones', () => {
  const JAN_10 = '2026-01-10T00:00:00.000Z'
  const MAY_10 = '2026-05-10T00:00:00.000Z'
  const CUTOFF = '2026-03-01T00:00:00.000Z'

  // Old tombstones (Jan 10): c1, e1, i1, r1. New tombstones (May 10): e2, b1.
  async function buildStore() {
    setNow(T0)
    const c1 = await addCategory({ name: 'Unused' })
    const c2 = await addCategory({ name: 'Used' })
    const e1 = await addExpense(expenseInput(c2.id, '2026-01-05T12:00:00.000Z'))
    const e2 = await addExpense(expenseInput(c2.id, '2026-04-05T12:00:00.000Z', 7))
    await addExpense(expenseInput(c2.id, '2026-04-06T12:00:00.000Z', 8))
    const i1 = await addIncome({ categoryId: 'ic1', amount: 3, currency: 'UAH' })
    await addIncome({ categoryId: 'ic1', amount: 4, currency: 'UAH' })
    const b1 = await upsertBudget({ categoryId: c2.id, monthlyLimit: 9, currency: 'UAH' })
    await seed('recurring', [recurringItem({ id: 'r1', categoryId: c2.id })])
    setNow(new Date(JAN_10).toISOString())
    await deleteCategory(c1.id)
    await deleteExpense(e1.id, e1.createdAt)
    await deleteIncome(i1.id)
    await deleteRecurring('r1')
    setNow(new Date(MAY_10).toISOString())
    await deleteExpense(e2.id, e2.createdAt)
    await deleteBudget(b1.id)
    return { c1, c2, e1, e2, i1, b1 }
  }

  it('removes the tombstones older than the cut-off, from every type, and keeps the rest', async () => {
    const s = await buildStore()
    setNow(T3)

    const removed = await compactTombstones(CUTOFF)

    expect(removed).toBe(4)
    expect((await readRaw<Category>('categories')).map((c) => c.id)).toEqual([s.c2.id])
    expect(await readRaw<Expense>('expenses_2026_01')).toEqual([])
    expect((await readRaw<IncomeEntry>('income')).map((i) => i.amount)).toEqual([4])
    expect(await readRaw<RecurringItem>('recurring')).toEqual([])
    // The newer tombstones and the live records are still there.
    const april = await readRaw<Expense>('expenses_2026_04')
    expect(april.map((e) => e.id)).toContain(s.e2.id)
    expect(april).toHaveLength(2)
    expect((await readRaw<BudgetEntry>('budgets')).map((b) => b.id)).toEqual([s.b1.id])
  })

  it('writes only the changed keys, in one setMany, and leaves the others byte-identical', async () => {
    await buildStore()
    const aprilBlob = mockStore.get('expenses_2026_04')
    const budgetsBlob = mockStore.get('budgets')
    const incomeCategoriesBlob = mockStore.get('incomeCategories')
    ctl.setManyCalls.length = 0

    await compactTombstones(CUTOFF)

    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual([
      'categories',
      'expenses_2026_01',
      'income',
      'recurring',
    ])
    expect(mockStore.get('expenses_2026_04')).toBe(aprilBlob)
    expect(mockStore.get('budgets')).toBe(budgetsBlob)
    expect(mockStore.get('incomeCategories')).toBe(incomeCategoriesBlob)
  })

  it('removes a tombstone only when it is strictly older', async () => {
    await buildStore()

    // A cut-off equal to the old deletedAt keeps those tombstones.
    expect(await compactTombstones(JAN_10)).toBe(0)
    // One millisecond later removes them.
    expect(await compactTombstones('2026-01-10T00:00:00.001Z')).toBe(4)
    // The May tombstones need a later cut-off.
    expect(await compactTombstones(MAY_10)).toBe(0)
    expect(await compactTombstones('2026-06-01T00:00:00.000Z')).toBe(2)
  })

  it('returns 0 and writes and announces nothing when there is nothing to remove', async () => {
    await buildStore()
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0

    const removed = await compactTombstones('2025-01-01T00:00:00.000Z')

    expect(removed).toBe(0)
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('never removes a live record, whatever the cut-off', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id))
    await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })

    const removed = await compactTombstones('2099-01-01T00:00:00.000Z')

    expect(removed).toBe(0)
    expect(await getAllCategories()).toHaveLength(1)
    expect(await getAllExpenses()).toHaveLength(1)
    expect(await getAllIncome()).toHaveLength(1)
  })

  it('does not change the change counter or the revs of the remaining records', async () => {
    const s = await buildStore()
    const rev = await getLocalRev()
    const before = await readRaw<Expense & { rev?: number }>('expenses_2026_04')

    await compactTombstones(CUTOFF)

    expect(await getLocalRev()).toBe(rev)
    expect(await readRaw<Expense & { rev?: number }>('expenses_2026_04')).toEqual(before)
    const category = (await readRaw<Category & { rev?: number }>('categories')).find(
      (c) => c.id === s.c2.id,
    )
    expect(typeof category?.rev).toBe('number')
  })

  it('announces the changed keys but is not a data change and requests no conversion', async () => {
    await buildStore()
    const channel = fakeChannel()
    setSyncChannel(channel)
    const listener = vi.fn()
    const stop = onConversionNeeded(listener)
    const settingsBefore = mockStore.get('meta:settings')

    await compactTombstones(CUTOFF)
    stop()

    expect([...postedKeys(channel)].sort()).toEqual([
      'categories',
      'expenses_2026_01',
      'income',
      'recurring',
    ])
    expect(listener).not.toHaveBeenCalled()
    expect(mockStore.get('meta:settings')).toBe(settingsBefore)
  })

  it('a DecryptError propagates and nothing is written', async () => {
    await buildStore()
    const garbage = new Uint8Array(40)
    mockStore.set('income', garbage)
    const categoriesBlob = mockStore.get('categories')
    ctl.setManyCalls.length = 0

    await expect(compactTombstones(CUTOFF)).rejects.toBeInstanceOf(DecryptError)

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(mockStore.get('income')).toBe(garbage)
  })
})

describe('data is really removed by wipe', () => {
  it('clearLocalDb empties the store, tombstones included', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense(expenseInput(cat.id))
    await deleteExpense(e.id, e.createdAt)
    expect(mockStore.has(MARCH_CHUNK)).toBe(true)

    await clearLocalDb()

    expect(mockStore.size).toBe(0)
  })
})
