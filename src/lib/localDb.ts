import { createStore, get, set, clear } from 'idb-keyval'

import { encryptValue, decryptValue, getOrCreateDeviceSalt } from './crypto'
import type {
  Category,
  CreateCategoryInput,
  UpdateCategoryInput,
  Expense,
  CreateExpenseInput,
  IncomeEntry,
  CreateIncomeInput,
  BudgetEntry,
  UpsertBudgetInput,
} from './domain'

export const ENABLE_SUPABASE_SYNC = false
// When true, each write mutation should also call the corresponding server
// function in src/lib/expenses.ts / categories.ts / income.ts / budgets.ts,
// guarded behind a Premium check. Not implemented yet.

interface LocalDbMap {
  expenses: Array<Expense>
  categories: Array<Category>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
}

type LocalDbKey = keyof LocalDbMap

let _key: CryptoKey | null = null
let _deviceSalt: Uint8Array | null = null

const store =
  typeof window !== 'undefined'
    ? createStore('minima-local', 'data')
    : null

export function initLocalDb(userId: string): void {
  if (typeof window === 'undefined') return
  _deviceSalt = getOrCreateDeviceSalt(userId)
}

export function unlockLocalDb(key: CryptoKey): void {
  _key = key
}

export function wipeLocalDbKey(): void {
  _key = null
}

export async function clearLocalDb(): Promise<void> {
  if (!store) return
  await clear(store)
}

async function readStore<K extends LocalDbKey>(
  key: K,
): Promise<LocalDbMap[K] | undefined> {
  if (!_key || !store) return undefined
  const raw = await get<unknown>(key, store)
  if (!(raw instanceof Uint8Array)) return undefined
  try {
    return (await decryptValue(_key, raw)) as LocalDbMap[K]
  } catch {
    return undefined
  }
}

async function writeStore<K extends LocalDbKey>(
  key: K,
  data: LocalDbMap[K],
): Promise<void> {
  if (!_key) throw new Error('LocalDb not initialized')
  if (!store) return
  const encrypted = await encryptValue(_key, data)
  await set(key, encrypted, store)
}

// ── Expenses ──────────────────────────────────────────────────────────────────

export async function getAllExpenses(): Promise<Array<Expense>> {
  const expenses = (await readStore('expenses')) ?? []
  const categories = (await readStore('categories')) ?? []
  const categoryMap = new Map(categories.map((c) => [c.id, c]))
  return expenses.map((e) => ({ ...e, category: categoryMap.get(e.categoryId) }))
}

export async function addExpense(input: CreateExpenseInput): Promise<Expense> {
  const expenses = (await readStore('expenses')) ?? []
  const entry: Expense = {
    id: crypto.randomUUID(),
    amount: input.amount,
    currency: input.currency,
    categoryId: input.categoryId,
    description: input.description,
    createdAt: new Date().toISOString(),
  }
  await writeStore('expenses', [...expenses, entry])
  const categories = (await readStore('categories')) ?? []
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...entry, category }
}

export async function deleteExpense(id: string): Promise<void> {
  const expenses = (await readStore('expenses')) ?? []
  await writeStore(
    'expenses',
    expenses.filter((e) => e.id !== id),
  )
}

// ── Categories ────────────────────────────────────────────────────────────────

export async function getAllCategories(): Promise<Array<Category>> {
  return (await readStore('categories')) ?? []
}

export async function addCategory(input: CreateCategoryInput): Promise<Category> {
  const categories = (await readStore('categories')) ?? []
  const entry: Category = {
    id: crypto.randomUUID(),
    name: input.name,
    icon: input.icon ?? null,
  }
  await writeStore('categories', [...categories, entry])
  return entry
}

export async function updateCategory(
  input: UpdateCategoryInput,
): Promise<Category> {
  const categories = (await readStore('categories')) ?? []
  const updated = categories.map((c) =>
    c.id === input.id ? { ...c, name: input.name, icon: input.icon ?? null } : c,
  )
  await writeStore('categories', updated)
  return updated.find((c) => c.id === input.id)!
}

export async function deleteCategory(id: string): Promise<void> {
  const expenses = (await readStore('expenses')) ?? []
  const using = expenses.filter((e) => e.categoryId === id).length
  if (using > 0) {
    throw new Error(`${using} expense${using === 1 ? '' : 's'} use this category`)
  }
  const categories = (await readStore('categories')) ?? []
  await writeStore(
    'categories',
    categories.filter((c) => c.id !== id),
  )
}

const DEFAULT_CATEGORIES: Array<Omit<Category, 'id'>> = [
  { name: 'Food', icon: '🍔' },
  { name: 'Transport', icon: '🚌' },
  { name: 'Rent', icon: '🏠' },
  { name: 'Coffee', icon: '☕' },
  { name: 'Entertainment', icon: '🎬' },
  { name: 'Server Costs', icon: '🖥️' },
]

export async function provisionDefaultCategories(): Promise<void> {
  const categories = (await readStore('categories')) ?? []
  if (categories.length > 0) return
  const defaults: Array<Category> = DEFAULT_CATEGORIES.map((c) => ({
    id: crypto.randomUUID(),
    name: c.name,
    icon: c.icon ?? null,
  }))
  await writeStore('categories', defaults)
}

// ── Income ────────────────────────────────────────────────────────────────────

export async function getAllIncome(): Promise<Array<IncomeEntry>> {
  return (await readStore('income')) ?? []
}

export async function addIncome(input: CreateIncomeInput): Promise<IncomeEntry> {
  const income = (await readStore('income')) ?? []
  const entry: IncomeEntry = {
    id: crypto.randomUUID(),
    source: input.source,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    createdAt: new Date().toISOString(),
  }
  await writeStore('income', [...income, entry])
  return entry
}

export async function deleteIncome(id: string): Promise<void> {
  const income = (await readStore('income')) ?? []
  await writeStore(
    'income',
    income.filter((e) => e.id !== id),
  )
}

// ── Budgets ───────────────────────────────────────────────────────────────────

export async function getAllBudgets(): Promise<
  Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>
> {
  const budgets = (await readStore('budgets')) ?? []
  const categories = (await readStore('categories')) ?? []
  const categoryMap = new Map(categories.map((c) => [c.id, c]))
  return budgets.map((b) => {
    const cat = categoryMap.get(b.categoryId)
    return {
      ...b,
      categoryName: cat?.name ?? '',
      categoryIcon: cat?.icon ?? null,
    }
  })
}

export async function upsertBudget(input: UpsertBudgetInput): Promise<BudgetEntry> {
  const budgets = (await readStore('budgets')) ?? []
  const existing = budgets.find((b) => b.categoryId === input.categoryId)
  let entry: BudgetEntry
  let updated: Array<BudgetEntry>
  if (existing) {
    entry = { ...existing, monthlyLimit: input.monthlyLimit, currency: input.currency }
    updated = budgets.map((b) => (b.id === existing.id ? entry : b))
  } else {
    entry = {
      id: crypto.randomUUID(),
      categoryId: input.categoryId,
      monthlyLimit: input.monthlyLimit,
      currency: input.currency,
    }
    updated = [...budgets, entry]
  }
  await writeStore('budgets', updated)
  return entry
}

export async function deleteBudget(id: string): Promise<void> {
  const budgets = (await readStore('budgets')) ?? []
  await writeStore(
    'budgets',
    budgets.filter((b) => b.id !== id),
  )
}
