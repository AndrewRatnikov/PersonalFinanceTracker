import { clear, createStore, del, get, keys, set, setMany } from 'idb-keyval'

import { isMessageKey, translate } from '../i18n/core'
import { AppError } from './appErrors'
import { decryptValue, encryptValue } from './crypto'
import { DecryptError, isDataStorageKey, isDecryptError } from './dataErrors'
import { defaultExpenseCategories } from './defaultCategories'
import { DEFAULT_MAIN_CURRENCY, isCurrency } from './domain'
import { convertIncomeSources } from './incomeCategories'
import { identityConversion, isConverted } from './money'
import { occurrenceRecordId } from './occurrenceId'
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
import { isLive, mergeRecord, sameTimeWinner } from './syncRecords'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type { Lang } from '../i18n/lang'
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
  SyncedSettingsRecord,
  UpdateCategoryInput,
  UpdateExpenseInput,
  UpdateRecurringInput,
  UpsertBudgetInput,
} from './domain'
import type { SyncRecord, SyncRecordType } from './syncRecords'

export { DecryptError }

export const ENABLE_SUPABASE_SYNC = false
// When true, each write mutation should also call the corresponding server
// function in src/lib/expenses.ts / categories.ts / income.ts / budgets.ts,
// guarded behind a Premium check. Not implemented yet.

// Expenses are stored in per-month chunks: `expenses_YYYY_MM`.
// All other collections are small enough to store as single keys:
// `categories` (expense categories), `incomeCategories`, `income`, `budgets`,
// `recurring` (recurring items) and `syncedSettings` (ONE encrypted record
// with the settings that follow the user between devices).
// Income records reference an income category by `categoryId`; legacy records
// with a free-text `source` are converted by ensureIncomeCategories().
//
// Every mutation runs its whole read-modify-write under withWriteLock for the
// storage key(s) it touches, and announces the written keys on the sync
// channel after the write has committed. Reads throw DecryptError for a blob
// that cannot be decrypted; mutations never catch it, so a corrupt blob is
// never overwritten. Quarantined copies live under `quarantine:<key>:<ISO>`
// and are ignored by every reader. After each committed mutation (but not a
// quarantine, a compaction, a migration or the converter's own writes)
// `meta:settings.lastDataChangeAt` is set for the backup reminder.
//
// Sync groundwork:
// - Deletes are soft: a deleted record stays in its array (an expense in its
//   chunk) with `deletedAt = updatedAt = now` (a tombstone). Every reader
//   filters with isLive (syncRecords.ts) and the public API never returns a
//   tombstone or the local `rev`. Only quarantineKey, clearLocalDb and
//   compactTombstones really remove data.
// - Change sequence: the plaintext `meta:sync` holds `{ localRev }`. Every user
//   write locks `meta:sync`, stamps `rev = ++localRev` on each record it
//   creates, changes, deletes or undeletes, and writes the data keys and
//   `meta:sync` in ONE setMany. A write that sets `updatedAt` stamps `rev`;
//   derived writes (conversion, quarantine, migrations, incoming records,
//   compaction) stamp neither and never touch `meta:sync`.
// - Records generated for a recurring occurrence get the deterministic id
//   occurrenceRecordId(recurringId, occurrenceDate).
//
// Main currency: an entry saved in the main currency gets its identity
// `conversion` right away; any other entry is stored without one (pending).
// Every committed write to an entry key (an expense chunk or `income`) or to
// `syncedSettings` calls requestEntryConversion(), which conversion.ts listens
// to (this module never imports conversion.ts). The converter writes back
// through applyEntryConversions / convertBudgets, which don't trigger it again.
interface LocalDbMap {
  categories: Array<Category>
  incomeCategories: Array<Category>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  recurring: Array<RecurringItem>
  syncedSettings: SyncedSettingsRecord
}

type LocalDbKey = keyof LocalDbMap

/** Plaintext `{ localRev: number }`; a missing or invalid value means 0. */
export const SYNC_META_KEY = 'meta:sync'
/** The encrypted synced settings record. */
export const SYNCED_SETTINGS_KEY = 'syncedSettings'
/** updatedAt of a settings record that only holds defaults. */
export const SETTINGS_DEFAULT_UPDATED_AT = '1970-01-01T00:00:00.000Z'

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

// ── Records: liveness and the local rev ───────────────────────────────────────

type Revisioned = { rev?: number; deletedAt?: string }

// A copy without the local `rev` (never returned by the public API).
function withoutRev<T extends { rev?: number }>(record: T): T {
  if (!('rev' in record)) return record
  const copy = { ...record }
  delete copy.rev
  return copy
}

// The live records of a stored list, without `rev`.
function liveRecords<T extends Revisioned>(list: Array<T>): Array<T> {
  return list.filter(isLive).map(withoutRev)
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── The change counter (meta:sync) ────────────────────────────────────────────

function parseLocalRev(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0
  const value = (raw as { localRev?: unknown }).localRev
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0
}

// The plaintext change counter. Works before unlock.
export async function getLocalRev(): Promise<number> {
  if (!store) return 0
  return parseLocalRev(await get<unknown>(SYNC_META_KEY, store))
}

interface RevCounter {
  next: () => number
  readonly changed: boolean
  readonly last: number
}

// Only called inside a lock that includes SYNC_META_KEY. Nothing is written
// until writeKeysMany commits the counter together with the data.
async function openRevCounter(): Promise<RevCounter> {
  const start = await getLocalRev()
  let last = start
  return {
    next: () => ++last,
    get changed() {
      return last !== start
    },
    get last() {
      return last
    },
  }
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

// Encrypts every value (single keys or expense chunks) and writes them all in
// ONE IndexedDB transaction (idb-keyval setMany), together with any plaintext
// entries and, when the counter advanced, `meta:sync`. If the transaction
// fails nothing is written.
async function writeKeysMany(
  values: object,
  counter?: RevCounter,
  plain: Array<[string, unknown]> = [],
): Promise<void> {
  const key = _key
  if (!key) throw new Error('LocalDb not initialized')
  if (!store) return
  const entries: Array<[IDBValidKey, unknown]> = []
  for (const [k, v] of Object.entries(values)) {
    entries.push([k, await encryptValue(key, v)])
  }
  entries.push(...plain)
  if (counter?.changed) {
    entries.push([SYNC_META_KEY, { localRev: counter.last }])
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
        { ...stored, lastDataChangeAt: nowIso() },
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

// Runs after every committed data mutation (not after quarantine). Writes to
// entry keys or to the synced settings request a conversion, except the
// converter's own. `dataChange: false` skips lastDataChangeAt (the converter's
// background writes).
async function afterCommit(
  changedKeys: Array<string>,
  opts: { fromConversion?: boolean; dataChange?: boolean } = {},
): Promise<void> {
  postChanged(changedKeys)
  if (opts.dataChange !== false) await markDataChanged()
  if (
    !opts.fromConversion &&
    changedKeys.some((k) => isEntryKey(k) || k === SYNCED_SETTINGS_KEY)
  ) {
    requestEntryConversion()
  }
}

// ── Synced settings ───────────────────────────────────────────────────────────

const DEFAULT_FETCH_EXCHANGE_RATES = true

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// A record from the legacy plaintext `meta:settings` fields, else the defaults.
function settingsFromLegacy(
  plain: Record<string, unknown> | null,
): SyncedSettingsRecord {
  const main = plain?.mainCurrency
  const fetchRates = plain?.fetchExchangeRates
  return {
    id: 'settings',
    mainCurrency: isCurrency(main) ? main : DEFAULT_MAIN_CURRENCY,
    fetchExchangeRates:
      typeof fetchRates === 'boolean' ? fetchRates : DEFAULT_FETCH_EXCHANGE_RATES,
    updatedAt: SETTINGS_DEFAULT_UPDATED_AT,
  }
}

// A stored record with invalid fields read as their defaults; never `rev`.
function normalizeSettings(value: unknown): SyncedSettingsRecord {
  const record = asObject(value)
  const main = record?.mainCurrency
  const fetchRates = record?.fetchExchangeRates
  const updatedAt = record?.updatedAt
  return {
    id: 'settings',
    mainCurrency: isCurrency(main) ? main : DEFAULT_MAIN_CURRENCY,
    fetchExchangeRates:
      typeof fetchRates === 'boolean' ? fetchRates : DEFAULT_FETCH_EXCHANGE_RATES,
    updatedAt:
      typeof updatedAt === 'string' ? updatedAt : SETTINGS_DEFAULT_UPDATED_AT,
  }
}

// `meta:settings` without the legacy currency fields, or null when it has
// neither field (nothing to strip).
function stripLegacyCurrency(
  plain: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!plain) return null
  if (!('mainCurrency' in plain) && !('fetchExchangeRates' in plain)) {
    return null
  }
  const copy = { ...plain }
  delete copy.mainCurrency
  delete copy.fetchExchangeRates
  return copy
}

async function readPlainSettings(
  s: UseStore,
): Promise<Record<string, unknown> | null> {
  return asObject(await get<unknown>(META_SETTINGS_KEY, s))
}

// The synced settings (no lock: a read). Before unlock, or while the record
// doesn't exist yet, the legacy plaintext fields or the defaults. An
// unreadable record throws DecryptError('syncedSettings').
export async function readSyncedSettings(): Promise<SyncedSettingsRecord> {
  const s = store
  if (!s) return settingsFromLegacy(null)
  const stored = await readStore('syncedSettings')
  if (stored !== undefined) return normalizeSettings(stored)
  return settingsFromLegacy(await readPlainSettings(s))
}

// The stored main currency. A DecryptError propagates; any other failure
// falls back to the default.
async function readMainCurrency(): Promise<Currency> {
  try {
    return (await readSyncedSettings()).mainCurrency
  } catch (err) {
    if (isDecryptError(err)) throw err
    console.error('Could not read the main currency:', err)
    return DEFAULT_MAIN_CURRENCY
  }
}

// Creates the `syncedSettings` record from the legacy `meta:settings` fields
// (defaults when absent) and removes those fields from `meta:settings`, in ONE
// setMany. A derived write: no rev, no meta:sync, no lastDataChangeAt, no
// conversion request. Idempotent: does nothing (false) when the record already
// exists, even as an unreadable blob, or while the app is locked.
export async function migrateSyncedSettings(): Promise<boolean> {
  const s = store
  if (!s || !_key) return false
  const migrated = await withWriteLock(
    [META_SETTINGS_KEY, SYNCED_SETTINGS_KEY],
    async () => {
      if ((await get<unknown>(SYNCED_SETTINGS_KEY, s)) !== undefined) {
        return false
      }
      const plain = await readPlainSettings(s)
      const record = settingsFromLegacy(plain)
      const hadLegacyValue =
        isCurrency(plain?.mainCurrency) ||
        typeof plain?.fetchExchangeRates === 'boolean'
      if (hadLegacyValue) record.updatedAt = nowIso()
      const stripped = stripLegacyCurrency(plain)
      await writeKeysMany(
        { [SYNCED_SETTINGS_KEY]: record },
        undefined,
        stripped ? [[META_SETTINGS_KEY, stripped]] : [],
      )
      return true
    },
  )
  if (migrated) postChanged([SYNCED_SETTINGS_KEY])
  return migrated
}

// Patches the synced settings (only `fetchExchangeRates`; the main currency
// changes through convertBudgets). Stamps updatedAt and a rev, and strips the
// legacy fields from `meta:settings` in the same transaction. An empty or
// invalid patch writes nothing.
export async function updateSyncedSettings(patch: {
  fetchExchangeRates?: boolean
}): Promise<void> {
  const value = patch.fetchExchangeRates
  if (typeof value !== 'boolean') return
  const s = store
  if (!s) return
  const written = await withWriteLock(
    [META_SETTINGS_KEY, SYNC_META_KEY, SYNCED_SETTINGS_KEY],
    async () => {
      const current = await readSyncedSettings()
      const counter = await openRevCounter()
      const record: SyncedSettingsRecord = {
        ...current,
        fetchExchangeRates: value,
        updatedAt: nowIso(),
        rev: counter.next(),
      }
      const stripped = stripLegacyCurrency(await readPlainSettings(s))
      await writeKeysMany(
        { [SYNCED_SETTINGS_KEY]: record },
        counter,
        stripped ? [[META_SETTINGS_KEY, stripped]] : [],
      )
      return stripped
        ? [SYNCED_SETTINGS_KEY, META_SETTINGS_KEY]
        : [SYNCED_SETTINGS_KEY]
    },
  )
  await afterCommit(written)
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
    const target = `quarantine:${storageKey}:${nowIso()}`
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

// ── Soft deletes ──────────────────────────────────────────────────────────────

type SingleListKey = 'categories' | 'incomeCategories' | 'income' | 'budgets' | 'recurring'

// Turns the live record `id` of a single key into a tombstone. Returns false
// (nothing written) when there is no live record with that id.
async function softDeleteIn(key: SingleListKey, id: string): Promise<boolean> {
  return withWriteLock([key, SYNC_META_KEY], async () => {
    const list = ((await readStore(key)) ?? []) as Array<
      { id: string; updatedAt?: string } & Revisioned
    >
    const index = list.findIndex((r) => r.id === id && isLive(r))
    if (index === -1) return false
    const counter = await openRevCounter()
    const now = nowIso()
    const next = [...list]
    next[index] = { ...list[index], deletedAt: now, updatedAt: now, rev: counter.next() }
    await writeKeysMany({ [key]: next }, counter)
    return true
  })
}

// ── Expenses ──────────────────────────────────────────────────────────────────

async function liveCategories(key: CategoryKey): Promise<Array<Category>> {
  return liveRecords((await readStore(key)) ?? [])
}

async function joinCategories(
  expenses: Array<Expense>,
): Promise<Array<Expense>> {
  const categoryMap = new Map(
    (await liveCategories('categories')).map((c) => [c.id, c]),
  )
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
  const expenses = liveRecords(chunks.flat())
    .filter((e) => e.createdAt >= from && e.createdAt <= to)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return joinCategories(expenses)
}

// TODO: could possible create a spike if user will export all data for 5 years
export async function getAllExpenses(): Promise<Array<Expense>> {
  const chunkKeys = await allExpenseChunkKeys()
  const chunks = await Promise.all(chunkKeys.map(readChunk))
  const expenses = liveRecords(chunks.flat()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )
  return joinCategories(expenses)
}

async function withExpenseCategory(entry: Expense): Promise<Expense> {
  const categories = await liveCategories('categories')
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...withoutRev(entry), category }
}

export async function addExpense(input: CreateExpenseInput): Promise<Expense> {
  if (
    input.createdAt !== undefined &&
    isNaN(new Date(input.createdAt).getTime())
  ) {
    throw new Error(`addExpense: invalid createdAt "${input.createdAt}"`)
  }
  const now = nowIso()
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
  await withWriteLock([chunkKey, SYNC_META_KEY], async () => {
    const existing = await readChunk(chunkKey)
    const counter = await openRevCounter()
    await writeKeysMany(
      { [chunkKey]: [...existing, { ...entry, rev: counter.next() }] },
      counter,
    )
  })
  await afterCommit([chunkKey])
  return withExpenseCategory(entry)
}

// createdAt is required so we can derive the correct chunk without a full scan.
// The record stays in its chunk as a tombstone. Deleting a missing or already
// deleted expense writes nothing.
export async function deleteExpense(
  id: string,
  createdAt: string,
): Promise<void> {
  const chunkKey = expenseChunkKey(createdAt)
  const wrote = await withWriteLock([chunkKey, SYNC_META_KEY], async () => {
    const chunk = await readChunk(chunkKey)
    const index = chunk.findIndex((e) => e.id === id && isLive(e))
    if (index === -1) return false
    const counter = await openRevCounter()
    const now = nowIso()
    const next = [...chunk]
    next[index] = { ...chunk[index], deletedAt: now, updatedAt: now, rev: counter.next() }
    await writeKeysMany({ [chunkKey]: next }, counter)
    return true
  })
  if (wrote) await afterCommit([chunkKey])
}

// Undo of a delete: clears deletedAt, bumps updatedAt and stamps a new rev.
// An expense that is already live is returned unchanged (nothing written).
export async function undeleteExpense(
  id: string,
  createdAt: string,
): Promise<Expense> {
  const chunkKey = expenseChunkKey(createdAt)
  const { record, wrote } = await withWriteLock(
    [chunkKey, SYNC_META_KEY],
    async () => {
      const chunk = await readChunk(chunkKey)
      const live = chunk.find((e) => e.id === id && isLive(e))
      if (live) return { record: live, wrote: false }
      const index = chunk.findIndex((e) => e.id === id)
      if (index === -1) {
        throw new Error(`undeleteExpense: expense not found: ${id}`)
      }
      const counter = await openRevCounter()
      const revived: Expense = { ...chunk[index], updatedAt: nowIso() }
      delete revived.deletedAt
      revived.rev = counter.next()
      const next = [...chunk]
      next[index] = revived
      await writeKeysMany({ [chunkKey]: next }, counter)
      return { record: revived, wrote: true }
    },
  )
  if (wrote) await afterCommit([chunkKey])
  return withExpenseCategory(record)
}

// originalCreatedAt locates the current chunk; if the patch moves createdAt
// into a different month the record is moved to that month's chunk. Both
// chunks and meta:sync are written in ONE setMany.
export async function updateExpense(
  id: string,
  originalCreatedAt: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  const oldKey = expenseChunkKey(originalCreatedAt)
  const main = await readMainCurrency()
  const lockKeys = [oldKey, SYNC_META_KEY]
  if (
    patch.createdAt !== undefined &&
    !isNaN(new Date(patch.createdAt).getTime())
  ) {
    lockKeys.push(expenseChunkKey(patch.createdAt))
  }

  const { result, written } = await withWriteLock(lockKeys, async () => {
    const oldChunk = await readChunk(oldKey)
    const index = oldChunk.findIndex((e) => e.id === id && isLive(e))
    if (index === -1) {
      throw new Error(`updateExpense: expense not found: ${id}`)
    }
    const existing = oldChunk[index]

    const createdAt = patch.createdAt ?? existing.createdAt
    if (isNaN(new Date(createdAt).getTime())) {
      throw new Error(`updateExpense: invalid createdAt "${createdAt}"`)
    }

    const categories = await liveCategories('categories')
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
      updatedAt: nowIso(),
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

    const counter = await openRevCounter()
    const stored: Expense = { ...updated, rev: counter.next() }
    const newKey = expenseChunkKey(createdAt)
    let writtenKeys: Array<string>
    if (newKey === oldKey) {
      const next = [...oldChunk]
      next[index] = stored
      await writeKeysMany({ [oldKey]: next }, counter)
      writtenKeys = [oldKey]
    } else {
      // One transaction: the record is never lost or duplicated.
      const newChunk = await readChunk(newKey)
      await writeKeysMany(
        {
          [newKey]: [...newChunk.filter((e) => e.id !== id), stored],
          [oldKey]: oldChunk.filter((e) => e.id !== id),
        },
        counter,
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
  return liveCategories('categories')
}

type CategoryKey = 'categories' | 'incomeCategories'

function categoryNotFound(id: string): AppError {
  return new AppError('category-not-found', `Category not found: ${id}`, { id })
}

// Shared by the expense and the income category mutations: the whole
// read-modify-write runs under the lock of `key`. Names are trimmed and unique
// among the live categories, ignoring case (a deleted name can be reused; it
// gets a new id).
async function addCategoryIn(
  key: CategoryKey,
  input: CreateCategoryInput,
): Promise<Category> {
  const entry = await withWriteLock([key, SYNC_META_KEY], async () => {
    const categories = (await readStore(key)) ?? []
    const name = input.name.trim()
    if (!name) throw new AppError('category-name-required', 'Category name is required')
    if (
      categories.some(
        (c) => isLive(c) && c.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new AppError('category-exists', `Category "${name}" already exists`, {
        name,
      })
    }
    const created: Category = {
      id: crypto.randomUUID(),
      name,
      icon: input.icon ?? null,
      updatedAt: nowIso(),
    }
    const counter = await openRevCounter()
    await writeKeysMany(
      { [key]: [...categories, { ...created, rev: counter.next() }] },
      counter,
    )
    return created
  })
  await afterCommit([key])
  return entry
}

async function updateCategoryIn(
  key: CategoryKey,
  input: UpdateCategoryInput,
): Promise<Category> {
  const result = await withWriteLock([key, SYNC_META_KEY], async () => {
    const categories = (await readStore(key)) ?? []
    const name = input.name.trim()
    if (!name) throw new AppError('category-name-required', 'Category name is required')
    const index = categories.findIndex((c) => c.id === input.id && isLive(c))
    if (index === -1) throw categoryNotFound(input.id)
    if (
      categories.some(
        (c) =>
          c.id !== input.id &&
          isLive(c) &&
          c.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new AppError('category-exists', `Category "${name}" already exists`, {
        name,
      })
    }
    // defaultCurrency: undefined keeps the stored value (a rename keeps it),
    // null removes the key (never stored as null), a currency sets it.
    const nextCurrency = input.defaultCurrency
    if (
      nextCurrency !== undefined &&
      nextCurrency !== null &&
      !isCurrency(nextCurrency)
    ) {
      throw new AppError('invalid-currency', 'Invalid currency')
    }
    const updated: Category = {
      ...withoutRev(categories[index]),
      name,
      icon: input.icon ?? null,
      updatedAt: nowIso(),
    }
    if (nextCurrency === null) delete updated.defaultCurrency
    else if (nextCurrency !== undefined) updated.defaultCurrency = nextCurrency
    const counter = await openRevCounter()
    const next = [...categories]
    next[index] = { ...updated, rev: counter.next() }
    await writeKeysMany({ [key]: next }, counter)
    return updated
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

// Refuses while a live recurring item of `kind` uses the category.
async function assertNoRecurringUses(
  kind: RecurringKind,
  categoryId: string,
): Promise<void> {
  const items = (await readStore('recurring')) ?? []
  const using = items.filter(
    (i) => isLive(i) && i.kind === kind && i.categoryId === categoryId,
  ).length
  if (using > 0) {
    throw new AppError(
      'category-used-by-recurring',
      `Used by ${using} recurring item${using === 1 ? '' : 's'}`,
      { count: using },
    )
  }
}

// Refused while live expenses or live recurring items use the category.
// Otherwise the category and every live budget of it become tombstones, in
// one transaction.
export async function deleteCategory(id: string): Promise<void> {
  const written = await withWriteLock(
    ['budgets', 'categories', 'recurring', SYNC_META_KEY],
    async () => {
      // Check all expense chunks for references to this category. This only
      // reads chunks, so it takes no chunk locks.
      const chunkKeys = await allExpenseChunkKeys()
      const chunks = await Promise.all(chunkKeys.map(readChunk))
      const using = chunks
        .flat()
        .filter((e) => isLive(e) && e.categoryId === id).length
      if (using > 0) {
        throw new AppError(
          'category-used-by-expenses',
          `${using} expense${using === 1 ? '' : 's'} use this category`,
          { count: using },
        )
      }
      await assertNoRecurringUses('expense', id)
      const categories = (await readStore('categories')) ?? []
      const index = categories.findIndex((c) => c.id === id && isLive(c))
      if (index === -1) return []

      const counter = await openRevCounter()
      const now = nowIso()
      const nextCategories = [...categories]
      nextCategories[index] = {
        ...categories[index],
        deletedAt: now,
        updatedAt: now,
        rev: counter.next(),
      }
      const values: Partial<LocalDbMap> = { categories: nextCategories }

      const budgets = (await readStore('budgets')) ?? []
      const nextBudgets = budgets.map((b) =>
        b.categoryId !== id || !isLive(b)
          ? b
          : { ...b, deletedAt: now, updatedAt: now, rev: counter.next() },
      )
      const budgetsChanged = nextBudgets.some((b, i) => b !== budgets[i])
      if (budgetsChanged) values.budgets = nextBudgets
      await writeKeysMany(values, counter)
      return budgetsChanged ? ['categories', 'budgets'] : ['categories']
    },
  )
  if (written.length > 0) await afterCommit(written)
}

// Writes the default expense categories in `lang` when there are no live
// categories yet. Existing categories are user data and are never renamed.
export async function provisionDefaultCategories(lang: Lang = 'en'): Promise<void> {
  const wrote = await withWriteLock(['categories', SYNC_META_KEY], async () => {
    const categories = (await readStore('categories')) ?? []
    if (categories.some(isLive)) return false
    const updatedAt = nowIso()
    const counter = await openRevCounter()
    const defaults: Array<Category> = defaultExpenseCategories(lang).map((c) => ({
      id: crypto.randomUUID(),
      name: c.name,
      icon: c.icon,
      updatedAt,
      rev: counter.next(),
    }))
    await writeKeysMany({ categories: [...categories, ...defaults] }, counter)
    return true
  })
  if (wrote) await afterCommit(['categories'])
}

// ── Income categories ─────────────────────────────────────────────────────────

export async function getAllIncomeCategories(): Promise<Array<Category>> {
  return liveCategories('incomeCategories')
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

// Refused while live income entries or live income recurring items use it.
export async function deleteIncomeCategory(id: string): Promise<void> {
  const wrote = await withWriteLock(
    ['income', 'incomeCategories', 'recurring', SYNC_META_KEY],
    async () => {
      const income = (await readStore('income')) ?? []
      const using = income.filter((e) => isLive(e) && e.categoryId === id).length
      if (using > 0) {
        throw new AppError(
          'category-used-by-income',
          using === 1
            ? '1 income entry uses this category'
            : `${using} income entries use this category`,
          { count: using },
        )
      }
      await assertNoRecurringUses('income', id)
      const categories = (await readStore('incomeCategories')) ?? []
      const index = categories.findIndex((c) => c.id === id && isLive(c))
      if (index === -1) return false
      const counter = await openRevCounter()
      const now = nowIso()
      const next = [...categories]
      next[index] = { ...categories[index], deletedAt: now, updatedAt: now, rev: counter.next() }
      await writeKeysMany({ incomeCategories: next }, counter)
      return true
    },
  )
  if (wrote) await afterCommit(['incomeCategories'])
}

// Provisions the default income categories and converts legacy free-text
// income sources into categories, once: when `incomeCategories` already
// exists (even as an unreadable blob) it does nothing. Both keys and meta:sync
// are written in one transaction; each created category gets a rev, the
// rewritten income records (a derived field) don't. A DecryptError on
// `income` propagates and nothing is written. Returns true when it wrote.
// `lang` is the language of the defaults and of the "Other" fallback.
export async function ensureIncomeCategories(lang: Lang = 'en'): Promise<boolean> {
  const s = store
  if (!_key || !s) return false
  const wrote = await withWriteLock(
    ['income', 'incomeCategories', SYNC_META_KEY],
    async () => {
      const existing = await get<unknown>('incomeCategories', s)
      if (existing !== undefined) return false
      const income = (await readStore('income')) ?? []
      const converted = convertIncomeSources(income, [], { addDefaults: true, lang })
      const counter = await openRevCounter()
      const incomeCategories = converted.incomeCategories.map((c) => ({
        ...c,
        rev: counter.next(),
      }))
      await writeKeysMany({ incomeCategories, income: converted.income }, counter)
      return true
    },
  )
  if (wrote) await afterCommit(['incomeCategories', 'income'])
  return wrote
}

// Runs after every unlock: the synced settings migration first, then default
// expense categories for a new vault, then the income categories (defaults
// and legacy conversion), then the due recurring occurrences. Errors,
// including DecryptError, propagate to the caller. Returns how many recurring
// records were created. `lang` is the language of the default categories
// (only used when they are written).
export async function prepareUnlockedVault({
  isNewVault,
  lang = 'en',
}: {
  isNewVault: boolean
  lang?: Lang
}): Promise<{ recurringCreated: number }> {
  await migrateSyncedSettings()
  if (isNewVault) await provisionDefaultCategories(lang)
  await ensureIncomeCategories(lang)
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
  const income = liveRecords((await readStore('income')) ?? [])
  return joinIncomeCategories(income, await liveCategories('incomeCategories'))
}

async function withIncomeCategory(entry: IncomeEntry): Promise<IncomeEntry> {
  const categories = await liveCategories('incomeCategories')
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...withoutRev(entry), category }
}

export async function addIncome(
  input: CreateIncomeInput,
): Promise<IncomeEntry> {
  const main = await readMainCurrency()
  const entry = await withWriteLock(['income', SYNC_META_KEY], async () => {
    const income = (await readStore('income')) ?? []
    const now = nowIso()
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
    const counter = await openRevCounter()
    await writeKeysMany(
      { income: [...income, { ...created, rev: counter.next() }] },
      counter,
    )
    return created
  })
  await afterCommit(['income'])
  return withIncomeCategory(entry)
}

export async function deleteIncome(id: string): Promise<void> {
  if (await softDeleteIn('income', id)) await afterCommit(['income'])
}

// ── Budgets ───────────────────────────────────────────────────────────────────

export async function getAllBudgets(): Promise<
  Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>
> {
  const budgets = liveRecords((await readStore('budgets')) ?? [])
  const categoryMap = new Map(
    (await liveCategories('categories')).map((c) => [c.id, c]),
  )
  return budgets.map((b) => {
    const cat = categoryMap.get(b.categoryId)
    return {
      ...b,
      categoryName: cat?.name ?? '',
      categoryIcon: cat?.icon ?? null,
    }
  })
}

// Updates the live budget of the category, or creates a new one (a new id,
// also after the old budget was deleted).
export async function upsertBudget(
  input: UpsertBudgetInput,
): Promise<BudgetEntry> {
  const result = await withWriteLock(['budgets', SYNC_META_KEY], async () => {
    const budgets = (await readStore('budgets')) ?? []
    const index = budgets.findIndex(
      (b) => b.categoryId === input.categoryId && isLive(b),
    )
    const updatedAt = nowIso()
    const counter = await openRevCounter()
    let entry: BudgetEntry
    const updated = [...budgets]
    if (index !== -1) {
      entry = {
        ...withoutRev(budgets[index]),
        monthlyLimit: input.monthlyLimit,
        currency: input.currency,
        updatedAt,
      }
      updated[index] = { ...entry, rev: counter.next() }
    } else {
      entry = {
        id: crypto.randomUUID(),
        categoryId: input.categoryId,
        monthlyLimit: input.monthlyLimit,
        currency: input.currency,
        updatedAt,
      }
      updated.push({ ...entry, rev: counter.next() })
    }
    await writeKeysMany({ budgets: updated }, counter)
    return entry
  })
  await afterCommit(['budgets'])
  return result
}

export async function deleteBudget(id: string): Promise<void> {
  if (await softDeleteIn('budgets', id)) await afterCommit(['budgets'])
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

// The raw stored entries (no joined category, tombstones included: callers
// filter with isLive): one group per expense chunk in ascending key order,
// then `income`. A DecryptError propagates.
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
// updated only when it still exists, is live, is not converted for
// `mainCurrency` yet and still has the amount, currency and createdAt the rate
// was computed for (an edit in between leaves it pending). Only `conversion`
// changes; updatedAt and rev stay (derived data, meta:sync untouched).
// Returns the number of records written.
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
        !isLive(record) ||
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
    await afterCommit([storageKey], { fromConversion: true, dataChange: false })
  }
  return written
}

// Converts every live budget not in `target` with `rateFor(budget.currency)`
// (unrounded) and, with setMainCurrency, stores `target` as the main currency
// in the synced settings record, in the SAME transaction. Every converted
// budget and the settings record get updatedAt = now and a rev (meta:sync in
// the same setMany). Without setMainCurrency (the one-time fix of budgets in
// another currency) it does nothing unless `target` is the stored main
// currency. A throwing rateFor writes nothing. Returns the number of budgets
// converted.
export async function convertBudgets(
  target: Currency,
  rateFor: (from: Currency) => number,
  options: { setMainCurrency: boolean },
): Promise<number> {
  const s = store
  if (!s) return 0
  const result = await withWriteLock(
    ['budgets', META_SETTINGS_KEY, SYNC_META_KEY, SYNCED_SETTINGS_KEY],
    async () => {
      const current = await readSyncedSettings()
      if (!options.setMainCurrency && current.mainCurrency !== target) {
        return { converted: 0, keys: [] as Array<string> }
      }
      if (!_key) throw new Error('LocalDb not initialized')

      const budgets = (await readStore('budgets')) ?? []
      const updatedAt = nowIso()
      const counter = await openRevCounter()
      let converted = 0
      const nextBudgets = budgets.map((b) => {
        if (!isLive(b) || b.currency === target) return b
        const rate = rateFor(b.currency)
        converted++
        return {
          ...b,
          monthlyLimit: b.monthlyLimit * rate,
          currency: target,
          updatedAt,
          rev: counter.next(),
        }
      })

      const values: Partial<LocalDbMap> = {}
      const plain: Array<[string, unknown]> = []
      const writtenKeys: Array<string> = []
      if (converted > 0) {
        values.budgets = nextBudgets
        writtenKeys.push('budgets')
      }
      if (options.setMainCurrency) {
        values.syncedSettings = {
          ...current,
          mainCurrency: target,
          updatedAt,
          rev: counter.next(),
        }
        writtenKeys.push(SYNCED_SETTINGS_KEY)
        const stripped = stripLegacyCurrency(await readPlainSettings(s))
        if (stripped) {
          plain.push([META_SETTINGS_KEY, stripped])
          writtenKeys.push(META_SETTINGS_KEY)
        }
      }
      await writeKeysMany(values, counter, plain)
      return { converted, keys: writtenKeys }
    },
  )
  if (result.keys.length > 0) {
    // The one-time fix is the converter's own background work, not a data
    // change for the backup reminder; a main-currency change is.
    await afterCommit(result.keys, {
      fromConversion: true,
      dataChange: options.setMainCurrency,
    })
  }
  return result.converted
}

// ── Recurring items ───────────────────────────────────────────────────────────
//
// Items live in the single key `recurring`. A generated record carries
// `recurringId` + `occurrenceDate` and the deterministic id
// occurrenceRecordId(recurringId, occurrenceDate): an occurrence that already
// has a record (another tab, a retry, a restored backup, a record deleted by
// the user) is never created again. Every write runs under the lock of
// `recurring`, `meta:sync` and every target key (expense chunks or `income`)
// and goes out in ONE setMany, so the item and its records commit together or
// not at all.

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

// The ids of the live categories of the item's kind.
async function categoryIdsFor(kind: RecurringKind): Promise<Array<string>> {
  return (await liveCategories(categoryKeyFor(kind))).map((c) => c.id)
}

// A zod issue message is a catalog key (errors.validation.*): the error keeps
// the key for the UI and today's English text as its message.
function validationError(key: string): AppError {
  const message = isMessageKey(key) ? translate('en', key) : key
  return new AppError('validation', message, { key })
}

function recurringNotFound(id: string): AppError {
  return new AppError('recurring-not-found', `Recurring item not found: ${id}`, { id })
}

function occurrenceNotDue(): AppError {
  return new AppError('occurrence-not-due', 'Occurrence is not due')
}

// Validates with recurringInputSchemaFor (the live categories of the input's
// kind) and throws the first issue (an AppError 'validation').
async function validateRecurringInput(
  input: CreateRecurringInput,
): Promise<CreateRecurringInput> {
  const base = recurringInputSchema.safeParse(input)
  if (!base.success) throw validationError(base.error.issues[0].message)
  const checked = recurringInputSchemaFor(
    await categoryIdsFor(base.data.kind),
  ).safeParse(input)
  if (!checked.success) throw validationError(checked.error.issues[0].message)
  return checked.data
}

// Builds one record per date, grouped by target key, each with the
// deterministic occurrence id and a rev from `counter`. A date is skipped when
// its target already holds a record (live or deleted) with the same
// recurringId + occurrenceDate or with the computed id. Returns only the
// targets that gained a record. Must run under the lock of every target key
// and meta:sync.
async function planOccurrenceWrites(
  item: RecurringItem,
  dates: Array<string>,
  counter: RevCounter,
  overrides?: OccurrenceOverrides,
): Promise<{ values: Record<string, Array<GeneratedRecord>>; created: number }> {
  const lists = new Map<string, Array<GeneratedRecord>>()
  const values: Record<string, Array<GeneratedRecord>> = {}
  const main = await readMainCurrency()
  let created = 0
  const now = nowIso()
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
    const id = await occurrenceRecordId(item.id, date)
    if (
      list.some(
        (r) =>
          r.id === id ||
          (r.recurringId === item.id && r.occurrenceDate === date),
      )
    ) {
      lists.set(key, list)
      continue
    }
    const record: GeneratedRecord = {
      id,
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
    record.rev = counter.next()
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
  return liveRecords((await readStore('recurring')) ?? [])
}

export async function getDueRecurring(
  today: string = toLocalDateString(),
): Promise<Array<RecurringOccurrence>> {
  return dueOccurrences(await getAllRecurring(), today)
}

// The index of the live item `id` in a stored list, or -1.
function liveItemIndex(items: Array<RecurringItem>, id: string): number {
  return items.findIndex((i) => i.id === id && isLive(i))
}

type ItemOutcome = { created: number; touched: boolean }

const UNTOUCHED: ItemOutcome = { created: 0, touched: false }

// One auto item: plan the target keys outside the lock, then re-read and
// re-check under the lock of `recurring` + meta:sync + those keys. When an
// edit in between needs a key that isn't locked, release and plan again.
async function processRecurringItem(
  first: RecurringItem,
  today: string,
): Promise<ItemOutcome> {
  let candidate: RecurringItem | undefined = first
  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      candidate = ((await readStore('recurring')) ?? []).find(
        (i) => i.id === first.id && isLive(i),
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
      ['recurring', SYNC_META_KEY, ...lockedTargets],
      async (): Promise<
        | { status: 'done' }
        | { status: 'retry' }
        | { status: 'written'; created: number; keys: Array<string> }
      > => {
        const items = (await readStore('recurring')) ?? []
        const index = liveItemIndex(items, first.id)
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
        const counter = await openRevCounter()
        const plan = await planOccurrenceWrites(item, toCreate, counter)
        const handledThrough = dates[dates.length - 1]
        const nextItems = [...items]
        nextItems[index] = {
          ...item,
          handledThrough,
          handledAhead: item.handledAhead.filter((d) => d > handledThrough),
          occurrenceCount: item.occurrenceCount + toCreate.length,
          updatedAt: nowIso(),
          rev: counter.next(),
        }
        const values = { recurring: nextItems, ...plan.values }
        await writeKeysMany(values, counter)
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

// Creates the due occurrences of every active, live auto-mode item, one item
// at a time, each in its own transaction. `created` counts records actually
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
    if (!isLive(item) || item.mode !== 'auto' || item.paused) continue
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
  if (!base.success) throw validationError(base.error.issues[0].message)
  const through = occurrencesBetween(base.data, null, today)
  const createNow =
    options.createThroughToday && base.data.mode === 'auto' && through.length > 0
  const targetKeys = createNow
    ? occurrenceTargetKeys(base.data.kind, through)
    : []

  const { item, keys: written } = await withWriteLock(
    ['recurring', SYNC_META_KEY, ...targetKeys],
    async () => {
      const data = await validateRecurringInput(input)
      const now = nowIso()
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
      const counter = await openRevCounter()
      const stored: RecurringItem = { ...created, rev: counter.next() }
      const records = createNow
        ? (await planOccurrenceWrites(created, through, counter)).values
        : {}
      const items = (await readStore('recurring')) ?? []
      const values = { recurring: [...items, stored], ...records }
      await writeKeysMany(values, counter)
      return { item: created, keys: Object.keys(values) }
    },
  )
  await afterCommit(written)
  return item
}

// Replaces the live item `id` with `update(existing)` (stamped with updatedAt
// and a rev) under the lock of `recurring` + meta:sync. Returns the updated
// item without rev.
async function updateRecurringItem(
  id: string,
  update: (existing: RecurringItem) => Promise<RecurringItem> | RecurringItem,
): Promise<RecurringItem> {
  const result = await withWriteLock(['recurring', SYNC_META_KEY], async () => {
    const items = (await readStore('recurring')) ?? []
    const index = liveItemIndex(items, id)
    if (index === -1) throw recurringNotFound(id)
    const updated: RecurringItem = {
      ...withoutRev(await update(items[index])),
      updatedAt: nowIso(),
    }
    const counter = await openRevCounter()
    const next = [...items]
    next[index] = { ...updated, rev: counter.next() }
    await writeKeysMany({ recurring: next }, counter)
    return updated
  })
  await afterCommit(['recurring'])
  return result
}

export async function updateRecurring(
  id: string,
  patch: UpdateRecurringInput,
): Promise<RecurringItem> {
  return updateRecurringItem(id, async (existing) => {
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
    return {
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
    }
  })
}

// Pausing stops generation. Resuming skips the occurrences that fell inside
// the pause (D3): handledThrough moves to the last occurrence before today,
// so today's occurrence onward is generated as normal.
export async function setRecurringPaused(
  id: string,
  paused: boolean,
  today: string = toLocalDateString(),
): Promise<RecurringItem> {
  return updateRecurringItem(id, (existing) => {
    let updated: RecurringItem = { ...existing, paused }
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
    return updated
  })
}

// Turns the item into a tombstone: the records it created keep their
// recurringId and become ordinary records.
export async function deleteRecurring(id: string): Promise<void> {
  if (await softDeleteIn('recurring', id)) await afterCommit(['recurring'])
}

// Ask mode: creates the record for one due occurrence (with optional
// overrides for that record only) and marks the date handled. When a record
// for the date already exists (even a deleted one), nothing new is created.
export async function confirmRecurringOccurrence(
  itemId: string,
  date: string,
  overrides?: OccurrenceOverrides,
): Promise<void> {
  if (!DATE_STRING_RE.test(date)) throw occurrenceNotDue()
  // The target is `income` or the chunk of this date, depending on the
  // item's kind; locking both avoids reading the item before the lock.
  const lockKeys = [
    'recurring',
    'income',
    SYNC_META_KEY,
    expenseChunkKey(occurrenceCreatedAt(date)),
  ]
  const written = await withWriteLock(lockKeys, async () => {
    const items = (await readStore('recurring')) ?? []
    const index = liveItemIndex(items, itemId)
    if (index === -1) throw recurringNotFound(itemId)
    const item = items[index]
    if (!isUnhandledOccurrence(item, date)) {
      throw occurrenceNotDue()
    }
    if (!(await categoryIdsFor(item.kind)).includes(item.categoryId)) {
      throw new AppError('category-not-found', 'Category not found')
    }
    const counter = await openRevCounter()
    const plan = await planOccurrenceWrites(item, [date], counter, overrides)
    const next = [...items]
    next[index] = {
      ...markOccurrenceHandled(item, date),
      updatedAt: nowIso(),
      rev: counter.next(),
    }
    const values = { recurring: next, ...plan.values }
    await writeKeysMany(values, counter)
    return Object.keys(values)
  })
  await afterCommit(written)
}

// Ask mode: marks one due occurrence handled without creating anything.
export async function skipRecurringOccurrence(
  itemId: string,
  date: string,
): Promise<void> {
  await updateRecurringItem(itemId, (item) => {
    if (!isUnhandledOccurrence(item, date)) {
      throw occurrenceNotDue()
    }
    return markOccurrenceHandled(item, date)
  })
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

// Saves the expense (as addExpense, with the deterministic occurrence id) and
// a matching auto-mode recurring item starting today, in one transaction.
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
  const now = nowIso()
  const recurringId = crypto.randomUUID()
  const entry: Expense = {
    id: await occurrenceRecordId(recurringId, today),
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
  await withWriteLock([chunkKey, 'recurring', SYNC_META_KEY], async () => {
    const chunk = await readChunk(chunkKey)
    const items = (await readStore('recurring')) ?? []
    const counter = await openRevCounter()
    await writeKeysMany(
      {
        [chunkKey]: [...chunk, { ...entry, rev: counter.next() }],
        recurring: [...items, { ...item, rev: counter.next() }],
      },
      counter,
    )
  })
  await afterCommit([chunkKey, 'recurring'])
  return withExpenseCategory(entry)
}

// Saves the income entry (as addIncome, with the deterministic occurrence id)
// and a matching auto-mode recurring item starting today, in one transaction.
export async function addRepeatingIncome(
  input: CreateIncomeInput,
  unit: QuickRepeatUnit,
): Promise<IncomeEntry> {
  const today = toLocalDateString()
  const now = nowIso()
  const recurringId = crypto.randomUUID()
  const entry: IncomeEntry = {
    id: await occurrenceRecordId(recurringId, today),
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
  await withWriteLock(['income', 'recurring', SYNC_META_KEY], async () => {
    const income = (await readStore('income')) ?? []
    const items = (await readStore('recurring')) ?? []
    const counter = await openRevCounter()
    await writeKeysMany(
      {
        income: [...income, { ...entry, rev: counter.next() }],
        recurring: [...items, { ...item, rev: counter.next() }],
      },
      counter,
    )
  })
  await afterCommit(['income', 'recurring'])
  return withIncomeCategory(entry)
}

// ── Sync API ──────────────────────────────────────────────────────────────────

export interface ChangedRecords {
  maxRev: number
  records: Array<SyncRecord>
}

export interface ApplyIncomingResult {
  applied: number
  kept: number
  conflicts: number
}

type StoredRecord = Record<string, unknown> & { id: string }

const SINGLE_KEY_TYPES: Array<[Exclude<SyncRecordType, 'expense' | 'settings'>, SingleListKey]> = [
  ['category', 'categories'],
  ['incomeCategory', 'incomeCategories'],
  ['income', 'income'],
  ['budget', 'budgets'],
  ['recurring', 'recurring'],
]

const KEY_OF_TYPE = new Map<SyncRecordType, string>([
  ...SINGLE_KEY_TYPES,
  ['settings', SYNCED_SETTINGS_KEY],
])

// The stored record without the local and derived fields.
function syncData(record: object): Record<string, unknown> {
  const data: Record<string, unknown> = { ...record }
  delete data.rev
  delete data.conversion
  delete data.category
  return data
}

function toSyncRecord(type: SyncRecordType, record: StoredRecord): SyncRecord {
  const updatedAt =
    typeof record.updatedAt === 'string'
      ? record.updatedAt
      : typeof record.createdAt === 'string'
        ? record.createdAt
        : SETTINGS_DEFAULT_UPDATED_AT
  const deletedAt =
    typeof record.deletedAt === 'string' && record.deletedAt
      ? record.deletedAt
      : undefined
  return {
    type,
    id: record.id,
    updatedAt,
    ...(deletedAt ? { deletedAt } : {}),
    data: syncData(record),
  }
}

// Every record (tombstones included) with sinceRev < rev <= maxRev, where a
// record without rev counts as 0 (so -1 gives the full snapshot). maxRev is
// read first, so no lock is needed: a write still in flight has a higher rev
// and is returned next time. Chunks in key order, then categories, income
// categories, income, budgets, recurring items and the settings record. A
// DecryptError propagates.
export async function listChangedRecords(sinceRev: number): Promise<ChangedRecords> {
  const maxRev = await getLocalRev()
  const records: Array<SyncRecord> = []
  const collect = (type: SyncRecordType, list: Array<unknown>) => {
    for (const item of list) {
      const record = item as StoredRecord
      const rev = typeof record.rev === 'number' ? record.rev : 0
      if (rev > sinceRev && rev <= maxRev) records.push(toSyncRecord(type, record))
    }
  }
  for (const chunkKey of await allExpenseChunkKeys()) {
    collect('expense', await readChunk(chunkKey))
  }
  for (const [type, key] of SINGLE_KEY_TYPES) {
    collect(type, (await readStore(key)) ?? [])
  }
  const settings = await readStore('syncedSettings')
  if (settings !== undefined) collect('settings', [settings])
  return { maxRev, records }
}

function isParseableDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isValidIncoming(record: unknown): record is SyncRecord {
  const r = asObject(record)
  if (!r) return false
  const type = r.type as SyncRecordType
  if (type !== 'expense' && !KEY_OF_TYPE.has(type)) return false
  if (typeof r.id !== 'string' || r.id === '') return false
  const data = asObject(r.data)
  if (!data || data.id !== r.id) return false
  if (!isParseableDate(r.updatedAt)) return false
  if (r.deletedAt !== undefined && r.deletedAt !== null && !isParseableDate(r.deletedAt)) {
    return false
  }
  if ((type === 'expense' || type === 'income') && !isParseableDate(data.createdAt)) {
    return false
  }
  if (type === 'settings') {
    return (
      r.id === 'settings' &&
      isCurrency(data.mainCurrency) &&
      typeof data.fetchExchangeRates === 'boolean'
    )
  }
  return true
}

// The form an incoming record is stored in: its data with the envelope's
// updatedAt (and deletedAt), without rev, conversion or a joined category.
function incomingStoredForm(record: SyncRecord): StoredRecord {
  const stored: StoredRecord = {
    ...syncData(record.data),
    id: record.id,
    updatedAt: record.updatedAt,
  }
  if (record.deletedAt) stored.deletedAt = record.deletedAt
  return stored
}

// A stored list indexed by id; removed slots are null until written.
interface KeyState {
  list: Array<StoredRecord | null>
  changed: boolean
}

function buildState(list: Array<unknown>): KeyState {
  return { list: list as Array<StoredRecord>, changed: false }
}

function liveList(state: KeyState): Array<StoredRecord> {
  return state.list.filter((r): r is StoredRecord => r !== null)
}

// Applies records from outside (later the server), per record by mergeRecord
// with the sameTimeWinner tie-break. It is not a local change: no rev is
// stamped and meta:sync is neither locked nor written. Expenses go to the
// chunk of their createdAt and are removed from every other chunk that holds
// the same id; tombstones are stored as tombstones; `settings` replaces the
// synced settings record. A malformed record rejects the whole batch before
// anything is read. Everything changed is written in ONE setMany, then the
// usual commit hook runs. A DecryptError propagates and nothing is written.
export async function applyIncomingRecords(
  records: Array<SyncRecord>,
): Promise<ApplyIncomingResult> {
  records.forEach((record, index) => {
    if (!isValidIncoming(record)) {
      throw new Error(`applyIncomingRecords: invalid record ${index}`)
    }
  })
  const empty: ApplyIncomingResult = { applied: 0, kept: 0, conflicts: 0 }
  if (records.length === 0) return empty
  if (!_key || !store) throw new Error('LocalDb not initialized')

  const types = new Set(records.map((r) => r.type))
  const singleKeys = Array.from(types)
    .filter((t) => t !== 'expense')
    .map((t) => KEY_OF_TYPE.get(t) as string)
  const hasExpenses = types.has('expense')
  const targetChunks = new Set<string>()
  for (const r of records) {
    if (r.type === 'expense') targetChunks.add(expenseChunkKey(r.data.createdAt as string))
  }

  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    const chunkKeys = hasExpenses
      ? Array.from(new Set([...(await allExpenseChunkKeys()), ...targetChunks]))
      : []
    const outcome = await withWriteLock(
      [...singleKeys, ...chunkKeys],
      async (): Promise<
        { status: 'retry' } | { status: 'done'; result: ApplyIncomingResult; written: Array<string> }
      > => {
        if (hasExpenses) {
          const locked = new Set(chunkKeys)
          if ((await allExpenseChunkKeys()).some((k) => !locked.has(k))) {
            return { status: 'retry' }
          }
        }

        // Read everything first: a DecryptError leaves nothing written.
        const singles = new Map<string, KeyState>()
        for (const key of singleKeys) {
          if (key === SYNCED_SETTINGS_KEY) continue
          singles.set(key, buildState((await readStore(key as SingleListKey)) ?? []))
        }
        let settings: StoredRecord | undefined
        let settingsChanged = false
        if (singleKeys.includes(SYNCED_SETTINGS_KEY)) {
          const stored = await readStore('syncedSettings')
          settings = stored === undefined ? undefined : (stored as unknown as StoredRecord)
        }
        const chunks = new Map<string, KeyState>()
        for (const key of chunkKeys) chunks.set(key, buildState(await readChunk(key)))

        // Indexes: id -> position (single keys), id -> every chunk slot.
        const singleIndex = new Map<string, Map<string, number>>()
        for (const [key, state] of singles) {
          const index = new Map<string, number>()
          state.list.forEach((r, i) => {
            if (r && !index.has(r.id)) index.set(r.id, i)
          })
          singleIndex.set(key, index)
        }
        const where = new Map<string, Array<{ chunk: string; i: number }>>()
        for (const [key, state] of chunks) {
          state.list.forEach((r, i) => {
            if (!r) return
            const slots = where.get(r.id) ?? []
            slots.push({ chunk: key, i })
            where.set(r.id, slots)
          })
        }

        const result: ApplyIncomingResult = { applied: 0, kept: 0, conflicts: 0 }
        for (const record of records) {
          const incoming = incomingStoredForm(record)
          let local: StoredRecord | undefined
          if (record.type === 'expense') {
            const slot = where.get(record.id)?.[0]
            local = slot ? (chunks.get(slot.chunk)?.list[slot.i] ?? undefined) : undefined
          } else if (record.type === 'settings') {
            local = settings
          } else {
            const key = KEY_OF_TYPE.get(record.type) as string
            const i = singleIndex.get(key)?.get(record.id)
            local = i === undefined ? undefined : (singles.get(key)?.list[i] ?? undefined)
          }

          const decision = mergeRecord(local, incoming)
          let take = decision === 'take-incoming'
          if (decision === 'conflict-same-time' && local) {
            result.conflicts++
            take = sameTimeWinner(local, incoming) === 'incoming'
          }
          if (!take) {
            result.kept++
            continue
          }
          result.applied++

          // The local conversion stays while amount, currency and createdAt
          // are unchanged; otherwise the record is pending.
          if (
            local?.conversion !== undefined &&
            (record.type === 'expense' || record.type === 'income') &&
            local.amount === incoming.amount &&
            local.currency === incoming.currency &&
            local.createdAt === incoming.createdAt
          ) {
            incoming.conversion = local.conversion
          }

          if (record.type === 'expense') {
            const target = expenseChunkKey(incoming.createdAt as string)
            const kept: Array<{ chunk: string; i: number }> = []
            for (const slot of where.get(record.id) ?? []) {
              const state = chunks.get(slot.chunk)
              if (!state) continue
              state.changed = true
              if (slot.chunk === target && kept.length === 0) {
                state.list[slot.i] = incoming
                kept.push(slot)
              } else {
                state.list[slot.i] = null
              }
            }
            if (kept.length === 0) {
              const state = chunks.get(target)
              if (!state) throw new Error(`applyIncomingRecords: ${target} not locked`)
              state.list.push(incoming)
              state.changed = true
              kept.push({ chunk: target, i: state.list.length - 1 })
            }
            where.set(record.id, kept)
          } else if (record.type === 'settings') {
            settings = incoming
            settingsChanged = true
          } else {
            const key = KEY_OF_TYPE.get(record.type) as string
            const state = singles.get(key)
            const index = singleIndex.get(key)
            if (!state || !index) continue
            const i = index.get(record.id)
            if (i === undefined) {
              index.set(record.id, state.list.length)
              state.list.push(incoming)
            } else {
              state.list[i] = incoming
            }
            state.changed = true
          }
        }

        const values: Record<string, unknown> = {}
        for (const [key, state] of [...chunks, ...singles]) {
          if (state.changed) values[key] = liveList(state)
        }
        if (settingsChanged && settings) values[SYNCED_SETTINGS_KEY] = settings
        await writeKeysMany(values)
        return { status: 'done', result, written: Object.keys(values) }
      },
    )
    if (outcome.status === 'retry') continue
    if (outcome.written.length > 0) await afterCommit(outcome.written)
    return outcome.result
  }
  throw new Error('applyIncomingRecords: storage kept changing')
}

// Really removes the tombstones whose deletedAt is strictly older than
// `olderThan` from every list (records and revs otherwise untouched). Only the
// changed keys are written, in one setMany, and announced to other tabs; no
// lastDataChangeAt, no conversion request. Returns how many records it
// removed. Called by the sync engine once the server has the tombstones;
// nothing in the app calls it yet.
export async function compactTombstones(olderThan: string): Promise<number> {
  const cutoff = Date.parse(olderThan)
  if (Number.isNaN(cutoff)) {
    throw new Error(`compactTombstones: invalid date "${olderThan}"`)
  }
  if (!_key || !store) return 0
  const singleKeys: Array<SingleListKey> = [
    'categories',
    'incomeCategories',
    'income',
    'budgets',
    'recurring',
  ]
  const chunkKeys = await allExpenseChunkKeys()
  const { removed, written } = await withWriteLock(
    [...chunkKeys, ...singleKeys],
    async () => {
      const lists = new Map<string, Array<Revisioned>>()
      for (const key of chunkKeys) lists.set(key, await readChunk(key))
      for (const key of singleKeys) {
        lists.set(key, ((await readStore(key)) ?? []) as Array<Revisioned>)
      }
      const values: Record<string, Array<Revisioned>> = {}
      let count = 0
      for (const [key, list] of lists) {
        const kept = list.filter(
          (r) => !(r.deletedAt && Date.parse(r.deletedAt) < cutoff),
        )
        if (kept.length !== list.length) {
          count += list.length - kept.length
          values[key] = kept
        }
      }
      await writeKeysMany(values)
      return { removed: count, written: Object.keys(values) }
    },
  )
  if (written.length > 0) postChanged(written)
  return removed
}
