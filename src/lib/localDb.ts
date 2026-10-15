import { clear, createStore, del, get, keys, set, setMany } from 'idb-keyval'

import { decryptValue, encryptValue } from './crypto'
import { DecryptError, isDataStorageKey } from './dataErrors'
import { DEFAULT_MAIN_CURRENCY, isCurrency } from './domain'
import { convertIncomeSources } from './incomeCategories'
import { identityConversion, isConverted } from './money'
import {
  addDaysToDate,
  dueOccurrences,
  lastOccurrenceOnOrBefore,
  markOccurrenceHandled,
  nextOccurrence,
  occurrenceCreatedAt,
  occurrencesBetween,
  toLocalDateString,
} from './recurrence'
import { recurringInputSchema, recurringInputSchemaFor } from './schemas'
import { postChanged } from './syncChannel'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type {
  BudgetEntry,
  Category,
  CreateCategoryInput,
  CreateExpenseInput,
  CreateIncomeInput,
  CreateRecurringInput,
  Currency,
  EntryConversion,
  Expense,
  IncomeEntry,
  RecurringItem,
  RecurringKind,
  RecurringOccurrence,
  UpdateCategoryInput,
  UpdateExpenseInput,
  UpdateRecurringInput,
  UpsertBudgetInput,
} from './domain'

export { DecryptError }

export const ENABLE_SUPABASE_SYNC = false
// When true, each write mutation should also call the corresponding server
// function in src/lib/expenses.ts / categories.ts / income.ts / budgets.ts,
// guarded behind a Premium check. Not implemented yet.

// Expenses are stored in per-month chunks: `expenses_YYYY_MM`.
// All other collections are small enough to store as single keys:
// `categories` (expense categories), `incomeCategories`, `income`, `budgets`,
// `recurring` (recurring items).
// Income records reference an income category by `categoryId`; legacy records
// with a free-text `source` are converted by ensureIncomeCategories().
//
// Every mutation runs its whole read-modify-write under withWriteLock for the
// storage key(s) it touches, and announces the written keys on the sync
// channel after the write has committed. Reads throw DecryptError for a blob
// that cannot be decrypted; mutations never catch it, so a corrupt blob is
// never overwritten. Quarantined copies live under `quarantine:<key>:<ISO>`
// and are ignored by every reader. After each committed mutation (but not a
// quarantine) `meta:settings.lastDataChangeAt` is set for the backup reminder.
//
// Main currency: an entry saved in the main currency gets its identity
// `conversion` right away; any other entry is stored without one (pending).
// Every committed write to an entry key (an expense chunk or `income`) calls
// requestEntryConversion(), which conversion.ts listens to (this module never
// imports conversion.ts). The converter writes back through
// applyEntryConversions / convertBudgets, which don't trigger it again.
interface LocalDbMap {
  categories: Array<Category>
  incomeCategories: Array<Category>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  recurring: Array<RecurringItem>
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

// Encrypts every value and writes them all in ONE IndexedDB transaction
// (idb-keyval setMany). If the transaction fails nothing is written.
async function writeStoreMany(values: Partial<LocalDbMap>): Promise<void> {
  await writeKeysMany(values)
}

// Like writeStoreMany, but the values may also be expense chunks
// (`expenses_YYYY_MM` -> Array<Expense>), so one transaction can carry single
// keys and chunks together.
async function writeKeysMany(values: object): Promise<void> {
  const key = _key
  if (!key) throw new Error('LocalDb not initialized')
  if (!store) return
  const entries: Array<[IDBValidKey, Uint8Array]> = []
  for (const [k, v] of Object.entries(values)) {
    entries.push([k, await encryptValue(key, v)])
  }
  if (entries.length === 0) return
  await setMany(entries, store)
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

// ── Conversion trigger (in-tab) ───────────────────────────────────────────────

const conversionListeners = new Set<() => void>()

// Registers a listener for "entries may need converting". Returns the
// unsubscribe function.
export function onConversionNeeded(listener: () => void): () => void {
  conversionListeners.add(listener)
  return () => {
    conversionListeners.delete(listener)
  }
}

// Calls every listener; a throwing listener is logged and never stops the
// others (or the write that triggered it).
export function requestEntryConversion(): void {
  for (const listener of Array.from(conversionListeners)) {
    try {
      listener()
    } catch (err) {
      console.error('Conversion listener failed:', err)
    }
  }
}

function isEntryKey(key: string): boolean {
  return key === 'income' || EXPENSE_CHUNK_KEY_RE.test(key)
}

// Runs after every committed user-data mutation (not after quarantine).
// Writes to entry keys request a conversion, except the converter's own.
async function afterCommit(
  changedKeys: Array<string>,
  opts: { fromConversion?: boolean } = {},
): Promise<void> {
  postChanged(changedKeys)
  await markDataChanged()
  if (!opts.fromConversion && changedKeys.some(isEntryKey)) {
    requestEntryConversion()
  }
}

// The stored main currency, read straight from the plaintext settings (no
// lock: a read). An unknown value falls back to the default.
async function readMainCurrency(): Promise<Currency> {
  const s = store
  if (!s) return DEFAULT_MAIN_CURRENCY
  try {
    const raw = await get<unknown>(META_SETTINGS_KEY, s)
    if (raw && typeof raw === 'object') {
      const main = (raw as Record<string, unknown>).mainCurrency
      if (isCurrency(main)) return main
    }
  } catch (err) {
    console.error('Could not read the main currency:', err)
  }
  return DEFAULT_MAIN_CURRENCY
}

// The identity conversion when the record is in `main`; otherwise undefined
// (the record stays pending until the converter runs).
function conversionOnSave(
  record: { amount: number; currency: Currency; createdAt: string },
  main: Currency,
): EntryConversion | undefined {
  return record.currency === main ? identityConversion(record, main) : undefined
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
  const conversion = conversionOnSave(entry, await readMainCurrency())
  if (conversion) entry.conversion = conversion
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
  const main = await readMainCurrency()
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
    // A generated record keeps its idempotency key (recurringId +
    // occurrenceDate); ordinary records keep their exact shape.
    if (existing.recurringId !== undefined) {
      updated.recurringId = existing.recurringId
    }
    if (existing.occurrenceDate !== undefined) {
      updated.occurrenceDate = existing.occurrenceDate
    }
    // The conversion stays only while amount, currency and date are
    // unchanged; otherwise it is the identity (in the main currency) or
    // dropped (pending). A manual rate stays unless the currency changed.
    const sameMoney =
      updated.amount === existing.amount &&
      updated.currency === existing.currency &&
      updated.createdAt === existing.createdAt
    const conversion = sameMoney
      ? existing.conversion
      : conversionOnSave(updated, main)
    if (conversion !== undefined) updated.conversion = conversion
    if (
      existing.manualRate !== undefined &&
      updated.currency === existing.currency
    ) {
      updated.manualRate = existing.manualRate
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

type CategoryKey = 'categories' | 'incomeCategories'

// Shared by the expense and the income category mutations: the whole
// read-modify-write runs under the lock of `key`. Names are trimmed and unique
// ignoring case.
async function addCategoryIn(
  key: CategoryKey,
  input: CreateCategoryInput,
): Promise<Category> {
  const entry = await withWriteLock(key, async () => {
    const categories = (await readStore(key)) ?? []
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
    await writeStore(key, [...categories, created])
    return created
  })
  await afterCommit([key])
  return entry
}

async function updateCategoryIn(
  key: CategoryKey,
  input: UpdateCategoryInput,
): Promise<Category> {
  const result = await withWriteLock(key, async () => {
    const categories = (await readStore(key)) ?? []
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
    await writeStore(key, updated)
    const found = updated.find((c) => c.id === input.id)
    if (!found) throw new Error(`Category not found: ${input.id}`)
    return found
  })
  await afterCommit([key])
  return result
}

export async function addCategory(
  input: CreateCategoryInput,
): Promise<Category> {
  return addCategoryIn('categories', input)
}

export async function updateCategory(
  input: UpdateCategoryInput,
): Promise<Category> {
  return updateCategoryIn('categories', input)
}

// Refuses while a recurring item of `kind` uses the category.
async function assertNoRecurringUses(
  kind: RecurringKind,
  categoryId: string,
): Promise<void> {
  const items = (await readStore('recurring')) ?? []
  const using = items.filter(
    (i) => i.kind === kind && i.categoryId === categoryId,
  ).length
  if (using > 0) {
    throw new Error(
      `Used by ${using} recurring item${using === 1 ? '' : 's'}`,
    )
  }
}

export async function deleteCategory(id: string): Promise<void> {
  const budgetsChanged = await withWriteLock(
    ['budgets', 'categories', 'recurring'],
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
      await assertNoRecurringUses('expense', id)
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

// ── Income categories ─────────────────────────────────────────────────────────

export async function getAllIncomeCategories(): Promise<Array<Category>> {
  return (await readStore('incomeCategories')) ?? []
}

export async function addIncomeCategory(
  input: CreateCategoryInput,
): Promise<Category> {
  return addCategoryIn('incomeCategories', input)
}

export async function updateIncomeCategory(
  input: UpdateCategoryInput,
): Promise<Category> {
  return updateCategoryIn('incomeCategories', input)
}

export async function deleteIncomeCategory(id: string): Promise<void> {
  await withWriteLock(['income', 'incomeCategories', 'recurring'], async () => {
    const income = (await readStore('income')) ?? []
    const using = income.filter((e) => e.categoryId === id).length
    if (using > 0) {
      throw new Error(
        using === 1
          ? '1 income entry uses this category'
          : `${using} income entries use this category`,
      )
    }
    await assertNoRecurringUses('income', id)
    const categories = (await readStore('incomeCategories')) ?? []
    await writeStore(
      'incomeCategories',
      categories.filter((c) => c.id !== id),
    )
  })
  await afterCommit(['incomeCategories'])
}

// Provisions the default income categories and converts legacy free-text
// income sources into categories, once: when `incomeCategories` already
// exists (even as an unreadable blob) it does nothing. Both keys are written
// in one transaction. A DecryptError on `income` propagates and nothing is
// written. Returns true when it wrote.
export async function ensureIncomeCategories(): Promise<boolean> {
  const s = store
  if (!_key || !s) return false
  const wrote = await withWriteLock(['income', 'incomeCategories'], async () => {
    const existing = await get<unknown>('incomeCategories', s)
    if (existing !== undefined) return false
    const income = (await readStore('income')) ?? []
    const converted = convertIncomeSources(income, [], { addDefaults: true })
    await writeStoreMany({
      incomeCategories: converted.incomeCategories,
      income: converted.income,
    })
    return true
  })
  if (wrote) await afterCommit(['incomeCategories', 'income'])
  return wrote
}

// Runs after every unlock: default expense categories for a new vault, then
// the income categories (defaults and legacy conversion), then the due
// recurring occurrences. Errors, including DecryptError, propagate to the
// caller. Returns how many recurring records were created.
export async function prepareUnlockedVault({
  isNewVault,
}: {
  isNewVault: boolean
}): Promise<{ recurringCreated: number }> {
  if (isNewVault) await provisionDefaultCategories()
  await ensureIncomeCategories()
  const { created } = await processDueRecurring()
  // Convert whatever is pending (old records, the records just generated).
  // Not awaited: the conversion runs in the background.
  requestEntryConversion()
  return { recurringCreated: created }
}

// ── Income ────────────────────────────────────────────────────────────────────

function joinIncomeCategories(
  income: Array<IncomeEntry>,
  categories: Array<Category>,
): Array<IncomeEntry> {
  const categoryMap = new Map(categories.map((c) => [c.id, c]))
  return income.map((i) => ({
    ...i,
    category: categoryMap.get(i.categoryId),
  }))
}

export async function getAllIncome(): Promise<Array<IncomeEntry>> {
  const income = (await readStore('income')) ?? []
  const categories = (await readStore('incomeCategories')) ?? []
  return joinIncomeCategories(income, categories)
}

export async function addIncome(
  input: CreateIncomeInput,
): Promise<IncomeEntry> {
  const main = await readMainCurrency()
  const entry = await withWriteLock('income', async () => {
    const income = (await readStore('income')) ?? []
    const now = new Date().toISOString()
    const created: IncomeEntry = {
      id: crypto.randomUUID(),
      categoryId: input.categoryId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    }
    const conversion = conversionOnSave(created, main)
    if (conversion) created.conversion = conversion
    await writeStore('income', [...income, created])
    return created
  })
  await afterCommit(['income'])
  const categories = (await readStore('incomeCategories')) ?? []
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...entry, category }
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

// ── Main-currency conversion (used by conversion.ts) ─────────────────────────

export interface ConversionStorageGroup {
  storageKey: string
  records: Array<Expense | IncomeEntry>
}

export interface EntryConversionUpdate {
  id: string
  amount: number
  currency: Currency
  createdAt: string
  conversion: EntryConversion
}

// The raw stored entries (no joined category): one group per expense chunk in
// ascending key order, then `income`. A DecryptError propagates.
export async function readEntriesForConversion(): Promise<
  Array<ConversionStorageGroup>
> {
  const groups: Array<ConversionStorageGroup> = []
  for (const storageKey of await allExpenseChunkKeys()) {
    const records = await readChunk(storageKey)
    if (records.length > 0) groups.push({ storageKey, records })
  }
  const income = (await readStore('income')) ?? []
  if (income.length > 0) groups.push({ storageKey: 'income', records: income })
  return groups
}

async function readEntryKey(
  storageKey: string,
): Promise<Array<Expense | IncomeEntry>> {
  if (storageKey === 'income') return (await readStore('income')) ?? []
  return readChunk(storageKey)
}

// Writes the computed conversions under the lock of `storageKey`. A record is
// updated only when it still exists, is not converted for `mainCurrency` yet
// and still has the amount, currency and createdAt the rate was computed for
// (an edit in between leaves it pending). Only `conversion` changes; updatedAt
// stays (derived data). Returns the number of records written.
export async function applyEntryConversions(
  storageKey: string,
  mainCurrency: Currency,
  updates: Array<EntryConversionUpdate>,
): Promise<number> {
  if (updates.length === 0) return 0
  if (storageKey !== 'income' && !EXPENSE_CHUNK_KEY_RE.test(storageKey)) {
    throw new Error(`applyEntryConversions: not an entry key "${storageKey}"`)
  }
  const byId = new Map(updates.map((u) => [u.id, u]))
  const written = await withWriteLock(storageKey, async () => {
    if (!_key) throw new Error('LocalDb not initialized')
    const records = await readEntryKey(storageKey)
    let count = 0
    const next = records.map((record) => {
      const update = byId.get(record.id)
      if (
        !update ||
        isConverted(record, mainCurrency) ||
        record.amount !== update.amount ||
        record.currency !== update.currency ||
        record.createdAt !== update.createdAt
      ) {
        return record
      }
      count++
      return { ...record, conversion: update.conversion }
    })
    if (count === 0) return 0
    await writeKeysMany({ [storageKey]: next })
    return count
  })
  if (written > 0) {
    await afterCommit([storageKey], { fromConversion: true })
  }
  return written
}

// Converts every budget not in `target` with `rateFor(budget.currency)`
// (unrounded) and, with setMainCurrency, stores `target` as the main
// currency in the SAME transaction. Without setMainCurrency (the one-time
// fix of budgets in another currency) it does nothing unless `target` is the
// stored main currency. A throwing rateFor writes nothing. Returns the
// number of budgets converted.
export async function convertBudgets(
  target: Currency,
  rateFor: (from: Currency) => number,
  options: { setMainCurrency: boolean },
): Promise<number> {
  const s = store
  if (!s) return 0
  const result = await withWriteLock(
    ['budgets', META_SETTINGS_KEY],
    async () => {
      const raw = await get<unknown>(META_SETTINGS_KEY, s)
      const settings =
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const storedMain = isCurrency(settings.mainCurrency)
        ? settings.mainCurrency
        : DEFAULT_MAIN_CURRENCY
      if (!options.setMainCurrency && storedMain !== target) {
        return { converted: 0, keys: [] as Array<string> }
      }
      const key = _key
      if (!key) throw new Error('LocalDb not initialized')

      const budgets = (await readStore('budgets')) ?? []
      const updatedAt = new Date().toISOString()
      let converted = 0
      const nextBudgets = budgets.map((b) => {
        if (b.currency === target) return b
        const rate = rateFor(b.currency)
        converted++
        return {
          ...b,
          monthlyLimit: b.monthlyLimit * rate,
          currency: target,
          updatedAt,
        }
      })

      const entries: Array<[IDBValidKey, unknown]> = []
      const writtenKeys: Array<string> = []
      if (converted > 0) {
        entries.push(['budgets', await encryptValue(key, nextBudgets)])
        writtenKeys.push('budgets')
      }
      if (options.setMainCurrency) {
        entries.push([META_SETTINGS_KEY, { ...settings, mainCurrency: target }])
        writtenKeys.push(META_SETTINGS_KEY)
      }
      if (entries.length > 0) await setMany(entries, s)
      return { converted, keys: writtenKeys }
    },
  )
  if (result.keys.length > 0) {
    await afterCommit(result.keys, { fromConversion: true })
  }
  return result.converted
}

// ── Recurring items ───────────────────────────────────────────────────────────
//
// Items live in the single key `recurring`. A generated record carries
// `recurringId` + `occurrenceDate`: that pair is the idempotency key, so an
// occurrence that already has a record (another tab, a retry, a restored
// backup) is never created twice. Every write runs under the lock of
// `recurring` plus every target key (expense chunks or `income`) and goes out
// in ONE setMany, so the item and its records commit together or not at all.

type GeneratedRecord = Expense | IncomeEntry

interface OccurrenceOverrides {
  amount?: number
  description?: string | null
}

const RECURRING_ATTEMPTS = 3
const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/

function categoryKeyFor(kind: RecurringKind): CategoryKey {
  return kind === 'income' ? 'incomeCategories' : 'categories'
}

// The storage key a generated record of `kind` on `date` is written to.
function occurrenceTargetKey(kind: RecurringKind, date: string): string {
  return kind === 'income'
    ? 'income'
    : expenseChunkKey(occurrenceCreatedAt(date))
}

function occurrenceTargetKeys(
  kind: RecurringKind,
  dates: Array<string>,
): Array<string> {
  return Array.from(new Set(dates.map((d) => occurrenceTargetKey(kind, d))))
}

async function readOccurrenceTarget(
  key: string,
): Promise<Array<GeneratedRecord>> {
  if (key === 'income') return (await readStore('income')) ?? []
  return readChunk(key)
}

async function categoryIdsFor(kind: RecurringKind): Promise<Array<string>> {
  return ((await readStore(categoryKeyFor(kind))) ?? []).map((c) => c.id)
}

// Validates with recurringInputSchemaFor (the categories of the input's kind)
// and throws the first issue's message.
async function validateRecurringInput(
  input: CreateRecurringInput,
): Promise<CreateRecurringInput> {
  const base = recurringInputSchema.safeParse(input)
  if (!base.success) throw new Error(base.error.issues[0].message)
  const checked = recurringInputSchemaFor(
    await categoryIdsFor(base.data.kind),
  ).safeParse(input)
  if (!checked.success) throw new Error(checked.error.issues[0].message)
  return checked.data
}

// Builds one record per date, grouped by target key. A date is skipped when
// its target already holds a record with the same recurringId +
// occurrenceDate. Returns only the targets that gained a record. Must run
// under the lock of every target key.
async function planOccurrenceWrites(
  item: RecurringItem,
  dates: Array<string>,
  overrides?: OccurrenceOverrides,
): Promise<{ values: Record<string, Array<GeneratedRecord>>; created: number }> {
  const lists = new Map<string, Array<GeneratedRecord>>()
  const values: Record<string, Array<GeneratedRecord>> = {}
  const main = await readMainCurrency()
  let created = 0
  const now = new Date().toISOString()
  const amount = overrides?.amount ?? item.amount
  const description =
    overrides?.description !== undefined
      ? overrides.description === ''
        ? null
        : overrides.description
      : item.description
  for (const date of dates) {
    const key = occurrenceTargetKey(item.kind, date)
    const list = lists.get(key) ?? (await readOccurrenceTarget(key))
    if (
      list.some((r) => r.recurringId === item.id && r.occurrenceDate === date)
    ) {
      lists.set(key, list)
      continue
    }
    const record: GeneratedRecord = {
      id: crypto.randomUUID(),
      amount,
      currency: item.currency,
      categoryId: item.categoryId,
      description,
      createdAt: occurrenceCreatedAt(date),
      updatedAt: now,
      recurringId: item.id,
      occurrenceDate: date,
    }
    const conversion = conversionOnSave(record, main)
    if (conversion) record.conversion = conversion
    const next = [...list, record]
    lists.set(key, next)
    values[key] = next
    created++
  }
  return { values, created }
}

// True when `date` is an occurrence of the item that isn't handled yet.
function isUnhandledOccurrence(item: RecurringItem, date: string): boolean {
  if (!DATE_STRING_RE.test(date)) return false
  if (item.handledThrough !== null && date <= item.handledThrough) return false
  if (item.handledAhead.includes(date)) return false
  const dates = occurrencesBetween(item, item.handledThrough, date)
  return dates[dates.length - 1] === date
}

export async function getAllRecurring(): Promise<Array<RecurringItem>> {
  return (await readStore('recurring')) ?? []
}

export async function getDueRecurring(
  today: string = toLocalDateString(),
): Promise<Array<RecurringOccurrence>> {
  return dueOccurrences(await getAllRecurring(), today)
}

type ItemOutcome = { created: number; touched: boolean }

const UNTOUCHED: ItemOutcome = { created: 0, touched: false }

// One auto item: plan the target keys outside the lock, then re-read and
// re-check under the lock of `recurring` + those keys. When an edit in
// between needs a key that isn't locked, release and plan again.
async function processRecurringItem(
  first: RecurringItem,
  today: string,
): Promise<ItemOutcome> {
  let candidate: RecurringItem | undefined = first
  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      candidate = ((await readStore('recurring')) ?? []).find(
        (i) => i.id === first.id,
      )
    }
    if (!candidate || candidate.mode !== 'auto' || candidate.paused) {
      return UNTOUCHED
    }
    const planned = occurrencesBetween(
      candidate,
      candidate.handledThrough,
      today,
    )
    if (planned.length === 0) return UNTOUCHED
    const lockedTargets = occurrenceTargetKeys(candidate.kind, planned)

    const result = await withWriteLock(
      ['recurring', ...lockedTargets],
      async (): Promise<
        | { status: 'done' }
        | { status: 'retry' }
        | { status: 'written'; created: number; keys: Array<string> }
      > => {
        const items = (await readStore('recurring')) ?? []
        const index = items.findIndex((i) => i.id === first.id)
        if (index === -1) return { status: 'done' }
        const item = items[index]
        if (item.mode !== 'auto' || item.paused) return { status: 'done' }
        const dates = occurrencesBetween(item, item.handledThrough, today)
        if (dates.length === 0) return { status: 'done' }
        if (
          occurrenceTargetKeys(item.kind, dates).some(
            (k) => !lockedTargets.includes(k),
          )
        ) {
          return { status: 'retry' }
        }

        // D2: never write records with a dangling category; the item stays
        // pending until the user picks one.
        if (!(await categoryIdsFor(item.kind)).includes(item.categoryId)) {
          console.warn(
            `Recurring item ${item.id}: category ${item.categoryId} not found, skipped`,
          )
          return { status: 'done' }
        }

        // Dates already handled out of order (an ask item switched to auto)
        // are not created again.
        const ahead = new Set(item.handledAhead)
        const toCreate = dates.filter((d) => !ahead.has(d))
        const plan = await planOccurrenceWrites(item, toCreate)
        const handledThrough = dates[dates.length - 1]
        const nextItems = [...items]
        nextItems[index] = {
          ...item,
          handledThrough,
          handledAhead: item.handledAhead.filter((d) => d > handledThrough),
          occurrenceCount: item.occurrenceCount + toCreate.length,
          updatedAt: new Date().toISOString(),
        }
        const values = { recurring: nextItems, ...plan.values }
        await writeKeysMany(values)
        return {
          status: 'written',
          created: plan.created,
          keys: Object.keys(values),
        }
      },
    )

    if (result.status === 'retry') continue
    if (result.status === 'done') return UNTOUCHED
    await afterCommit(result.keys)
    return { created: result.created, touched: true }
  }
  console.warn(
    `Recurring item ${first.id} kept changing while being processed; will retry later`,
  )
  return UNTOUCHED
}

// Creates the due occurrences of every active auto-mode item, one item at a
// time, each in its own transaction. `created` counts records actually
// written; `itemsTouched` counts items whose entry was written. Any error
// (DecryptError, a failed setMany) propagates; items committed before it stay
// committed.
export async function processDueRecurring(
  today: string = toLocalDateString(),
): Promise<{ created: number; itemsTouched: number }> {
  if (!_key || !store) return { created: 0, itemsTouched: 0 }
  const items = (await readStore('recurring')) ?? []
  let created = 0
  let itemsTouched = 0
  for (const item of items) {
    if (item.mode !== 'auto' || item.paused) continue
    const outcome = await processRecurringItem(item, today)
    created += outcome.created
    if (outcome.touched) itemsTouched++
  }
  return { created, itemsTouched }
}

export async function addRecurring(
  input: CreateRecurringInput,
  options: { createThroughToday: boolean; today?: string },
): Promise<RecurringItem> {
  const today = options.today ?? toLocalDateString()
  // Validate the shape before planning, so the schedule maths only sees a
  // valid schedule. The category is checked again under the lock.
  const base = recurringInputSchema.safeParse(input)
  if (!base.success) throw new Error(base.error.issues[0].message)
  const through = occurrencesBetween(base.data, null, today)
  const createNow =
    options.createThroughToday && base.data.mode === 'auto' && through.length > 0
  const targetKeys = createNow
    ? occurrenceTargetKeys(base.data.kind, through)
    : []

  const { item, keys: written } = await withWriteLock(
    ['recurring', ...targetKeys],
    async () => {
      const data = await validateRecurringInput(input)
      const now = new Date().toISOString()
      // Ask mode with createThroughToday leaves the past occurrences due.
      const leaveDue = options.createThroughToday && data.mode === 'ask'
      const created: RecurringItem = {
        id: crypto.randomUUID(),
        kind: data.kind,
        amount: data.amount,
        currency: data.currency,
        categoryId: data.categoryId,
        description: data.description ?? null,
        frequency: data.frequency,
        startDate: data.startDate,
        end: data.end,
        mode: data.mode,
        paused: false,
        handledThrough: leaveDue ? null : (through[through.length - 1] ?? null),
        handledAhead: [],
        occurrenceCount: leaveDue ? 0 : through.length,
        createdAt: now,
        updatedAt: now,
      }
      const records = createNow
        ? (await planOccurrenceWrites(created, through)).values
        : {}
      const items = (await readStore('recurring')) ?? []
      const values = { recurring: [...items, created], ...records }
      await writeKeysMany(values)
      return { item: created, keys: Object.keys(values) }
    },
  )
  await afterCommit(written)
  return item
}

export async function updateRecurring(
  id: string,
  patch: UpdateRecurringInput,
): Promise<RecurringItem> {
  const result = await withWriteLock('recurring', async () => {
    const items = (await readStore('recurring')) ?? []
    const index = items.findIndex((i) => i.id === id)
    if (index === -1) throw new Error(`Recurring item not found: ${id}`)
    const existing = items[index]
    const defined = Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      ),
    ) as UpdateRecurringInput
    const data = await validateRecurringInput({
      kind: existing.kind,
      amount: existing.amount,
      currency: existing.currency,
      categoryId: existing.categoryId,
      description: existing.description,
      frequency: existing.frequency,
      startDate: existing.startDate,
      end: existing.end,
      mode: existing.mode,
      ...defined,
    })
    // Edits apply to future occurrences only: the progress fields are kept
    // and already created records are never touched.
    const updated: RecurringItem = {
      ...existing,
      kind: data.kind,
      amount: data.amount,
      currency: data.currency,
      categoryId: data.categoryId,
      description: data.description ?? null,
      frequency: data.frequency,
      startDate: data.startDate,
      end: data.end,
      mode: data.mode,
      updatedAt: new Date().toISOString(),
    }
    const next = [...items]
    next[index] = updated
    await writeStoreMany({ recurring: next })
    return updated
  })
  await afterCommit(['recurring'])
  return result
}

// Pausing stops generation. Resuming skips the occurrences that fell inside
// the pause (D3): handledThrough moves to the last occurrence before today,
// so today's occurrence onward is generated as normal.
export async function setRecurringPaused(
  id: string,
  paused: boolean,
  today: string = toLocalDateString(),
): Promise<RecurringItem> {
  const result = await withWriteLock('recurring', async () => {
    const items = (await readStore('recurring')) ?? []
    const index = items.findIndex((i) => i.id === id)
    if (index === -1) throw new Error(`Recurring item not found: ${id}`)
    const existing = items[index]
    let updated: RecurringItem = {
      ...existing,
      paused,
      updatedAt: new Date().toISOString(),
    }
    if (!paused && existing.paused) {
      let handledThrough = existing.handledThrough
      const last = lastOccurrenceOnOrBefore(
        existing,
        addDaysToDate(today, -1),
      )
      if (last !== null && (handledThrough === null || last > handledThrough)) {
        handledThrough = last
      }
      const ahead = new Set(existing.handledAhead)
      for (;;) {
        const next = nextOccurrence(existing, handledThrough)
        if (next === null || !ahead.has(next)) break
        handledThrough = next
      }
      const through = handledThrough
      updated = {
        ...updated,
        handledThrough: through,
        handledAhead: existing.handledAhead.filter(
          (d) => through === null || d > through,
        ),
      }
    }
    const next = [...items]
    next[index] = updated
    await writeStoreMany({ recurring: next })
    return updated
  })
  await afterCommit(['recurring'])
  return result
}

// Removes the item only: the records it created keep their recurringId and
// become ordinary records.
export async function deleteRecurring(id: string): Promise<void> {
  await withWriteLock('recurring', async () => {
    const items = (await readStore('recurring')) ?? []
    await writeStoreMany({ recurring: items.filter((i) => i.id !== id) })
  })
  await afterCommit(['recurring'])
}

// Ask mode: creates the record for one due occurrence (with optional
// overrides for that record only) and marks the date handled. When a record
// for the date already exists, nothing new is created.
export async function confirmRecurringOccurrence(
  itemId: string,
  date: string,
  overrides?: OccurrenceOverrides,
): Promise<void> {
  if (!DATE_STRING_RE.test(date)) throw new Error('Occurrence is not due')
  // The target is `income` or the chunk of this date, depending on the
  // item's kind; locking both avoids reading the item before the lock.
  const lockKeys = [
    'recurring',
    'income',
    expenseChunkKey(occurrenceCreatedAt(date)),
  ]
  const written = await withWriteLock(lockKeys, async () => {
    const items = (await readStore('recurring')) ?? []
    const index = items.findIndex((i) => i.id === itemId)
    if (index === -1) throw new Error(`Recurring item not found: ${itemId}`)
    const item = items[index]
    if (!isUnhandledOccurrence(item, date)) {
      throw new Error('Occurrence is not due')
    }
    if (!(await categoryIdsFor(item.kind)).includes(item.categoryId)) {
      throw new Error('Category not found')
    }
    const plan = await planOccurrenceWrites(item, [date], overrides)
    const next = [...items]
    next[index] = {
      ...markOccurrenceHandled(item, date),
      updatedAt: new Date().toISOString(),
    }
    const values = { recurring: next, ...plan.values }
    await writeKeysMany(values)
    return Object.keys(values)
  })
  await afterCommit(written)
}

// Ask mode: marks one due occurrence handled without creating anything.
export async function skipRecurringOccurrence(
  itemId: string,
  date: string,
): Promise<void> {
  await withWriteLock('recurring', async () => {
    const items = (await readStore('recurring')) ?? []
    const index = items.findIndex((i) => i.id === itemId)
    if (index === -1) throw new Error(`Recurring item not found: ${itemId}`)
    const item = items[index]
    if (!isUnhandledOccurrence(item, date)) {
      throw new Error('Occurrence is not due')
    }
    const next = [...items]
    next[index] = {
      ...markOccurrenceHandled(item, date),
      updatedAt: new Date().toISOString(),
    }
    await writeStoreMany({ recurring: next })
  })
  await afterCommit(['recurring'])
}

type QuickRepeatUnit = 'week' | 'month' | 'year'

// The auto-mode item behind a Quick Add / Add Income "Repeat": starts today
// and today's occurrence is already handled (the record saved with it).
function quickRepeatItem(
  kind: RecurringKind,
  input: CreateExpenseInput | CreateIncomeInput,
  unit: QuickRepeatUnit,
  today: string,
  now: string,
  id: string,
): RecurringItem {
  return {
    id,
    kind,
    amount: input.amount,
    currency: input.currency,
    categoryId: input.categoryId,
    description: input.description ?? null,
    frequency: { unit, interval: 1 },
    startDate: today,
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: today,
    handledAhead: [],
    occurrenceCount: 1,
    createdAt: now,
    updatedAt: now,
  }
}

// Saves the expense (as addExpense) and a matching auto-mode recurring item
// starting today, in one transaction.
export async function addRepeatingExpense(
  input: CreateExpenseInput,
  unit: QuickRepeatUnit,
): Promise<Expense> {
  if (
    input.createdAt !== undefined &&
    isNaN(new Date(input.createdAt).getTime())
  ) {
    throw new Error(`addRepeatingExpense: invalid createdAt "${input.createdAt}"`)
  }
  const today = toLocalDateString()
  const now = new Date().toISOString()
  const recurringId = crypto.randomUUID()
  const entry: Expense = {
    id: crypto.randomUUID(),
    amount: input.amount,
    currency: input.currency,
    categoryId: input.categoryId,
    description: input.description,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    recurringId,
    occurrenceDate: today,
  }
  const expenseConversion = conversionOnSave(entry, await readMainCurrency())
  if (expenseConversion) entry.conversion = expenseConversion
  const item = quickRepeatItem('expense', input, unit, today, now, recurringId)
  const chunkKey = expenseChunkKey(entry.createdAt)
  await withWriteLock([chunkKey, 'recurring'], async () => {
    const chunk = await readChunk(chunkKey)
    const items = (await readStore('recurring')) ?? []
    await writeKeysMany({
      [chunkKey]: [...chunk, entry],
      recurring: [...items, item],
    })
  })
  await afterCommit([chunkKey, 'recurring'])
  const categories = (await readStore('categories')) ?? []
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...entry, category }
}

// Saves the income entry (as addIncome) and a matching auto-mode recurring
// item starting today, in one transaction.
export async function addRepeatingIncome(
  input: CreateIncomeInput,
  unit: QuickRepeatUnit,
): Promise<IncomeEntry> {
  const today = toLocalDateString()
  const now = new Date().toISOString()
  const recurringId = crypto.randomUUID()
  const entry: IncomeEntry = {
    id: crypto.randomUUID(),
    categoryId: input.categoryId,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    recurringId,
    occurrenceDate: today,
  }
  const incomeConversion = conversionOnSave(entry, await readMainCurrency())
  if (incomeConversion) entry.conversion = incomeConversion
  const item = quickRepeatItem('income', input, unit, today, now, recurringId)
  await withWriteLock(['income', 'recurring'], async () => {
    const income = (await readStore('income')) ?? []
    const items = (await readStore('recurring')) ?? []
    await writeStoreMany({
      income: [...income, entry],
      recurring: [...items, item],
    })
  })
  await afterCommit(['income', 'recurring'])
  const categories = (await readStore('incomeCategories')) ?? []
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...entry, category }
}
