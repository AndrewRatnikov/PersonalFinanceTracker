import { clear, createStore, del, get, keys, set } from 'idb-keyval'

import { decryptValue, encryptValue } from './crypto'
import { DecryptError, isDataStorageKey } from './dataErrors'
import { postChanged } from './syncChannel'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type {
  BudgetEntry,
  Category,
  CreateCategoryInput,
  CreateExpenseInput,
  CreateIncomeInput,
  Expense,
  IncomeEntry,
  UpdateCategoryInput,
  UpdateExpenseInput,
  UpsertBudgetInput,
} from './domain'

export { DecryptError }

export const ENABLE_SUPABASE_SYNC = false
// When true, each write mutation should also call the corresponding server
// function in src/lib/expenses.ts / categories.ts / income.ts / budgets.ts,
// guarded behind a Premium check. Not implemented yet.

// Expenses are stored in per-month chunks: `expenses_YYYY_MM`.
// All other collections are small enough to store as single keys.
//
// Every mutation runs its whole read-modify-write under withWriteLock for the
// storage key(s) it touches, and announces the written keys on the sync
// channel after the write has committed. Reads throw DecryptError for a blob
// that cannot be decrypted; mutations never catch it, so a corrupt blob is
// never overwritten. Quarantined copies live under `quarantine:<key>:<ISO>`
// and are ignored by every reader. After each committed mutation (but not a
// quarantine) `meta:settings.lastDataChangeAt` is set for the backup reminder.
interface LocalDbMap {
  categories: Array<Category>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
}

type LocalDbKey = keyof LocalDbMap

// The vault DEK (see vault.ts): a non-extractable AES-GCM key, memory only.
let _key: CryptoKey | null = null

const store =
  typeof window !== 'undefined' ? createStore('minima-local', 'data') : null

// The shared store handle. vault.ts keeps `meta:vault` and `meta:settings` in
// the same store as the data. Null on the server.
export function getLocalStore(): UseStore | null {
  return store
}

export function getLocalDbKey(): CryptoKey | null {
  return _key
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

// ── Generic encrypted read/write ──────────────────────────────────────────────

async function readStore<TKey extends LocalDbKey>(
  key: TKey,
): Promise<LocalDbMap[TKey] | undefined> {
  if (!_key || !store) return undefined
  const raw = await get<unknown>(key, store)
  if (!(raw instanceof Uint8Array)) return undefined
  try {
    return (await decryptValue(_key, raw)) as LocalDbMap[TKey]
  } catch (err) {
    throw new DecryptError(key, err)
  }
}

async function writeStore<TKey extends LocalDbKey>(
  key: TKey,
  data: LocalDbMap[TKey],
): Promise<void> {
  if (!_key) throw new Error('LocalDb not initialized')
  if (!store) return
  const encrypted = await encryptValue(_key, data)
  await set(key, encrypted, store)
}

// ── Expense chunk helpers ─────────────────────────────────────────────────────

const EXPENSE_CHUNK_KEY_RE = /^expenses_\d{4}_\d{2}$/

export function expenseChunkKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime()))
    throw new Error(`expenseChunkKey: invalid date string "${dateStr}"`)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `expenses_${y}_${m}`
}

function chunkKeysBetween(from: string, to: string): Array<string> {
  const result: Array<string> = []
  const start = new Date(from)
  const end = new Date(to)
  // Advance in UTC months to stay consistent with expenseChunkKey.
  let y = start.getUTCFullYear()
  let mo = start.getUTCMonth()
  const endY = end.getUTCFullYear()
  const endMo = end.getUTCMonth()
  while (y < endY || (y === endY && mo <= endMo)) {
    result.push(`expenses_${y}_${String(mo + 1).padStart(2, '0')}`)
    mo++
    if (mo > 11) {
      mo = 0
      y++
    }
  }
  return result
}

async function readChunk(chunkKey: string): Promise<Array<Expense>> {
  if (!_key || !store) return []
  const raw = await get<unknown>(chunkKey, store)
  if (!(raw instanceof Uint8Array)) return []
  try {
    return (await decryptValue(_key, raw)) as Array<Expense>
  } catch (err) {
    throw new DecryptError(chunkKey, err)
  }
}

async function writeChunk(
  chunkKey: string,
  data: Array<Expense>,
): Promise<void> {
  if (!_key) throw new Error('LocalDb not initialized')
  if (!store) return
  const encrypted = await encryptValue(_key, data)
  await set(chunkKey, encrypted, store)
}

// Only real month chunks: quarantine:* copies and stray keys are skipped.
async function allExpenseChunkKeys(): Promise<Array<string>> {
  if (!_key || !store) return []
  const allKeys = await keys(store)
  return allKeys
    .filter(
      (k): k is string => typeof k === 'string' && EXPENSE_CHUNK_KEY_RE.test(k),
    )
    .sort()
}

// ── Commit hook: lastDataChangeAt (§6.2) ──────────────────────────────────────

// Must equal META_SETTINGS_KEY in vault.ts. Not imported from there: vault.ts
// imports this module, and many tests mock `@/lib/vault` partially.
const META_SETTINGS_KEY = 'meta:settings'

// Records the time of the last committed data change in the plaintext
// `meta:settings` object (merged, other fields kept). The data write has
// already committed, so a failure here is logged and never fails the mutation.
async function markDataChanged(): Promise<void> {
  const s = store
  if (!s) return
  try {
    await withWriteLock(META_SETTINGS_KEY, async () => {
      const raw = await get<unknown>(META_SETTINGS_KEY, s)
      const stored = raw && typeof raw === 'object' ? raw : {}
      await set(
        META_SETTINGS_KEY,
        { ...stored, lastDataChangeAt: new Date().toISOString() },
        s,
      )
    })
  } catch (err) {
    console.error('Could not record the data change time:', err)
  }
}

// Runs after every committed user-data mutation (not after quarantine).
async function afterCommit(changedKeys: Array<string>): Promise<void> {
  postChanged(changedKeys)
  await markDataChanged()
}

// ── Quarantine and orphan detection ───────────────────────────────────────────

// Moves the raw stored value of a data key, unchanged, to
// `quarantine:<key>:<ISO timestamp>`, then deletes the original. The original
// is only deleted after the copy has been written. Needs no unlock key.
export async function quarantineKey(
  storageKey: string,
): Promise<string | null> {
  if (!isDataStorageKey(storageKey)) {
    throw new Error(`quarantineKey: not a data key "${storageKey}"`)
  }
  const s = store
  if (!s) return null
  const qKey = await withWriteLock(storageKey, async () => {
    const raw = await get<unknown>(storageKey, s)
    if (raw === undefined) return null
    const target = `quarantine:${storageKey}:${new Date().toISOString()}`
    await set(target, raw, s)
    await del(storageKey, s)
    return target
  })
  if (qKey !== null) postChanged([storageKey])
  return qKey
}

// True if the store holds any data key in the current format (quarantine
// copies alone do not count). Works before unlock.
export async function hasLocalData(): Promise<boolean> {
  if (!store) return false
  const allKeys = await keys(store)
  return allKeys.some((k) => typeof k === 'string' && isDataStorageKey(k))
}

// ── Expenses ──────────────────────────────────────────────────────────────────

async function joinCategories(
  expenses: Array<Expense>,
): Promise<Array<Expense>> {
  const categories = (await readStore('categories')) ?? []
  const categoryMap = new Map(categories.map((c) => [c.id, c]))
  return expenses.map((e) => ({
    ...e,
    category: categoryMap.get(e.categoryId),
  }))
}

export async function getExpensesForRange(
  from: string,
  to: string,
): Promise<Array<Expense>> {
  const chunkKeys = chunkKeysBetween(from, to)
  const chunks = await Promise.all(chunkKeys.map(readChunk))
  const expenses = chunks
    .flat()
    .filter((e) => e.createdAt >= from && e.createdAt <= to)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return joinCategories(expenses)
}

// TODO: could possible create a spike if user will export all data for 5 years
export async function getAllExpenses(): Promise<Array<Expense>> {
  const chunkKeys = await allExpenseChunkKeys()
  const chunks = await Promise.all(chunkKeys.map(readChunk))
  const expenses = chunks
    .flat()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return joinCategories(expenses)
}

export async function addExpense(input: CreateExpenseInput): Promise<Expense> {
  if (
    input.createdAt !== undefined &&
    isNaN(new Date(input.createdAt).getTime())
  ) {
    throw new Error(`addExpense: invalid createdAt "${input.createdAt}"`)
  }
  const now = new Date().toISOString()
  const entry: Expense = {
    id: crypto.randomUUID(),
    amount: input.amount,
    currency: input.currency,
    categoryId: input.categoryId,
    description: input.description,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  }
  const chunkKey = expenseChunkKey(entry.createdAt)
  await withWriteLock(chunkKey, async () => {
    const existing = await readChunk(chunkKey)
    await writeChunk(chunkKey, [...existing, entry])
  })
  await afterCommit([chunkKey])
  const categories = (await readStore('categories')) ?? []
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...entry, category }
}

// createdAt is required so we can derive the correct chunk without a full scan.
export async function deleteExpense(
  id: string,
  createdAt: string,
): Promise<void> {
  const chunkKey = expenseChunkKey(createdAt)
  await withWriteLock(chunkKey, async () => {
    const chunk = await readChunk(chunkKey)
    await writeChunk(
      chunkKey,
      chunk.filter((e) => e.id !== id),
    )
  })
  await afterCommit([chunkKey])
}

// originalCreatedAt locates the current chunk; if the patch moves createdAt
// into a different month the record is moved to that month's chunk.
export async function updateExpense(
  id: string,
  originalCreatedAt: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  const oldKey = expenseChunkKey(originalCreatedAt)
  const lockKeys = [oldKey]
  if (
    patch.createdAt !== undefined &&
    !isNaN(new Date(patch.createdAt).getTime())
  ) {
    lockKeys.push(expenseChunkKey(patch.createdAt))
  }

  const { result, written } = await withWriteLock(lockKeys, async () => {
    const oldChunk = await readChunk(oldKey)
    const index = oldChunk.findIndex((e) => e.id === id)
    if (index === -1) {
      throw new Error(`updateExpense: expense not found: ${id}`)
    }
    const existing = oldChunk[index]

    const createdAt = patch.createdAt ?? existing.createdAt
    if (isNaN(new Date(createdAt).getTime())) {
      throw new Error(`updateExpense: invalid createdAt "${createdAt}"`)
    }

    const categories = (await readStore('categories')) ?? []
    if (
      patch.categoryId !== undefined &&
      !categories.some((c) => c.id === patch.categoryId)
    ) {
      throw new Error(`updateExpense: unknown categoryId "${patch.categoryId}"`)
    }

    const description =
      patch.description !== undefined
        ? patch.description === ''
          ? null
          : patch.description
        : existing.description

    const updated: Expense = {
      id: existing.id,
      amount: patch.amount ?? existing.amount,
      currency: patch.currency ?? existing.currency,
      categoryId: patch.categoryId ?? existing.categoryId,
      description,
      createdAt,
      updatedAt: new Date().toISOString(),
    }

    const newKey = expenseChunkKey(createdAt)
    let writtenKeys: Array<string>
    if (newKey === oldKey) {
      const next = [...oldChunk]
      next[index] = updated
      await writeChunk(oldKey, next)
      writtenKeys = [oldKey]
    } else {
      // Append to the new chunk first: a failure in between can only duplicate
      // the record, never lose it.
      const newChunk = await readChunk(newKey)
      await writeChunk(newKey, [
        ...newChunk.filter((e) => e.id !== id),
        updated,
      ])
      await writeChunk(
        oldKey,
        oldChunk.filter((e) => e.id !== id),
      )
      writtenKeys = [newKey, oldKey]
    }

    const category = categories.find((c) => c.id === updated.categoryId)
    return { result: { ...updated, category }, written: writtenKeys }
  })
  await afterCommit(written)
  return result
}

// ── Categories ────────────────────────────────────────────────────────────────

export async function getAllCategories(): Promise<Array<Category>> {
  return (await readStore('categories')) ?? []
}

export async function addCategory(
  input: CreateCategoryInput,
): Promise<Category> {
  const entry = await withWriteLock('categories', async () => {
    const categories = (await readStore('categories')) ?? []
    const name = input.name.trim()
    if (!name) throw new Error('Category name is required')
    if (
      categories.some(
        (c) => c.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error(`Category "${name}" already exists`)
    }
    const created: Category = {
      id: crypto.randomUUID(),
      name,
      icon: input.icon ?? null,
      updatedAt: new Date().toISOString(),
    }
    await writeStore('categories', [...categories, created])
    return created
  })
  await afterCommit(['categories'])
  return entry
}

export async function updateCategory(
  input: UpdateCategoryInput,
): Promise<Category> {
  const result = await withWriteLock('categories', async () => {
    const categories = (await readStore('categories')) ?? []
    const name = input.name.trim()
    if (!name) throw new Error('Category name is required')
    if (
      categories.some(
        (c) =>
          c.id !== input.id &&
          c.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error(`Category "${name}" already exists`)
    }
    const updatedAt = new Date().toISOString()
    const updated = categories.map((c) =>
      c.id === input.id
        ? { ...c, name, icon: input.icon ?? null, updatedAt }
        : c,
    )
    await writeStore('categories', updated)
    const found = updated.find((c) => c.id === input.id)
    if (!found) throw new Error(`Category not found: ${input.id}`)
    return found
  })
  await afterCommit(['categories'])
  return result
}

export async function deleteCategory(id: string): Promise<void> {
  const budgetsChanged = await withWriteLock(
    ['budgets', 'categories'],
    async () => {
      // Check all expense chunks for references to this category. This only
      // reads chunks, so it takes no chunk locks.
      const chunkKeys = await allExpenseChunkKeys()
      const chunks = await Promise.all(chunkKeys.map(readChunk))
      const using = chunks.flat().filter((e) => e.categoryId === id).length
      if (using > 0) {
        throw new Error(
          `${using} expense${using === 1 ? '' : 's'} use this category`,
        )
      }
      const categories = (await readStore('categories')) ?? []
      await writeStore(
        'categories',
        categories.filter((c) => c.id !== id),
      )

      const budgets = (await readStore('budgets')) ?? []
      const filteredBudgets = budgets.filter((b) => b.categoryId !== id)
      if (filteredBudgets.length !== budgets.length) {
        await writeStore('budgets', filteredBudgets)
        return true
      }
      return false
    },
  )
  await afterCommit(
    budgetsChanged ? ['categories', 'budgets'] : ['categories'],
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
  const wrote = await withWriteLock('categories', async () => {
    const categories = (await readStore('categories')) ?? []
    if (categories.length > 0) return false
    const updatedAt = new Date().toISOString()
    const defaults: Array<Category> = DEFAULT_CATEGORIES.map((c) => ({
      id: crypto.randomUUID(),
      name: c.name,
      icon: c.icon ?? null,
      updatedAt,
    }))
    await writeStore('categories', defaults)
    return true
  })
  if (wrote) await afterCommit(['categories'])
}

// ── Income ────────────────────────────────────────────────────────────────────

export async function getAllIncome(): Promise<Array<IncomeEntry>> {
  return (await readStore('income')) ?? []
}

export async function addIncome(
  input: CreateIncomeInput,
): Promise<IncomeEntry> {
  const entry = await withWriteLock('income', async () => {
    const income = (await readStore('income')) ?? []
    const now = new Date().toISOString()
    const created: IncomeEntry = {
      id: crypto.randomUUID(),
      source: input.source,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    }
    await writeStore('income', [...income, created])
    return created
  })
  await afterCommit(['income'])
  return entry
}

export async function deleteIncome(id: string): Promise<void> {
  await withWriteLock('income', async () => {
    const income = (await readStore('income')) ?? []
    await writeStore(
      'income',
      income.filter((e) => e.id !== id),
    )
  })
  await afterCommit(['income'])
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

export async function upsertBudget(
  input: UpsertBudgetInput,
): Promise<BudgetEntry> {
  const result = await withWriteLock('budgets', async () => {
    const budgets = (await readStore('budgets')) ?? []
    const existing = budgets.find((b) => b.categoryId === input.categoryId)
    const updatedAt = new Date().toISOString()
    let entry: BudgetEntry
    let updated: Array<BudgetEntry>
    if (existing) {
      entry = {
        ...existing,
        monthlyLimit: input.monthlyLimit,
        currency: input.currency,
        updatedAt,
      }
      updated = budgets.map((b) => (b.id === existing.id ? entry : b))
    } else {
      entry = {
        id: crypto.randomUUID(),
        categoryId: input.categoryId,
        monthlyLimit: input.monthlyLimit,
        currency: input.currency,
        updatedAt,
      }
      updated = [...budgets, entry]
    }
    await writeStore('budgets', updated)
    return entry
  })
  await afterCommit(['budgets'])
  return result
}

export async function deleteBudget(id: string): Promise<void> {
  await withWriteLock('budgets', async () => {
    const budgets = (await readStore('budgets')) ?? []
    await writeStore(
      'budgets',
      budgets.filter((b) => b.id !== id),
    )
  })
  await afterCommit(['budgets'])
}
