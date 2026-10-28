import { clear, createStore, del, delMany, get, keys, set, setMany } from 'idb-keyval'

import { getLang, isMessageKey, translate } from '../i18n/core'
import { AppError } from './appErrors'
import { base64ToBytes, bytesToBase64, decryptValue, encryptValue } from './crypto'
import {
  DecryptError,
  isAnyDataStorageKey,
  isDataStorageKey,
  isDecryptError,
} from './dataErrors'
import { defaultExpenseCategories, defaultIncomeCategories } from './defaultCategories'
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
import {
  clearKeyring,
  getHeldSpace,
  heldSpaceIds,
  keyringNeedsLoad,
  keyringVersion,
  listHeldSpaceIds,
  markKeyringStale,
  setKeyring,
  setKeyringLoader,
} from './spaces/keyring'
import { getCurrentMemberId } from './spaces/member'
import {
  generateIdentityKeyPair,
  generateSpaceKey,
  importSpaceKey,
} from './spaces/spaceCrypto'
import {
  PERSONAL_SPACE_ID,
  SpaceError,
  SpaceLockedError,
  isSpaceLockedError,
  isValidFamilySpaceId,
  keyFor,
  parseSpaceStorageKey,
} from './spaces/types'
import { postChanged } from './syncChannel'
import { isLive, mergeRecord, sameTimeWinner } from './syncRecords'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type { Lang } from '../i18n/lang'
import type { HeldSpace } from './spaces/keyring'
import type { IdentityKeyPair } from './spaces/spaceCrypto'
import type {
  IdentityRecord,
  LocalSpace,
  MemberProfile,
  SpaceId,
  SpaceInfoRecord,
  SpaceKeyEntry,
} from './spaces/types'
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
//   compaction) stamp neither and never touch `meta:sync`. `meta:sync` also
//   holds the sync engine's fields (src/lib/sync/syncMeta.ts); a user write
//   keeps them and only replaces localRev, then calls the onLocalChange
//   listeners (the engine's debounced trigger).
// - Records generated for a recurring occurrence get the deterministic id
//   occurrenceRecordId(recurringId, occurrenceDate).
//
// Main currency: an entry saved in the main currency gets its identity
// `conversion` right away; any other entry is stored without one (pending).
// Every committed write to an entry key (an expense chunk or `income`) or to
// `syncedSettings` calls requestEntryConversion(), which conversion.ts listens
// to (this module never imports conversion.ts). The converter writes back
// through applyEntryConversions / convertBudgets, which don't trigger it again.
//
// Spaces (spec §20): every data function is implemented once against a space
// context (`SpaceCtx`). The top-level exports are the Personal space;
// spaceDb(spaceId) returns a handle with the same members for a Family space.
// Storage keys are built only by keyFor (personal keys unchanged, Family keys
// `space:<id>:<baseKey>`) and every value is encrypted only through
// cryptoFor(spaceId): the DEK for personal, the space key (SK) for a Family
// space. Family data is never encrypted or decrypted with the DEK; a Family
// space without its key raises SpaceLockedError. Each space has its own
// `meta:sync` localRev. Family writes stamp createdBy / updatedBy / paidBy
// with the current member id; personal records never carry them.
interface LocalDbMap {
  categories: Array<Category>
  incomeCategories: Array<Category>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  recurring: Array<RecurringItem>
  syncedSettings: SyncedSettingsRecord
  // Personal only (encrypted with the DEK).
  identity: IdentityRecord
  spaceKeys: Array<SpaceKeyEntry>
  // Family only (encrypted with the space key).
  spaceInfo: SpaceInfoRecord
  memberProfiles: Array<MemberProfile>
}

/** Personal: the member identity key pair (one record). */
export const IDENTITY_KEY = 'identity'
/** Personal: one entry per Family space with its key. */
export const SPACE_KEYS_KEY = 'spaceKeys'
/** Family: the space details (one record, id 'space'). */
export const SPACE_INFO_KEY = 'spaceInfo'
/** Family: the member profiles. */
export const MEMBER_PROFILES_KEY = 'memberProfiles'

type LocalDbKey = keyof LocalDbMap

/** Plaintext `{ localRev: number, ...sync fields }`; a missing or invalid localRev means 0. */
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

// A new DEK: the keyring is reloaded from its spaceKeys on the next Family
// access.
export function unlockLocalDb(key: CryptoKey): void {
  _key = key
  clearKeyring()
}

// Lock, auto-lock, cross-tab lock and Remove data: the DEK and every space key
// leave memory. The identity key pair is never cached.
export function wipeLocalDbKey(): void {
  _key = null
  clearKeyring()
}

// ── Space context, keyring and cryptoFor ──────────────────────────────────────

interface SpaceCtx {
  readonly spaceId: SpaceId
  readonly personal: boolean
}

const PERSONAL_CTX: SpaceCtx = { spaceId: PERSONAL_SPACE_ID, personal: true }

const ctxCache = new Map<string, SpaceCtx>()

// The context of a space id; a bad Family id throws TypeError.
function ctxFor(spaceId: SpaceId): SpaceCtx {
  if (spaceId === PERSONAL_SPACE_ID) return PERSONAL_CTX
  let ctx = ctxCache.get(spaceId)
  if (!ctx) {
    keyFor(spaceId, SYNC_META_KEY) // validates the id
    ctx = { spaceId, personal: false }
    ctxCache.set(spaceId, ctx)
  }
  return ctx
}

// The storage key of `baseKey` in the space (the only key builder: keyFor).
function storageKeyOf(ctx: SpaceCtx, baseKey: string): string {
  return keyFor(ctx.spaceId, baseKey)
}

// True when personal reads must return nothing (no DEK). A Family space is
// never "quietly empty": its reads raise SpaceLockedError instead.
function personalLocked(ctx: SpaceCtx): boolean {
  return ctx.personal && !_key
}

export interface SpaceCrypto {
  spaceId: string
  encrypt: (value: unknown) => Promise<Uint8Array>
  decrypt: (bytes: Uint8Array) => Promise<unknown>
}

// The record crypto of a space. Personal: the DEK ("LocalDb not initialized"
// while locked). Family: the space key from the keyring (loaded on demand),
// newest version for writing, older versions tried for reading;
// SpaceLockedError when the vault is locked or the space is not held. Never
// the DEK for a Family space.
export async function cryptoFor(spaceId: SpaceId): Promise<SpaceCrypto> {
  if (spaceId === PERSONAL_SPACE_ID) {
    const key = _key
    if (!key) throw new Error('LocalDb not initialized')
    return {
      spaceId,
      encrypt: (value) => encryptValue(key, value),
      decrypt: (bytes) => decryptValue(key, bytes),
    }
  }
  if (!isValidFamilySpaceId(spaceId)) {
    throw new TypeError(`cryptoFor: invalid space id "${spaceId}"`)
  }
  if (!_key) throw new SpaceLockedError(spaceId)
  if (keyringNeedsLoad()) await loadKeyring()
  const held = getHeldSpace(spaceId)
  // A lock while the keyring loaded leaves nothing usable.
  if (!getLocalDbKey() || !held || held.keys.length === 0) {
    throw new SpaceLockedError(spaceId)
  }
  const versions = held.keys
  return {
    spaceId,
    encrypt: (value) => encryptValue(versions[0].key, value),
    decrypt: async (bytes) => {
      let lastError: unknown = new Error('no key')
      for (const version of versions) {
        try {
          return await decryptValue(version.key, bytes)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    },
  }
}

let keyringLoad: Promise<void> | null = null

// Reads the personal spaceKeys record with the DEK and imports the keys of
// every live entry into the keyring. A DecryptError('spaceKeys') propagates.
// A lock during the load leaves the keyring cleared.
function loadKeyring(): Promise<void> {
  if (keyringLoad) return keyringLoad
  keyringLoad = (async () => {
    const dek = _key
    if (!dek || !store) return
    const version = keyringVersion()
    const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
    const spaces: Array<HeldSpace> = []
    for (const entry of entries) {
      if (!isLive(entry) || !isValidFamilySpaceId(entry.id) || !entry.key) continue
      try {
        const versions = [
          { keyVersion: entry.keyVersion, key: entry.key },
          ...(entry.previousKeys ?? []),
        ].sort((a, b) => b.keyVersion - a.keyVersion)
        const imported: HeldSpace['keys'] = []
        for (const v of versions) {
          if (!v.key) continue
          imported.push({
            keyVersion: v.keyVersion,
            key: await importSpaceKey(base64ToBytes(v.key)),
          })
        }
        spaces.push({
          id: entry.id,
          name: entry.name,
          role: entry.role,
          keyVersion: entry.keyVersion,
          keys: imported,
        })
      } catch (err) {
        console.error('Could not import a space key:', err instanceof Error ? err.name : typeof err)
      }
    }
    if (_key !== dek) return
    setKeyring(spaces)
    if (keyringVersion() !== version) markKeyringStale()
  })().finally(() => {
    keyringLoad = null
  })
  return keyringLoad
}

// One assignment, no I/O: listHeldSpaceIds() loads through it.
setKeyringLoader(loadKeyring)

// The current member for a Family write (undefined for personal: no stamps).
async function memberFor(ctx: SpaceCtx): Promise<string | null | undefined> {
  return ctx.personal ? undefined : getCurrentMemberId()
}

// Family create: createdBy = updatedBy = the member (absent when unknown) and,
// for expenses and income, paidBy = input.paidBy ?? the member. Mutates and
// returns the record. Personal (member undefined): nothing.
function stampCreated<T extends { createdBy?: string; updatedBy?: string; paidBy?: string }>(
  member: string | null | undefined,
  record: T,
  paid?: { paidBy?: string },
): T {
  if (member === undefined) return record
  if (member) {
    record.createdBy = member
    record.updatedBy = member
  }
  if (paid) {
    const paidBy = paid.paidBy ?? member
    if (paidBy) record.paidBy = paidBy
  }
  return record
}

// updatedBy = the member, or removed when the writer is unknown.
function withUpdatedBy<T extends object>(record: T, member: string | null): T {
  const r = record as T & { updatedBy?: string }
  if (member) return r.updatedBy === member ? record : { ...record, updatedBy: member }
  if (!('updatedBy' in r)) return record
  const copy = { ...r }
  delete copy.updatedBy
  return copy
}

// Family user writes: every record stamped with a rev of this write (the same
// rule as rev) gets updatedBy.
function stampWritten(value: unknown, counter: RevCounter): unknown {
  const member = counter.member
  if (member === undefined) return value
  const fresh = (r: unknown): boolean => {
    const rev = (r as { rev?: unknown } | null)?.rev
    return typeof rev === 'number' && rev > counter.start
  }
  if (Array.isArray(value)) {
    return value.map((r: unknown) => (fresh(r) ? withUpdatedBy(r as object, member) : r))
  }
  if (value && typeof value === 'object' && fresh(value)) {
    return withUpdatedBy(value, member)
  }
  return value
}

// Locks the space's storage keys (meta:settings is device-level: unprefixed).
function withSpaceLock<T>(
  ctx: SpaceCtx,
  lockKeys: Array<string> | string,
  fn: () => Promise<T>,
): Promise<T> {
  const list = Array.isArray(lockKeys) ? lockKeys : [lockKeys]
  return withWriteLock(
    list.map((k) => (k === META_SETTINGS_KEY ? k : storageKeyOf(ctx, k))),
    fn,
  )
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

// The plaintext change counter of a space (`meta:sync` of the space). Works
// before unlock.
async function getLocalRevIn(ctx: SpaceCtx): Promise<number> {
  if (!store) return 0
  return parseLocalRev(await get<unknown>(storageKeyOf(ctx, SYNC_META_KEY), store))
}

interface RevCounter {
  next: () => number
  readonly changed: boolean
  readonly last: number
  /** localRev before this write: records with a higher rev are this write's. */
  readonly start: number
  /** The storage key of the space's meta:sync. */
  readonly metaKey: string
  /** The stored meta:sync object (its sync fields are written back unchanged). */
  readonly base: Record<string, unknown>
  /** Family: the writing member (null = unknown). Personal: undefined. */
  readonly member: string | null | undefined
}

// Only called inside a lock that includes the space's SYNC_META_KEY. Nothing
// is written until writeKeysMany commits the counter together with the data.
// A Family counter also carries the current member id for the stamps.
async function openRevCounter(ctx: SpaceCtx): Promise<RevCounter> {
  const metaKey = storageKeyOf(ctx, SYNC_META_KEY)
  const raw = store ? await get<unknown>(metaKey, store) : undefined
  const start = parseLocalRev(raw)
  const base = asObject(raw) ?? {}
  const member = await memberFor(ctx)
  let last = start
  return {
    next: () => ++last,
    get changed() {
      return last !== start
    },
    get last() {
      return last
    },
    start,
    metaKey,
    base,
    member,
  }
}

// The meta:sync entry for a write that advanced the counter to `localRev`:
// the stored object (sync fields kept) with localRev replaced. Exactly
// `{ localRev }` when nothing else is stored. Must be called inside a lock that
// holds the space's SYNC_META_KEY. Personal by default.
export async function syncMetaEntry(
  localRev: number,
  spaceId: SpaceId = PERSONAL_SPACE_ID,
): Promise<[string, Record<string, unknown>]> {
  const metaKey = keyFor(spaceId, SYNC_META_KEY)
  const raw = store ? await get<unknown>(metaKey, store) : undefined
  return [metaKey, { ...(asObject(raw) ?? {}), localRev }]
}

// ── Local change hook (user writes, for the sync engine) ──────────────────────

const localChangeListeners = new Set<() => void>()

// Called after every committed user write (a write that stamped revs). Not
// after incoming records, compaction or conversion writes.
export function onLocalChange(listener: () => void): () => void {
  localChangeListeners.add(listener)
  return () => {
    localChangeListeners.delete(listener)
  }
}

// Calls every listener synchronously; a throwing listener is logged by its
// error name only and never fails the write.
export function notifyLocalChange(): void {
  for (const listener of Array.from(localChangeListeners)) {
    try {
      listener()
    } catch (err) {
      console.error(
        'Local change listener failed:',
        err instanceof Error ? err.name : typeof err,
      )
    }
  }
}

// ── Generic encrypted read/write ──────────────────────────────────────────────

// Reads and decrypts the base key `key` of the space. Personal: undefined
// while locked. Family: SpaceLockedError without its key. An unreadable blob
// throws DecryptError naming the full storage key.
async function readStore<TKey extends LocalDbKey>(
  ctx: SpaceCtx,
  key: TKey,
): Promise<LocalDbMap[TKey] | undefined> {
  if (!store || personalLocked(ctx)) return undefined
  const c = await cryptoFor(ctx.spaceId)
  const storageKey = storageKeyOf(ctx, key)
  const raw = await get<unknown>(storageKey, store)
  if (!(raw instanceof Uint8Array)) return undefined
  try {
    return (await c.decrypt(raw)) as LocalDbMap[TKey]
  } catch (err) {
    throw new DecryptError(storageKey, err)
  }
}

// Encrypts every value (base keys of the space: single keys or expense chunks)
// with the space's crypto and writes them all in ONE IndexedDB transaction
// (idb-keyval setMany), together with any plaintext entries (full keys) and,
// when the counter advanced, the space's `meta:sync`. If the transaction fails
// nothing is written. Family records stamped with this write's revs get
// updatedBy. Only personal user writes notify the sync engine.
async function writeKeysMany(
  ctx: SpaceCtx,
  values: object,
  counter?: RevCounter,
  plain: Array<[string, unknown]> = [],
): Promise<void> {
  const c = await cryptoFor(ctx.spaceId)
  if (!store) return
  const entries: Array<[IDBValidKey, unknown]> = []
  for (const [k, v] of Object.entries(values)) {
    const value = counter ? stampWritten(v, counter) : v
    entries.push([storageKeyOf(ctx, k), await c.encrypt(value)])
  }
  entries.push(...plain)
  if (counter?.changed) {
    entries.push([counter.metaKey, { ...counter.base, localRev: counter.last }])
  }
  if (entries.length === 0) return
  await setMany(entries, store)
  if (counter?.changed && ctx.personal) notifyLocalChange()
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

// `chunkKey` is the base key (expenses_YYYY_MM) of the space.
async function readChunk(ctx: SpaceCtx, chunkKey: string): Promise<Array<Expense>> {
  if (!store || personalLocked(ctx)) return []
  const c = await cryptoFor(ctx.spaceId)
  const storageKey = storageKeyOf(ctx, chunkKey)
  const raw = await get<unknown>(storageKey, store)
  if (!(raw instanceof Uint8Array)) return []
  try {
    return (await c.decrypt(raw)) as Array<Expense>
  } catch (err) {
    throw new DecryptError(storageKey, err)
  }
}

// The base keys of the space's real month chunks: quarantine:* copies, other
// spaces' chunks and stray keys are skipped. Family: SpaceLockedError without
// its key.
async function allExpenseChunkKeys(ctx: SpaceCtx): Promise<Array<string>> {
  if (!store || personalLocked(ctx)) return []
  if (!ctx.personal) await cryptoFor(ctx.spaceId)
  const allKeys = await keys(store)
  if (ctx.personal) {
    return allKeys
      .filter(
        (k): k is string => typeof k === 'string' && EXPENSE_CHUNK_KEY_RE.test(k),
      )
      .sort()
  }
  const prefix = storageKeyOf(ctx, '')
  const result: Array<string> = []
  for (const k of allKeys) {
    if (typeof k !== 'string' || !k.startsWith(prefix)) continue
    const base = k.slice(prefix.length)
    if (EXPENSE_CHUNK_KEY_RE.test(base)) result.push(base)
  }
  return result.sort()
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
// `changedKeys` are base keys; a Family commit announces them with its
// spaceId (personal messages are unchanged). A write of the personal
// spaceKeys marks the keyring stale.
async function afterCommit(
  ctx: SpaceCtx,
  changedKeys: Array<string>,
  opts: { fromConversion?: boolean; dataChange?: boolean } = {},
): Promise<void> {
  if (ctx.personal) {
    postChanged(changedKeys)
    if (changedKeys.includes(SPACE_KEYS_KEY)) markKeyringStale()
  } else {
    postChanged(changedKeys, ctx.spaceId)
  }
  // A Family write touches only its own space's keys: the device-level
  // lastDataChangeAt (backup reminder) follows personal writes.
  if (ctx.personal && opts.dataChange !== false) await markDataChanged()
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
// unreadable record throws DecryptError('syncedSettings'). A Family space has
// its own record and no legacy fields (defaults when absent).
async function readSyncedSettingsIn(ctx: SpaceCtx): Promise<SyncedSettingsRecord> {
  const s = store
  if (!s) return settingsFromLegacy(null)
  const stored = await readStore(ctx, 'syncedSettings')
  if (stored !== undefined) return normalizeSettings(stored)
  if (!ctx.personal) return settingsFromLegacy(null)
  return settingsFromLegacy(await readPlainSettings(s))
}

// The stored main currency. A DecryptError or SpaceLockedError propagates;
// any other failure falls back to the default.
async function readMainCurrency(ctx: SpaceCtx): Promise<Currency> {
  try {
    return (await readSyncedSettingsIn(ctx)).mainCurrency
  } catch (err) {
    if (isDecryptError(err) || isSpaceLockedError(err)) throw err
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
        PERSONAL_CTX,
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
// legacy fields from `meta:settings` in the same transaction (personal only).
// An empty or invalid patch writes nothing.
async function updateSyncedSettingsIn(
  ctx: SpaceCtx,
  patch: { fetchExchangeRates?: boolean },
): Promise<void> {
  const value = patch.fetchExchangeRates
  if (typeof value !== 'boolean') return
  const s = store
  if (!s) return
  const lockKeys = ctx.personal
    ? [META_SETTINGS_KEY, SYNC_META_KEY, SYNCED_SETTINGS_KEY]
    : [SYNC_META_KEY, SYNCED_SETTINGS_KEY]
  const written = await withSpaceLock(ctx, lockKeys, async () => {
    const current = await readSyncedSettingsIn(ctx)
    const counter = await openRevCounter(ctx)
    const record: SyncedSettingsRecord = {
      ...current,
      fetchExchangeRates: value,
      updatedAt: nowIso(),
      rev: counter.next(),
    }
    const stripped = ctx.personal
      ? stripLegacyCurrency(await readPlainSettings(s))
      : null
    await writeKeysMany(
      ctx,
      { [SYNCED_SETTINGS_KEY]: record },
      counter,
      stripped ? [[META_SETTINGS_KEY, stripped]] : [],
    )
    return stripped
      ? [SYNCED_SETTINGS_KEY, META_SETTINGS_KEY]
      : [SYNCED_SETTINGS_KEY]
  })
  await afterCommit(ctx, written)
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
// Family data keys (`space:<id>:<key>`) are quarantined the same way.
export async function quarantineKey(
  storageKey: string,
): Promise<string | null> {
  if (!isAnyDataStorageKey(storageKey)) {
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
  if (qKey !== null) {
    const family = parseSpaceStorageKey(storageKey)
    if (family) postChanged([family.baseKey], family.spaceId)
    else postChanged([storageKey])
  }
  return qKey
}

// True if the store holds any personal data key in the current format
// (quarantine copies alone do not count). Works before unlock.
export async function hasLocalData(): Promise<boolean> {
  if (!store) return false
  const allKeys = await keys(store)
  return allKeys.some((k) => typeof k === 'string' && isDataStorageKey(k))
}

// ── Soft deletes ──────────────────────────────────────────────────────────────

type SingleListKey =
  | 'categories'
  | 'incomeCategories'
  | 'income'
  | 'budgets'
  | 'recurring'
  | 'spaceKeys'
  | 'memberProfiles'

// Turns the live record `id` of a single key into a tombstone. Returns false
// (nothing written) when there is no live record with that id.
async function softDeleteIn(ctx: SpaceCtx, key: SingleListKey, id: string): Promise<boolean> {
  return withSpaceLock(ctx, [key, SYNC_META_KEY], async () => {
    const list = ((await readStore(ctx, key)) ?? []) as Array<
      { id: string; updatedAt?: string } & Revisioned
    >
    const index = list.findIndex((r) => r.id === id && isLive(r))
    if (index === -1) return false
    const counter = await openRevCounter(ctx)
    const now = nowIso()
    const next = [...list]
    next[index] = { ...list[index], deletedAt: now, updatedAt: now, rev: counter.next() }
    await writeKeysMany(ctx, { [key]: next }, counter)
    return true
  })
}

// ── Expenses ──────────────────────────────────────────────────────────────────

async function liveCategories(ctx: SpaceCtx, key: CategoryKey): Promise<Array<Category>> {
  return liveRecords((await readStore(ctx, key)) ?? [])
}

async function joinCategories(
  ctx: SpaceCtx,
  expenses: Array<Expense>,
): Promise<Array<Expense>> {
  const categoryMap = new Map(
    (await liveCategories(ctx, 'categories')).map((c) => [c.id, c]),
  )
  return expenses.map((e) => ({
    ...e,
    category: categoryMap.get(e.categoryId),
  }))
}

async function getExpensesForRangeIn(
  ctx: SpaceCtx,
  from: string,
  to: string,
): Promise<Array<Expense>> {
  const chunkKeys = chunkKeysBetween(from, to)
  const chunks = await Promise.all(chunkKeys.map((k) => readChunk(ctx, k)))
  const expenses = liveRecords(chunks.flat())
    .filter((e) => e.createdAt >= from && e.createdAt <= to)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return joinCategories(ctx, expenses)
}

// TODO: could possible create a spike if user will export all data for 5 years
async function getAllExpensesIn(ctx: SpaceCtx): Promise<Array<Expense>> {
  const chunkKeys = await allExpenseChunkKeys(ctx)
  const chunks = await Promise.all(chunkKeys.map((k) => readChunk(ctx, k)))
  const expenses = liveRecords(chunks.flat()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )
  return joinCategories(ctx, expenses)
}

async function withExpenseCategory(ctx: SpaceCtx, entry: Expense): Promise<Expense> {
  const categories = await liveCategories(ctx, 'categories')
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...withoutRev(entry), category }
}

async function addExpenseIn(ctx: SpaceCtx, input: CreateExpenseInput): Promise<Expense> {
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
  const conversion = conversionOnSave(entry, await readMainCurrency(ctx))
  if (conversion) entry.conversion = conversion
  const chunkKey = expenseChunkKey(entry.createdAt)
  await withSpaceLock(ctx, [chunkKey, SYNC_META_KEY], async () => {
    const existing = await readChunk(ctx, chunkKey)
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, entry, { paidBy: input.paidBy })
    await writeKeysMany(
      ctx,
      { [chunkKey]: [...existing, { ...entry, rev: counter.next() }] },
      counter,
    )
  })
  await afterCommit(ctx, [chunkKey])
  return withExpenseCategory(ctx, entry)
}

// createdAt is required so we can derive the correct chunk without a full scan.
// The record stays in its chunk as a tombstone. Deleting a missing or already
// deleted expense writes nothing.
async function deleteExpenseIn(
  ctx: SpaceCtx,
  id: string,
  createdAt: string,
): Promise<void> {
  const chunkKey = expenseChunkKey(createdAt)
  const wrote = await withSpaceLock(ctx, [chunkKey, SYNC_META_KEY], async () => {
    const chunk = await readChunk(ctx, chunkKey)
    const index = chunk.findIndex((e) => e.id === id && isLive(e))
    if (index === -1) return false
    const counter = await openRevCounter(ctx)
    const now = nowIso()
    const next = [...chunk]
    next[index] = { ...chunk[index], deletedAt: now, updatedAt: now, rev: counter.next() }
    await writeKeysMany(ctx, { [chunkKey]: next }, counter)
    return true
  })
  if (wrote) await afterCommit(ctx, [chunkKey])
}

// Undo of a delete: clears deletedAt, bumps updatedAt and stamps a new rev.
// An expense that is already live is returned unchanged (nothing written).
async function undeleteExpenseIn(
  ctx: SpaceCtx,
  id: string,
  createdAt: string,
): Promise<Expense> {
  const chunkKey = expenseChunkKey(createdAt)
  const { record, wrote } = await withSpaceLock(
    ctx,
    [chunkKey, SYNC_META_KEY],
    async () => {
      const chunk = await readChunk(ctx, chunkKey)
      const live = chunk.find((e) => e.id === id && isLive(e))
      if (live) return { record: live, wrote: false }
      const index = chunk.findIndex((e) => e.id === id)
      if (index === -1) {
        throw new Error(`undeleteExpense: expense not found: ${id}`)
      }
      const counter = await openRevCounter(ctx)
      const revived: Expense = { ...chunk[index], updatedAt: nowIso() }
      delete revived.deletedAt
      revived.rev = counter.next()
      const next = [...chunk]
      next[index] = revived
      await writeKeysMany(ctx, { [chunkKey]: next }, counter)
      const member = counter.member
      return {
        record: member === undefined ? revived : withUpdatedBy(revived, member),
        wrote: true,
      }
    },
  )
  if (wrote) await afterCommit(ctx, [chunkKey])
  return withExpenseCategory(ctx, record)
}

// originalCreatedAt locates the current chunk; if the patch moves createdAt
// into a different month the record is moved to that month's chunk. Both
// chunks and meta:sync are written in ONE setMany.
async function updateExpenseIn(
  ctx: SpaceCtx,
  id: string,
  originalCreatedAt: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  const oldKey = expenseChunkKey(originalCreatedAt)
  const main = await readMainCurrency(ctx)
  const lockKeys = [oldKey, SYNC_META_KEY]
  if (
    patch.createdAt !== undefined &&
    !isNaN(new Date(patch.createdAt).getTime())
  ) {
    lockKeys.push(expenseChunkKey(patch.createdAt))
  }

  const { result, written } = await withSpaceLock(ctx, lockKeys, async () => {
    const oldChunk = await readChunk(ctx, oldKey)
    const index = oldChunk.findIndex((e) => e.id === id && isLive(e))
    if (index === -1) {
      throw new Error(`updateExpense: expense not found: ${id}`)
    }
    const existing = oldChunk[index]

    const createdAt = patch.createdAt ?? existing.createdAt
    if (isNaN(new Date(createdAt).getTime())) {
      throw new Error(`updateExpense: invalid createdAt "${createdAt}"`)
    }

    const categories = await liveCategories(ctx, 'categories')
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

    const counter = await openRevCounter(ctx)
    // Family: createdBy and paidBy stay unless paidBy is given; updatedBy is
    // this writer (removed when unknown).
    if (counter.member !== undefined) {
      if (existing.createdBy !== undefined) updated.createdBy = existing.createdBy
      const paidBy = patch.paidBy ?? existing.paidBy
      if (paidBy !== undefined) updated.paidBy = paidBy
      if (counter.member) updated.updatedBy = counter.member
    }
    const stored: Expense = { ...updated, rev: counter.next() }
    const newKey = expenseChunkKey(createdAt)
    let writtenKeys: Array<string>
    if (newKey === oldKey) {
      const next = [...oldChunk]
      next[index] = stored
      await writeKeysMany(ctx, { [oldKey]: next }, counter)
      writtenKeys = [oldKey]
    } else {
      // One transaction: the record is never lost or duplicated.
      const newChunk = await readChunk(ctx, newKey)
      await writeKeysMany(
        ctx,
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
  await afterCommit(ctx, written)
  return result
}

// ── Categories ────────────────────────────────────────────────────────────────

async function getAllCategoriesIn(ctx: SpaceCtx): Promise<Array<Category>> {
  return liveCategories(ctx, 'categories')
}

type CategoryKey = 'categories' | 'incomeCategories'

function categoryNotFound(id: string): AppError {
  return new AppError('category-not-found', `Category not found: ${id}`, { id })
}

// Shared by the expense and the income category mutations: the whole
// read-modify-write runs under the lock of `key`. Names are trimmed and unique
// among the live categories, ignoring case (a deleted name can be reused; it
// gets a new id).
async function addCategoryTo(
  ctx: SpaceCtx,
  key: CategoryKey,
  input: CreateCategoryInput,
): Promise<Category> {
  const entry = await withSpaceLock(ctx, [key, SYNC_META_KEY], async () => {
    const categories = (await readStore(ctx, key)) ?? []
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
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, created)
    await writeKeysMany(
      ctx,
      { [key]: [...categories, { ...created, rev: counter.next() }] },
      counter,
    )
    return created
  })
  await afterCommit(ctx, [key])
  return entry
}

async function updateCategoryTo(
  ctx: SpaceCtx,
  key: CategoryKey,
  input: UpdateCategoryInput,
): Promise<Category> {
  const result = await withSpaceLock(ctx, [key, SYNC_META_KEY], async () => {
    const categories = (await readStore(ctx, key)) ?? []
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
    const counter = await openRevCounter(ctx)
    const next = [...categories]
    next[index] = { ...updated, rev: counter.next() }
    await writeKeysMany(ctx, { [key]: next }, counter)
    return counter.member === undefined ? updated : withUpdatedBy(updated, counter.member)
  })
  await afterCommit(ctx, [key])
  return result
}

async function addCategoryIn(
  ctx: SpaceCtx,
  input: CreateCategoryInput,
): Promise<Category> {
  return addCategoryTo(ctx, 'categories', input)
}

async function updateCategoryIn(
  ctx: SpaceCtx,
  input: UpdateCategoryInput,
): Promise<Category> {
  return updateCategoryTo(ctx, 'categories', input)
}

// Refuses while a live recurring item of `kind` uses the category.
async function assertNoRecurringUses(
  ctx: SpaceCtx,
  kind: RecurringKind,
  categoryId: string,
): Promise<void> {
  const items = (await readStore(ctx, 'recurring')) ?? []
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
async function deleteCategoryIn(ctx: SpaceCtx, id: string): Promise<void> {
  const written = await withSpaceLock(
    ctx,
    ['budgets', 'categories', 'recurring', SYNC_META_KEY],
    async () => {
      // Check all expense chunks for references to this category. This only
      // reads chunks, so it takes no chunk locks.
      const chunkKeys = await allExpenseChunkKeys(ctx)
      const chunks = await Promise.all(chunkKeys.map((k) => readChunk(ctx, k)))
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
      await assertNoRecurringUses(ctx, 'expense', id)
      const categories = (await readStore(ctx, 'categories')) ?? []
      const index = categories.findIndex((c) => c.id === id && isLive(c))
      if (index === -1) return []

      const counter = await openRevCounter(ctx)
      const now = nowIso()
      const nextCategories = [...categories]
      nextCategories[index] = {
        ...categories[index],
        deletedAt: now,
        updatedAt: now,
        rev: counter.next(),
      }
      const values: Partial<LocalDbMap> = { categories: nextCategories }

      const budgets = (await readStore(ctx, 'budgets')) ?? []
      const nextBudgets = budgets.map((b) =>
        b.categoryId !== id || !isLive(b)
          ? b
          : { ...b, deletedAt: now, updatedAt: now, rev: counter.next() },
      )
      const budgetsChanged = nextBudgets.some((b, i) => b !== budgets[i])
      if (budgetsChanged) values.budgets = nextBudgets
      await writeKeysMany(ctx, values, counter)
      return budgetsChanged ? ['categories', 'budgets'] : ['categories']
    },
  )
  if (written.length > 0) await afterCommit(ctx, written)
}

// Writes the default expense categories in `lang` when there are no live
// categories yet. Existing categories are user data and are never renamed.
async function provisionDefaultCategoriesIn(
  ctx: SpaceCtx,
  lang: Lang = 'en',
): Promise<void> {
  const wrote = await withSpaceLock(ctx, ['categories', SYNC_META_KEY], async () => {
    const categories = (await readStore(ctx, 'categories')) ?? []
    if (categories.some(isLive)) return false
    const updatedAt = nowIso()
    const counter = await openRevCounter(ctx)
    const defaults: Array<Category> = defaultExpenseCategories(lang).map((c) =>
      stampCreated<Category>(counter.member, {
        id: crypto.randomUUID(),
        name: c.name,
        icon: c.icon,
        updatedAt,
        rev: counter.next(),
      }),
    )
    await writeKeysMany(ctx, { categories: [...categories, ...defaults] }, counter)
    return true
  })
  if (wrote) await afterCommit(ctx, ['categories'])
}

// ── Income categories ─────────────────────────────────────────────────────────

async function getAllIncomeCategoriesIn(ctx: SpaceCtx): Promise<Array<Category>> {
  return liveCategories(ctx, 'incomeCategories')
}

async function addIncomeCategoryIn(
  ctx: SpaceCtx,
  input: CreateCategoryInput,
): Promise<Category> {
  return addCategoryTo(ctx, 'incomeCategories', input)
}

async function updateIncomeCategoryIn(
  ctx: SpaceCtx,
  input: UpdateCategoryInput,
): Promise<Category> {
  return updateCategoryTo(ctx, 'incomeCategories', input)
}

// Refused while live income entries or live income recurring items use it.
async function deleteIncomeCategoryIn(ctx: SpaceCtx, id: string): Promise<void> {
  const wrote = await withSpaceLock(
    ctx,
    ['income', 'incomeCategories', 'recurring', SYNC_META_KEY],
    async () => {
      const income = (await readStore(ctx, 'income')) ?? []
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
      await assertNoRecurringUses(ctx, 'income', id)
      const categories = (await readStore(ctx, 'incomeCategories')) ?? []
      const index = categories.findIndex((c) => c.id === id && isLive(c))
      if (index === -1) return false
      const counter = await openRevCounter(ctx)
      const now = nowIso()
      const next = [...categories]
      next[index] = { ...categories[index], deletedAt: now, updatedAt: now, rev: counter.next() }
      await writeKeysMany(ctx, { incomeCategories: next }, counter)
      return true
    },
  )
  if (wrote) await afterCommit(ctx, ['incomeCategories'])
}

// Provisions the default income categories and converts legacy free-text
// income sources into categories, once: when `incomeCategories` already
// exists (even as an unreadable blob) it does nothing. Both keys and meta:sync
// are written in one transaction; each created category gets a rev, the
// rewritten income records (a derived field) don't. A DecryptError on
// `income` propagates and nothing is written. Returns true when it wrote.
// `lang` is the language of the defaults and of the "Other" fallback.
async function ensureIncomeCategoriesIn(
  ctx: SpaceCtx,
  lang: Lang = 'en',
): Promise<boolean> {
  const s = store
  if (!s || personalLocked(ctx)) return false
  if (!ctx.personal) {
    // A Family space has no legacy income sources: only the defaults, when
    // the key is absent.
    await cryptoFor(ctx.spaceId)
    const wroteDefaults = await withSpaceLock(
      ctx,
      ['incomeCategories', SYNC_META_KEY],
      async () => {
        if ((await get<unknown>(storageKeyOf(ctx, 'incomeCategories'), s)) !== undefined) {
          return false
        }
        const counter = await openRevCounter(ctx)
        const updatedAt = nowIso()
        const incomeCategories: Array<Category> = defaultIncomeCategories(lang).map((c) =>
          stampCreated<Category>(counter.member, {
            id: crypto.randomUUID(),
            name: c.name,
            icon: c.icon,
            updatedAt,
            rev: counter.next(),
          }),
        )
        await writeKeysMany(ctx, { incomeCategories }, counter)
        return true
      },
    )
    if (wroteDefaults) await afterCommit(ctx, ['incomeCategories'])
    return wroteDefaults
  }
  const wrote = await withSpaceLock(
    ctx,
    ['income', 'incomeCategories', SYNC_META_KEY],
    async () => {
      const existing = await get<unknown>('incomeCategories', s)
      if (existing !== undefined) return false
      const income = (await readStore(ctx, 'income')) ?? []
      const converted = convertIncomeSources(income, [], { addDefaults: true, lang })
      const counter = await openRevCounter(ctx)
      const incomeCategories = converted.incomeCategories.map((c) => ({
        ...c,
        rev: counter.next(),
      }))
      await writeKeysMany(ctx, { incomeCategories, income: converted.income }, counter)
      return true
    },
  )
  if (wrote) await afterCommit(ctx, ['incomeCategories', 'income'])
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
  if (isNewVault) await provisionDefaultCategoriesIn(PERSONAL_CTX, lang)
  await ensureIncomeCategoriesIn(PERSONAL_CTX, lang)
  let { created } = await processDueRecurringIn(PERSONAL_CTX)
  // Every Family space this device holds a key for, while personal is active
  // (a DecryptError propagates as for personal).
  for (const spaceId of await listHeldSpaceIds()) {
    created += (await processDueRecurringIn(ctxFor(spaceId))).created
  }
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

async function getAllIncomeIn(ctx: SpaceCtx): Promise<Array<IncomeEntry>> {
  const income = liveRecords((await readStore(ctx, 'income')) ?? [])
  return joinIncomeCategories(income, await liveCategories(ctx, 'incomeCategories'))
}

async function withIncomeCategory(ctx: SpaceCtx, entry: IncomeEntry): Promise<IncomeEntry> {
  const categories = await liveCategories(ctx, 'incomeCategories')
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...withoutRev(entry), category }
}

async function addIncomeIn(
  ctx: SpaceCtx,
  input: CreateIncomeInput,
): Promise<IncomeEntry> {
  const main = await readMainCurrency(ctx)
  const entry = await withSpaceLock(ctx, ['income', SYNC_META_KEY], async () => {
    const income = (await readStore(ctx, 'income')) ?? []
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
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, created, { paidBy: input.paidBy })
    await writeKeysMany(
      ctx,
      { income: [...income, { ...created, rev: counter.next() }] },
      counter,
    )
    return created
  })
  await afterCommit(ctx, ['income'])
  return withIncomeCategory(ctx, entry)
}

async function deleteIncomeIn(ctx: SpaceCtx, id: string): Promise<void> {
  if (await softDeleteIn(ctx, 'income', id)) await afterCommit(ctx, ['income'])
}

// ── Budgets ───────────────────────────────────────────────────────────────────

async function getAllBudgetsIn(ctx: SpaceCtx): Promise<
  Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>
> {
  const budgets = liveRecords((await readStore(ctx, 'budgets')) ?? [])
  const categoryMap = new Map(
    (await liveCategories(ctx, 'categories')).map((c) => [c.id, c]),
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
async function upsertBudgetIn(
  ctx: SpaceCtx,
  input: UpsertBudgetInput,
): Promise<BudgetEntry> {
  const result = await withSpaceLock(ctx, ['budgets', SYNC_META_KEY], async () => {
    const budgets = (await readStore(ctx, 'budgets')) ?? []
    const index = budgets.findIndex(
      (b) => b.categoryId === input.categoryId && isLive(b),
    )
    const updatedAt = nowIso()
    const counter = await openRevCounter(ctx)
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
      stampCreated(counter.member, entry)
      updated.push({ ...entry, rev: counter.next() })
    }
    await writeKeysMany(ctx, { budgets: updated }, counter)
    return counter.member === undefined ? entry : withUpdatedBy(entry, counter.member)
  })
  await afterCommit(ctx, ['budgets'])
  return result
}

async function deleteBudgetIn(ctx: SpaceCtx, id: string): Promise<void> {
  if (await softDeleteIn(ctx, 'budgets', id)) await afterCommit(ctx, ['budgets'])
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
// `storageKey` is the base key of the space (the handle passes it back to
// applyEntryConversions of the same space).
async function readEntriesForConversionIn(ctx: SpaceCtx): Promise<
  Array<ConversionStorageGroup>
> {
  const groups: Array<ConversionStorageGroup> = []
  for (const storageKey of await allExpenseChunkKeys(ctx)) {
    const records = await readChunk(ctx, storageKey)
    if (records.length > 0) groups.push({ storageKey, records })
  }
  const income = (await readStore(ctx, 'income')) ?? []
  if (income.length > 0) groups.push({ storageKey: 'income', records: income })
  return groups
}

async function readEntryKey(
  ctx: SpaceCtx,
  storageKey: string,
): Promise<Array<Expense | IncomeEntry>> {
  if (storageKey === 'income') return (await readStore(ctx, 'income')) ?? []
  return readChunk(ctx, storageKey)
}

// Writes the computed conversions under the lock of `storageKey`. A record is
// updated only when it still exists, is live, is not converted for
// `mainCurrency` yet and still has the amount, currency and createdAt the rate
// was computed for (an edit in between leaves it pending). Only `conversion`
// changes; updatedAt and rev stay (derived data, meta:sync untouched).
// Returns the number of records written.
async function applyEntryConversionsIn(
  ctx: SpaceCtx,
  storageKey: string,
  mainCurrency: Currency,
  updates: Array<EntryConversionUpdate>,
): Promise<number> {
  if (updates.length === 0) return 0
  if (storageKey !== 'income' && !EXPENSE_CHUNK_KEY_RE.test(storageKey)) {
    throw new Error(`applyEntryConversions: not an entry key "${storageKey}"`)
  }
  const byId = new Map(updates.map((u) => [u.id, u]))
  const written = await withSpaceLock(ctx, storageKey, async () => {
    if (!_key) throw new Error('LocalDb not initialized')
    const records = await readEntryKey(ctx, storageKey)
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
    await writeKeysMany(ctx, { [storageKey]: next })
    return count
  })
  if (written > 0) {
    await afterCommit(ctx, [storageKey], { fromConversion: true, dataChange: false })
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
async function convertBudgetsIn(
  ctx: SpaceCtx,
  target: Currency,
  rateFor: (from: Currency) => number,
  options: { setMainCurrency: boolean },
): Promise<number> {
  const s = store
  if (!s) return 0
  const lockKeys = ctx.personal
    ? ['budgets', META_SETTINGS_KEY, SYNC_META_KEY, SYNCED_SETTINGS_KEY]
    : ['budgets', SYNC_META_KEY, SYNCED_SETTINGS_KEY]
  const result = await withSpaceLock(
    ctx,
    lockKeys,
    async () => {
      const current = await readSyncedSettingsIn(ctx)
      if (!options.setMainCurrency && current.mainCurrency !== target) {
        return { converted: 0, keys: [] as Array<string> }
      }
      if (!_key) throw new Error('LocalDb not initialized')

      const budgets = (await readStore(ctx, 'budgets')) ?? []
      const updatedAt = nowIso()
      const counter = await openRevCounter(ctx)
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
        const stripped = ctx.personal
          ? stripLegacyCurrency(await readPlainSettings(s))
          : null
        if (stripped) {
          plain.push([META_SETTINGS_KEY, stripped])
          writtenKeys.push(META_SETTINGS_KEY)
        }
      }
      await writeKeysMany(ctx, values, counter, plain)
      return { converted, keys: writtenKeys }
    },
  )
  if (result.keys.length > 0) {
    // The one-time fix is the converter's own background work, not a data
    // change for the backup reminder; a main-currency change is.
    await afterCommit(ctx, result.keys, {
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
  ctx: SpaceCtx,
  key: string,
): Promise<Array<GeneratedRecord>> {
  if (key === 'income') return (await readStore(ctx, 'income')) ?? []
  return readChunk(ctx, key)
}

// The ids of the live categories of the item's kind.
async function categoryIdsFor(ctx: SpaceCtx, kind: RecurringKind): Promise<Array<string>> {
  return (await liveCategories(ctx, categoryKeyFor(kind))).map((c) => c.id)
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
  ctx: SpaceCtx,
  input: CreateRecurringInput,
): Promise<CreateRecurringInput> {
  const base = recurringInputSchema.safeParse(input)
  if (!base.success) throw validationError(base.error.issues[0].message)
  const checked = recurringInputSchemaFor(
    await categoryIdsFor(ctx, base.data.kind),
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
  ctx: SpaceCtx,
  item: RecurringItem,
  dates: Array<string>,
  counter: RevCounter,
  overrides?: OccurrenceOverrides,
): Promise<{ values: Record<string, Array<GeneratedRecord>>; created: number }> {
  const lists = new Map<string, Array<GeneratedRecord>>()
  const values: Record<string, Array<GeneratedRecord>> = {}
  const main = await readMainCurrency(ctx)
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
    const list = lists.get(key) ?? (await readOccurrenceTarget(ctx, key))
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
    stampCreated(counter.member, record, {})
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

async function getAllRecurringIn(ctx: SpaceCtx): Promise<Array<RecurringItem>> {
  return liveRecords((await readStore(ctx, 'recurring')) ?? [])
}

async function getDueRecurringIn(
  ctx: SpaceCtx,
  today: string = toLocalDateString(),
): Promise<Array<RecurringOccurrence>> {
  return dueOccurrences(await getAllRecurringIn(ctx), today)
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
  ctx: SpaceCtx,
  first: RecurringItem,
  today: string,
): Promise<ItemOutcome> {
  let candidate: RecurringItem | undefined = first
  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      candidate = ((await readStore(ctx, 'recurring')) ?? []).find(
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

    const result = await withSpaceLock(
      ctx,
      ['recurring', SYNC_META_KEY, ...lockedTargets],
      async (): Promise<
        | { status: 'done' }
        | { status: 'retry' }
        | { status: 'written'; created: number; keys: Array<string> }
      > => {
        const items = (await readStore(ctx, 'recurring')) ?? []
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
        if (!(await categoryIdsFor(ctx, item.kind)).includes(item.categoryId)) {
          console.warn(
            `Recurring item ${item.id}: category ${item.categoryId} not found, skipped`,
          )
          return { status: 'done' }
        }

        // Dates already handled out of order (an ask item switched to auto)
        // are not created again.
        const ahead = new Set(item.handledAhead)
        const toCreate = dates.filter((d) => !ahead.has(d))
        const counter = await openRevCounter(ctx)
        const plan = await planOccurrenceWrites(ctx, item, toCreate, counter)
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
        await writeKeysMany(ctx, values, counter)
        return {
          status: 'written',
          created: plan.created,
          keys: Object.keys(values),
        }
      },
    )

    if (result.status === 'retry') continue
    if (result.status === 'done') return UNTOUCHED
    await afterCommit(ctx, result.keys)
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
async function processDueRecurringIn(
  ctx: SpaceCtx,
  today: string = toLocalDateString(),
): Promise<{ created: number; itemsTouched: number }> {
  if (!store || personalLocked(ctx)) return { created: 0, itemsTouched: 0 }
  const items = (await readStore(ctx, 'recurring')) ?? []
  let created = 0
  let itemsTouched = 0
  for (const item of items) {
    if (!isLive(item) || item.mode !== 'auto' || item.paused) continue
    const outcome = await processRecurringItem(ctx, item, today)
    created += outcome.created
    if (outcome.touched) itemsTouched++
  }
  return { created, itemsTouched }
}

async function addRecurringIn(
  ctx: SpaceCtx,
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

  const { item, keys: written } = await withSpaceLock(
    ctx,
    ['recurring', SYNC_META_KEY, ...targetKeys],
    async () => {
      const data = await validateRecurringInput(ctx, input)
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
      const counter = await openRevCounter(ctx)
      stampCreated(counter.member, created)
      const stored: RecurringItem = { ...created, rev: counter.next() }
      const records = createNow
        ? (await planOccurrenceWrites(ctx, created, through, counter)).values
        : {}
      const items = (await readStore(ctx, 'recurring')) ?? []
      const values = { recurring: [...items, stored], ...records }
      await writeKeysMany(ctx, values, counter)
      return { item: created, keys: Object.keys(values) }
    },
  )
  await afterCommit(ctx, written)
  return item
}

// Replaces the live item `id` with `update(existing)` (stamped with updatedAt
// and a rev) under the lock of `recurring` + meta:sync. Returns the updated
// item without rev.
async function updateRecurringItem(
  ctx: SpaceCtx,
  id: string,
  update: (existing: RecurringItem) => Promise<RecurringItem> | RecurringItem,
): Promise<RecurringItem> {
  const result = await withSpaceLock(ctx, ['recurring', SYNC_META_KEY], async () => {
    const items = (await readStore(ctx, 'recurring')) ?? []
    const index = liveItemIndex(items, id)
    if (index === -1) throw recurringNotFound(id)
    const updated: RecurringItem = {
      ...withoutRev(await update(items[index])),
      updatedAt: nowIso(),
    }
    const counter = await openRevCounter(ctx)
    const next = [...items]
    next[index] = { ...updated, rev: counter.next() }
    await writeKeysMany(ctx, { recurring: next }, counter)
    return counter.member === undefined ? updated : withUpdatedBy(updated, counter.member)
  })
  await afterCommit(ctx, ['recurring'])
  return result
}

async function updateRecurringIn(
  ctx: SpaceCtx,
  id: string,
  patch: UpdateRecurringInput,
): Promise<RecurringItem> {
  return updateRecurringItem(ctx, id, async (existing) => {
    const defined = Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      ),
    ) as UpdateRecurringInput
    const data = await validateRecurringInput(ctx, {
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
async function setRecurringPausedIn(
  ctx: SpaceCtx,
  id: string,
  paused: boolean,
  today: string = toLocalDateString(),
): Promise<RecurringItem> {
  return updateRecurringItem(ctx, id, (existing) => {
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
async function deleteRecurringIn(ctx: SpaceCtx, id: string): Promise<void> {
  if (await softDeleteIn(ctx, 'recurring', id)) await afterCommit(ctx, ['recurring'])
}

// Ask mode: creates the record for one due occurrence (with optional
// overrides for that record only) and marks the date handled. When a record
// for the date already exists (even a deleted one), nothing new is created.
async function confirmRecurringOccurrenceIn(
  ctx: SpaceCtx,
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
  const written = await withSpaceLock(ctx, lockKeys, async () => {
    const items = (await readStore(ctx, 'recurring')) ?? []
    const index = liveItemIndex(items, itemId)
    if (index === -1) throw recurringNotFound(itemId)
    const item = items[index]
    if (!isUnhandledOccurrence(item, date)) {
      throw occurrenceNotDue()
    }
    if (!(await categoryIdsFor(ctx, item.kind)).includes(item.categoryId)) {
      throw new AppError('category-not-found', 'Category not found')
    }
    const counter = await openRevCounter(ctx)
    const plan = await planOccurrenceWrites(ctx, item, [date], counter, overrides)
    const next = [...items]
    next[index] = {
      ...markOccurrenceHandled(item, date),
      updatedAt: nowIso(),
      rev: counter.next(),
    }
    const values = { recurring: next, ...plan.values }
    await writeKeysMany(ctx, values, counter)
    return Object.keys(values)
  })
  await afterCommit(ctx, written)
}

// Ask mode: marks one due occurrence handled without creating anything.
async function skipRecurringOccurrenceIn(
  ctx: SpaceCtx,
  itemId: string,
  date: string,
): Promise<void> {
  await updateRecurringItem(ctx, itemId, (item) => {
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
async function addRepeatingExpenseIn(
  ctx: SpaceCtx,
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
  const expenseConversion = conversionOnSave(entry, await readMainCurrency(ctx))
  if (expenseConversion) entry.conversion = expenseConversion
  const item = quickRepeatItem('expense', input, unit, today, now, recurringId)
  const chunkKey = expenseChunkKey(entry.createdAt)
  await withSpaceLock(ctx, [chunkKey, 'recurring', SYNC_META_KEY], async () => {
    const chunk = await readChunk(ctx, chunkKey)
    const items = (await readStore(ctx, 'recurring')) ?? []
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, entry, { paidBy: input.paidBy })
    stampCreated(counter.member, item)
    await writeKeysMany(
      ctx,
      {
        [chunkKey]: [...chunk, { ...entry, rev: counter.next() }],
        recurring: [...items, { ...item, rev: counter.next() }],
      },
      counter,
    )
  })
  await afterCommit(ctx, [chunkKey, 'recurring'])
  return withExpenseCategory(ctx, entry)
}

// Saves the income entry (as addIncome, with the deterministic occurrence id)
// and a matching auto-mode recurring item starting today, in one transaction.
async function addRepeatingIncomeIn(
  ctx: SpaceCtx,
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
  const incomeConversion = conversionOnSave(entry, await readMainCurrency(ctx))
  if (incomeConversion) entry.conversion = incomeConversion
  const item = quickRepeatItem('income', input, unit, today, now, recurringId)
  await withSpaceLock(ctx, ['income', 'recurring', SYNC_META_KEY], async () => {
    const income = (await readStore(ctx, 'income')) ?? []
    const items = (await readStore(ctx, 'recurring')) ?? []
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, entry, { paidBy: input.paidBy })
    stampCreated(counter.member, item)
    await writeKeysMany(
      ctx,
      {
        income: [...income, { ...entry, rev: counter.next() }],
        recurring: [...items, { ...item, rev: counter.next() }],
      },
      counter,
    )
  })
  await afterCommit(ctx, ['income', 'recurring'])
  return withIncomeCategory(ctx, entry)
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

export interface ApplyIncomingOptions {
  /** An equal updatedAt with different content takes the incoming record. */
  preferIncomingOnTie?: boolean
}

type StoredRecord = Record<string, unknown> & { id: string }

type ObjectKey = 'syncedSettings' | 'identity' | 'spaceInfo'

const SINGLE_KEY_TYPES: Array<[SyncRecordType, SingleListKey]> = [
  ['category', 'categories'],
  ['incomeCategory', 'incomeCategories'],
  ['income', 'income'],
  ['budget', 'budgets'],
  ['recurring', 'recurring'],
]

// List keys only one kind of space has.
const PERSONAL_LIST_TYPES: Array<[SyncRecordType, SingleListKey]> = [['spaceKey', 'spaceKeys']]
const FAMILY_LIST_TYPES: Array<[SyncRecordType, SingleListKey]> = [
  ['memberProfile', 'memberProfiles'],
]

// Single-record keys (one object, not a list), per kind of space.
const PERSONAL_OBJECT_TYPES: Array<[SyncRecordType, ObjectKey]> = [
  ['settings', 'syncedSettings'],
  ['identity', 'identity'],
]
const FAMILY_OBJECT_TYPES: Array<[SyncRecordType, ObjectKey]> = [
  ['settings', 'syncedSettings'],
  ['spaceInfo', 'spaceInfo'],
]

function listTypesOf(ctx: SpaceCtx): Array<[SyncRecordType, SingleListKey]> {
  return [...SINGLE_KEY_TYPES, ...(ctx.personal ? PERSONAL_LIST_TYPES : FAMILY_LIST_TYPES)]
}

function objectTypesOf(ctx: SpaceCtx): Array<[SyncRecordType, ObjectKey]> {
  return ctx.personal ? PERSONAL_OBJECT_TYPES : FAMILY_OBJECT_TYPES
}

// The storage base key of each record type the space accepts ('expense' goes
// to chunks and is not listed).
function keyOfTypeFor(ctx: SpaceCtx): Map<SyncRecordType, string> {
  return new Map<SyncRecordType, string>([...listTypesOf(ctx), ...objectTypesOf(ctx)])
}

function isObjectKey(key: string): key is ObjectKey {
  return key === SYNCED_SETTINGS_KEY || key === IDENTITY_KEY || key === SPACE_INFO_KEY
}

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
// categories, income, budgets, recurring items and the settings record; then
// personal: the identity and the space keys; Family: the space info and the
// member profiles. A DecryptError (or, for a Family space without its key,
// SpaceLockedError) propagates.
async function listChangedRecordsIn(
  ctx: SpaceCtx,
  sinceRev: number,
): Promise<ChangedRecords> {
  if (!ctx.personal) await cryptoFor(ctx.spaceId)
  const maxRev = await getLocalRevIn(ctx)
  const records: Array<SyncRecord> = []
  const collect = (type: SyncRecordType, list: Array<unknown>) => {
    for (const item of list) {
      const record = item as StoredRecord
      const rev = typeof record.rev === 'number' ? record.rev : 0
      if (rev > sinceRev && rev <= maxRev) records.push(toSyncRecord(type, record))
    }
  }
  for (const chunkKey of await allExpenseChunkKeys(ctx)) {
    collect('expense', await readChunk(ctx, chunkKey))
  }
  for (const [type, key] of SINGLE_KEY_TYPES) {
    collect(type, (await readStore(ctx, key)) ?? [])
  }
  for (const [type, key] of objectTypesOf(ctx)) {
    const value = await readStore(ctx, key)
    if (value !== undefined) collect(type, [value])
  }
  const extraLists = ctx.personal ? PERSONAL_LIST_TYPES : FAMILY_LIST_TYPES
  for (const [type, key] of extraLists) {
    collect(type, (await readStore(ctx, key)) ?? [])
  }
  return { maxRev, records }
}

function isParseableDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isBase64Key(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false
  try {
    return base64ToBytes(value).byteLength === 32
  } catch {
    return false
  }
}

function isValidIncoming(
  record: unknown,
  keyOfType: Map<SyncRecordType, string>,
): record is SyncRecord {
  const r = asObject(record)
  if (!r) return false
  const type = r.type as SyncRecordType
  if (type !== 'expense' && !keyOfType.has(type)) return false
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
  if (type === 'identity') {
    return (
      r.id === IDENTITY_KEY &&
      asObject(data.publicKeyJwk) !== null &&
      asObject(data.privateKeyJwk) !== null
    )
  }
  if (type === 'spaceKey') {
    const tombstone = typeof r.deletedAt === 'string' && r.deletedAt !== ''
    return (
      isValidFamilySpaceId(r.id) &&
      typeof data.keyVersion === 'number' &&
      Number.isInteger(data.keyVersion) &&
      data.keyVersion >= 1 &&
      (data.role === 'owner' || data.role === 'member') &&
      typeof data.name === 'string' &&
      (tombstone || isBase64Key(data.key))
    )
  }
  if (type === 'spaceInfo') {
    return r.id === 'space' && typeof data.name === 'string'
  }
  if (type === 'memberProfile') {
    return typeof data.displayName === 'string'
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
//
// `preferIncomingOnTie` (the sync engine, for the server copy of a 'stale' push
// result): an equal updatedAt with different content takes the incoming record
// (still counted as a conflict), so every device converges on the server copy.
async function applyIncomingRecordsIn(
  ctx: SpaceCtx,
  records: Array<SyncRecord>,
  options: ApplyIncomingOptions = {},
): Promise<ApplyIncomingResult> {
  const KEY_OF_TYPE = keyOfTypeFor(ctx)
  records.forEach((record, index) => {
    if (!isValidIncoming(record, KEY_OF_TYPE)) {
      throw new Error(`applyIncomingRecords: invalid record ${index}`)
    }
  })
  const empty: ApplyIncomingResult = { applied: 0, kept: 0, conflicts: 0 }
  if (records.length === 0) return empty
  if (!_key || !store) {
    if (ctx.personal) throw new Error('LocalDb not initialized')
    throw new SpaceLockedError(ctx.spaceId)
  }
  if (!ctx.personal) await cryptoFor(ctx.spaceId)

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
      ? Array.from(new Set([...(await allExpenseChunkKeys(ctx)), ...targetChunks]))
      : []
    const outcome = await withSpaceLock(
      ctx,
      [...singleKeys, ...chunkKeys],
      async (): Promise<
        { status: 'retry' } | { status: 'done'; result: ApplyIncomingResult; written: Array<string> }
      > => {
        if (hasExpenses) {
          const locked = new Set(chunkKeys)
          if ((await allExpenseChunkKeys(ctx)).some((k) => !locked.has(k))) {
            return { status: 'retry' }
          }
        }

        // Read everything first: a DecryptError leaves nothing written.
        const singles = new Map<string, KeyState>()
        const objects = new Map<string, { value: StoredRecord | undefined; changed: boolean }>()
        for (const key of singleKeys) {
          if (isObjectKey(key)) {
            const stored = await readStore(ctx, key)
            objects.set(key, {
              value: stored === undefined ? undefined : (stored as unknown as StoredRecord),
              changed: false,
            })
            continue
          }
          singles.set(key, buildState((await readStore(ctx, key as SingleListKey)) ?? []))
        }
        const chunks = new Map<string, KeyState>()
        for (const key of chunkKeys) chunks.set(key, buildState(await readChunk(ctx, key)))

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
          } else if (isObjectKey(KEY_OF_TYPE.get(record.type) as string)) {
            local = objects.get(KEY_OF_TYPE.get(record.type) as string)?.value
          } else {
            const key = KEY_OF_TYPE.get(record.type) as string
            const i = singleIndex.get(key)?.get(record.id)
            local = i === undefined ? undefined : (singles.get(key)?.list[i] ?? undefined)
          }

          const decision = mergeRecord(local, incoming)
          let take = decision === 'take-incoming'
          if (decision === 'conflict-same-time' && local) {
            result.conflicts++
            take =
              options.preferIncomingOnTie === true ||
              sameTimeWinner(local, incoming) === 'incoming'
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
          } else if (isObjectKey(KEY_OF_TYPE.get(record.type) as string)) {
            objects.set(KEY_OF_TYPE.get(record.type) as string, {
              value: incoming,
              changed: true,
            })
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
        for (const [key, state] of objects) {
          if (state.changed && state.value) values[key] = state.value
        }
        await writeKeysMany(ctx, values)
        return { status: 'done', result, written: Object.keys(values) }
      },
    )
    if (outcome.status === 'retry') continue
    if (outcome.written.length > 0) await afterCommit(ctx, outcome.written)
    return outcome.result
  }
  throw new Error('applyIncomingRecords: storage kept changing')
}

// Really removes the tombstones whose deletedAt is strictly older than
// `olderThan` from every list (records and revs otherwise untouched). With
// `maxRev`, only tombstones whose rev is at most maxRev (already pushed to the
// server) are removed. Only the changed keys are written, in one setMany, and
// announced to other tabs; no lastDataChangeAt, no conversion request, no
// local-change notification. Returns how many records it removed. Called by
// the sync engine after a cycle.
async function compactTombstonesIn(
  ctx: SpaceCtx,
  olderThan: string,
  options: { maxRev?: number } = {},
): Promise<number> {
  const cutoff = Date.parse(olderThan)
  if (Number.isNaN(cutoff)) {
    throw new Error(`compactTombstones: invalid date "${olderThan}"`)
  }
  if (!store || personalLocked(ctx)) return 0
  const { maxRev } = options
  const singleKeys: Array<SingleListKey> = [
    'categories',
    'incomeCategories',
    'income',
    'budgets',
    'recurring',
  ]
  if (!ctx.personal) singleKeys.push('memberProfiles')
  const chunkKeys = await allExpenseChunkKeys(ctx)
  const { removed, written } = await withSpaceLock(
    ctx,
    [...chunkKeys, ...singleKeys],
    async () => {
      const lists = new Map<string, Array<Revisioned>>()
      for (const key of chunkKeys) lists.set(key, await readChunk(ctx, key))
      for (const key of singleKeys) {
        lists.set(key, ((await readStore(ctx, key)) ?? []) as Array<Revisioned>)
      }
      const values: Record<string, Array<Revisioned>> = {}
      let count = 0
      for (const [key, list] of lists) {
        const kept = list.filter(
          (r) =>
            !(
              r.deletedAt &&
              Date.parse(r.deletedAt) < cutoff &&
              (maxRev === undefined || (r.rev ?? 0) <= maxRev)
            ),
        )
        if (kept.length !== list.length) {
          count += list.length - kept.length
          values[key] = kept
        }
      }
      await writeKeysMany(ctx, values)
      return { removed: count, written: Object.keys(values) }
    },
  )
  if (written.length > 0) {
    if (ctx.personal) postChanged(written)
    else postChanged(written, ctx.spaceId)
  }
  return removed
}

// ── Legacy duplicate occurrences (sync) ───────────────────────────────────────

interface OccurrenceSlot {
  key: string
  index: number
  id: string
}

// Reduces duplicate live occurrences of the given recurring items (records
// from before deterministic ids: random ids, same recurringId +
// occurrenceDate, both live) to one. In each group the record whose id equals
// occurrenceRecordId(recurringId, occurrenceDate) is kept, else the smallest
// id (plain string order); the others become tombstones as a user write
// (deletedAt = updatedAt = now, a fresh rev), so the cleanup syncs. One lock,
// one setMany. Returns how many records were tombstoned; nothing to do writes
// nothing.
async function dedupeOccurrencesIn(
  ctx: SpaceCtx,
  recurringIds: Array<string>,
): Promise<number> {
  const wanted = new Set(
    recurringIds.filter((id) => typeof id === 'string' && id !== ''),
  )
  if (wanted.size === 0 || !store || personalLocked(ctx)) return 0

  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    const chunkKeys = await allExpenseChunkKeys(ctx)
    const outcome = await withSpaceLock(
      ctx,
      ['income', SYNC_META_KEY, ...chunkKeys],
      async (): Promise<
        { status: 'retry' } | { status: 'done'; removed: number; written: Array<string> }
      > => {
        const locked = new Set(chunkKeys)
        if ((await allExpenseChunkKeys(ctx)).some((k) => !locked.has(k))) {
          return { status: 'retry' }
        }
        const lists = new Map<string, Array<StoredRecord>>()
        for (const key of chunkKeys) {
          lists.set(key, (await readChunk(ctx, key)) as unknown as Array<StoredRecord>)
        }
        lists.set(
          'income',
          ((await readStore(ctx, 'income')) ?? []) as unknown as Array<StoredRecord>,
        )

        // Groups by kind, recurringId and occurrenceDate (live records only).
        const groups = new Map<
          string,
          { recurringId: string; date: string; slots: Array<OccurrenceSlot> }
        >()
        for (const [key, list] of lists) {
          const kind = key === 'income' ? 'income' : 'expense'
          list.forEach((record, index) => {
            if (!isLive(record as Revisioned)) return
            const recurringId = record.recurringId
            const date = record.occurrenceDate
            if (typeof recurringId !== 'string' || !wanted.has(recurringId)) return
            if (typeof date !== 'string') return
            const groupKey = `${kind}\u0000${recurringId}\u0000${date}`
            const group = groups.get(groupKey) ?? { recurringId, date, slots: [] }
            group.slots.push({ key, index, id: record.id })
            groups.set(groupKey, group)
          })
        }

        const doomed: Array<OccurrenceSlot> = []
        for (const group of groups.values()) {
          if (group.slots.length < 2) continue
          const canonical = await occurrenceRecordId(group.recurringId, group.date)
          const keep =
            group.slots.find((s) => s.id === canonical) ??
            group.slots.reduce((min, s) => (s.id < min.id ? s : min))
          for (const slot of group.slots) if (slot !== keep) doomed.push(slot)
        }
        if (doomed.length === 0) return { status: 'done', removed: 0, written: [] }

        const counter = await openRevCounter(ctx)
        const now = nowIso()
        const values: Record<string, Array<StoredRecord>> = {}
        for (const slot of doomed) {
          const list = values[slot.key] ?? [...(lists.get(slot.key) ?? [])]
          list[slot.index] = {
            ...list[slot.index],
            deletedAt: now,
            updatedAt: now,
            rev: counter.next(),
          }
          values[slot.key] = list
        }
        await writeKeysMany(ctx, values, counter)
        return { status: 'done', removed: doomed.length, written: Object.keys(values) }
      },
    )
    if (outcome.status === 'retry') continue
    if (outcome.written.length > 0) await afterCommit(ctx, outcome.written)
    return outcome.removed
  }
  throw new Error('dedupeOccurrences: storage kept changing')
}

// ── Re-key (sync: "Join cloud data and keep this device's entries") ──────────

export interface RekeyResult {
  /** Records re-stamped (live records plus the settings record). */
  records: number
  /** localRev before the re-stamp. */
  startRev: number
  /** localRev after it. */
  localRev: number
}

const REKEY_SINGLE_KEYS: Array<SingleListKey> = [
  'categories',
  'incomeCategories',
  'income',
  'budgets',
  'recurring',
  'spaceKeys',
]

// Re-encrypts this device's LIVE data under `newKey` (used only by
// vault.joinCloudVault). Under one lock: everything is read with the current
// key (a DecryptError propagates and nothing is written), tombstones are
// dropped (they belong to the old vault), every kept record and the settings
// record gets a fresh rev (id, updatedAt, createdAt and conversion kept), and
// ONE setMany writes every data key (expenses regrouped into the chunk of their
// createdAt; a key left empty gets an encrypted []), the `plain` entries
// verbatim and meta:sync = { ...stored, ...syncPatch, localRev } (plus
// pushedRev = startRev when the patch enables sync, so every re-inserted record
// is pushed). quarantine:* keys are left alone. Only after the commit does the
// in-memory key switch; a failure before leaves the store and the key as they
// were.
export async function rekeyLiveData(
  newKey: CryptoKey,
  extra: {
    plain?: Array<[string, unknown]>
    syncPatch?: Record<string, unknown>
  } = {},
): Promise<RekeyResult> {
  const s = store
  if (!_key || !s) throw new Error('LocalDb not initialized')
  const plain = extra.plain ?? []
  const syncPatch = extra.syncPatch ?? {}

  const P = PERSONAL_CTX
  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    const chunkKeys = await allExpenseChunkKeys(P)
    const outcome = await withWriteLock(
      [
        ...chunkKeys,
        ...REKEY_SINGLE_KEYS,
        SYNCED_SETTINGS_KEY,
        IDENTITY_KEY,
        SYNC_META_KEY,
        ...plain.map(([key]) => key),
      ],
      async (): Promise<
        { status: 'retry' } | { status: 'done'; result: RekeyResult; written: Array<string> }
      > => {
        const locked = new Set(chunkKeys)
        if ((await allExpenseChunkKeys(P)).some((k) => !locked.has(k))) {
          return { status: 'retry' }
        }

        // Read everything with the current key first. The space keys and the
        // identity are re-encrypted too (only when present), so the device
        // keeps its Family access; Family data itself is encrypted with the
        // space keys and needs nothing.
        const chunks = new Map<string, Array<Expense>>()
        for (const key of chunkKeys) chunks.set(key, await readChunk(P, key))
        const singles = new Map<string, Array<Revisioned>>()
        for (const key of REKEY_SINGLE_KEYS) {
          const raw = await get<unknown>(key, s)
          if (raw === undefined) continue
          singles.set(key, ((await readStore(P, key)) ?? []) as Array<Revisioned>)
        }
        const settings = await readStore(P, 'syncedSettings')
        const identity = await readStore(P, 'identity')

        const counter = await openRevCounter(P)
        const startRev = counter.last
        const values = new Map<string, unknown>()

        const regrouped = new Map<string, Array<Expense>>(
          chunkKeys.map((key) => [key, []]),
        )
        for (const list of chunks.values()) {
          for (const expense of list) {
            if (!isLive(expense)) continue
            const target = expenseChunkKey(expense.createdAt)
            const bucket = regrouped.get(target) ?? []
            bucket.push({ ...expense, rev: counter.next() })
            regrouped.set(target, bucket)
          }
        }
        for (const [key, list] of regrouped) values.set(key, list)
        for (const [key, list] of singles) {
          values.set(
            key,
            list.filter(isLive).map((r) => ({ ...r, rev: counter.next() })),
          )
        }
        if (settings !== undefined) {
          values.set(SYNCED_SETTINGS_KEY, { ...settings, rev: counter.next() })
        }
        if (identity !== undefined) {
          values.set(IDENTITY_KEY, { ...identity, rev: counter.next() })
        }

        const entries: Array<[IDBValidKey, unknown]> = []
        for (const [key, value] of values) {
          entries.push([key, await encryptValue(newKey, value)])
        }
        entries.push(...plain)
        const meta: Record<string, unknown> = {
          ...counter.base,
          ...syncPatch,
          localRev: counter.last,
        }
        if (syncPatch.enabled === true) meta.pushedRev = startRev
        entries.push([SYNC_META_KEY, meta])

        await setMany(entries, s)
        return {
          status: 'done',
          result: {
            records: counter.last - startRev,
            startRev,
            localRev: counter.last,
          },
          written: [...values.keys()],
        }
      },
    )
    if (outcome.status === 'retry') continue
    _key = newKey
    markKeyringStale()
    await afterCommit(P, outcome.written)
    notifyLocalChange()
    return outcome.result
  }
  throw new Error('rekeyLiveData: storage kept changing')
}

// ── Member identity (personal record `identity`) ──────────────────────────────

// The member's ECDH P-256 key pair, created on first need and stored in the
// encrypted personal record `identity` (so it syncs to the user's other
// devices). Read from the store on every call (never cached), so a lock leaves
// no identity key in memory. Needs an unlocked vault.
export async function ensureIdentityKeyPair(): Promise<IdentityKeyPair> {
  if (!_key || !store) throw new Error('LocalDb not initialized')
  const P = PERSONAL_CTX
  const { pair, wrote } = await withWriteLock([IDENTITY_KEY, SYNC_META_KEY], async () => {
    const existing = await readStore(P, 'identity')
    if (existing !== undefined) {
      return {
        pair: { publicKeyJwk: existing.publicKeyJwk, privateKeyJwk: existing.privateKeyJwk },
        wrote: false,
      }
    }
    const created = await generateIdentityKeyPair()
    const now = nowIso()
    const counter = await openRevCounter(P)
    const record: IdentityRecord = {
      id: 'identity',
      publicKeyJwk: created.publicKeyJwk,
      privateKeyJwk: created.privateKeyJwk,
      createdAt: now,
      updatedAt: now,
      rev: counter.next(),
    }
    await writeKeysMany(P, { [IDENTITY_KEY]: record }, counter)
    return { pair: created, wrote: true }
  })
  if (wrote) await afterCommit(P, [IDENTITY_KEY])
  return pair
}

export async function getIdentityPublicKey(): Promise<JsonWebKey> {
  return (await ensureIdentityKeyPair()).publicKeyJwk
}

// ── Spaces API (no UI yet) ────────────────────────────────────────────────────

const SPACE_NAME_MAX = 60

function toLocalSpace(entry: SpaceKeyEntry): LocalSpace {
  return {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    keyVersion: entry.keyVersion,
    joinedAt: entry.joinedAt,
  }
}

// The live Family spaces of this device (no key bytes), oldest first. Empty
// while locked.
export async function listLocalSpaces(): Promise<Array<LocalSpace>> {
  if (!_key || !store) return []
  if (keyringNeedsLoad()) await loadKeyring()
  const held = new Set(heldSpaceIds())
  const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
  return entries
    .filter((e) => isLive(e) && held.has(e.id))
    .map(toLocalSpace)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
}

// Creates the Family space: a new id and space key, the personal spaceKeys
// entry (owner, version 1), and in the space spaceInfo, the default expense
// and income categories in `lang` and syncedSettings with the personal main
// currency and rates switch. Everything, with both meta:sync counters, is
// written in ONE setMany. At most one live Family space.
export async function createLocalSpace(input: {
  name: string
  lang?: Lang
}): Promise<LocalSpace> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > SPACE_NAME_MAX) {
    throw new SpaceError('invalid-name', 'A space name needs 1 to 60 characters')
  }
  const dek = _key
  const s = store
  if (!dek || !s) throw new Error('LocalDb not initialized')
  const lang = input.lang ?? getLang()
  const member = await getCurrentMemberId()
  const personalSettings = await readSyncedSettingsIn(PERSONAL_CTX)
  const spaceId = crypto.randomUUID()
  const fam = ctxFor(spaceId)
  const skBytes = generateSpaceKey()
  const sk = await importSpaceKey(skBytes)
  const familyBases = [SPACE_INFO_KEY, 'categories', 'incomeCategories', SYNCED_SETTINGS_KEY]

  const space = await withWriteLock(
    [
      SPACE_KEYS_KEY,
      SYNC_META_KEY,
      ...[...familyBases, SYNC_META_KEY].map((k) => storageKeyOf(fam, k)),
    ],
    async () => {
      const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
      if (entries.some(isLive)) {
        throw new SpaceError('family-space-exists', 'A Family space already exists')
      }
      const now = nowIso()
      const personalCounter = await openRevCounter(PERSONAL_CTX)
      const entry: SpaceKeyEntry = {
        id: spaceId,
        keyVersion: 1,
        key: bytesToBase64(skBytes),
        name,
        role: 'owner',
        joinedAt: now,
        updatedAt: now,
        rev: personalCounter.next(),
      }

      // The new space's counter (normally absent: starts at 0).
      const familyMetaKey = storageKeyOf(fam, SYNC_META_KEY)
      const familyMetaRaw = await get<unknown>(familyMetaKey, s)
      let familyRev = parseLocalRev(familyMetaRaw)
      const next = () => ++familyRev
      const stamp = <T extends { createdBy?: string; updatedBy?: string }>(r: T): T =>
        stampCreated<T>(member, r)
      const info = stamp<SpaceInfoRecord>({
        id: 'space',
        name,
        createdAt: now,
        updatedAt: now,
        rev: next(),
      })
      const categories: Array<Category> = defaultExpenseCategories(lang).map((c) =>
        stamp<Category>({
          id: crypto.randomUUID(),
          name: c.name,
          icon: c.icon,
          updatedAt: now,
          rev: next(),
        }),
      )
      const incomeCategories: Array<Category> = defaultIncomeCategories(lang).map((c) =>
        stamp<Category>({
          id: crypto.randomUUID(),
          name: c.name,
          icon: c.icon,
          updatedAt: now,
          rev: next(),
        }),
      )
      const settings: SyncedSettingsRecord = {
        id: 'settings',
        mainCurrency: personalSettings.mainCurrency,
        fetchExchangeRates: personalSettings.fetchExchangeRates,
        updatedAt: now,
        rev: next(),
      }
      if (member) settings.updatedBy = member

      const familyValues: Record<string, unknown> = {
        [SPACE_INFO_KEY]: info,
        categories,
        incomeCategories,
        [SYNCED_SETTINGS_KEY]: settings,
      }
      const writes: Array<[IDBValidKey, unknown]> = [
        [SPACE_KEYS_KEY, await encryptValue(dek, [...entries, entry])],
        [SYNC_META_KEY, { ...personalCounter.base, localRev: personalCounter.last }],
      ]
      for (const [base, value] of Object.entries(familyValues)) {
        writes.push([storageKeyOf(fam, base), await encryptValue(sk, value)])
      }
      writes.push([familyMetaKey, { ...(asObject(familyMetaRaw) ?? {}), localRev: familyRev }])
      if (_key !== dek) throw new Error('LocalDb not initialized')
      await setMany(writes, s)
      return toLocalSpace(entry)
    },
  )
  skBytes.fill(0)
  markKeyringStale()
  notifyLocalChange()
  postChanged([SPACE_KEYS_KEY])
  postChanged(familyBases, spaceId)
  await markDataChanged()
  requestEntryConversion()
  return space
}

// Leaves the space on this device and, through personal sync, on the user's
// other devices: the spaceKeys entry becomes a tombstone without any key
// material (a personal user write), then every `space:<id>:*` key is deleted
// (quarantine copies are kept). Needs only the DEK. An unknown or already
// forgotten id deletes leftover keys only.
export async function forgetLocalSpace(spaceId: SpaceId): Promise<void> {
  if (!isValidFamilySpaceId(spaceId)) return
  const s = store
  if (!_key || !s) throw new Error('LocalDb not initialized')
  const P = PERSONAL_CTX
  const wrote = await withWriteLock([SPACE_KEYS_KEY, SYNC_META_KEY], async () => {
    const entries = (await readStore(P, 'spaceKeys')) ?? []
    const index = entries.findIndex((e) => e.id === spaceId && isLive(e))
    if (index === -1) return false
    const counter = await openRevCounter(P)
    const now = nowIso()
    const tombstone: SpaceKeyEntry = {
      ...entries[index],
      key: '',
      deletedAt: now,
      updatedAt: now,
      rev: counter.next(),
    }
    delete tombstone.previousKeys
    const next = [...entries]
    next[index] = tombstone
    await writeKeysMany(P, { [SPACE_KEYS_KEY]: next }, counter)
    return true
  })
  markKeyringStale()
  const prefix = keyFor(spaceId, '')
  const doomed = (await keys(s)).filter(
    (k): k is string => typeof k === 'string' && k.startsWith(prefix),
  )
  if (doomed.length > 0) await delMany(doomed, s)
  if (wrote) await afterCommit(P, [SPACE_KEYS_KEY])
}

function familyCtx(spaceId: SpaceId): SpaceCtx {
  if (spaceId === PERSONAL_SPACE_ID) {
    throw new SpaceError('unknown-space', 'The personal space has no space details')
  }
  return ctxFor(spaceId)
}

// The space details (without rev), or null before any were written.
export async function getSpaceInfo(spaceId: SpaceId): Promise<SpaceInfoRecord | null> {
  const ctx = familyCtx(spaceId)
  if (!_key) throw new SpaceLockedError(spaceId)
  const info = await readStore(ctx, 'spaceInfo')
  return info === undefined ? null : withoutRev(info)
}

// The live member profiles (without rev).
export async function getMemberProfiles(spaceId: SpaceId): Promise<Array<MemberProfile>> {
  const ctx = familyCtx(spaceId)
  if (!_key) throw new SpaceLockedError(spaceId)
  return liveRecords((await readStore(ctx, 'memberProfiles')) ?? [])
}

// Creates or replaces the profile `id` (a Family user write).
export async function upsertMemberProfile(
  spaceId: SpaceId,
  input: { id: string; displayName: string; color: string },
): Promise<MemberProfile> {
  const ctx = familyCtx(spaceId)
  if (!_key) throw new SpaceLockedError(spaceId)
  await cryptoFor(spaceId)
  const profile = await withSpaceLock(ctx, [MEMBER_PROFILES_KEY, SYNC_META_KEY], async () => {
    const list = (await readStore(ctx, 'memberProfiles')) ?? []
    const index = list.findIndex((p) => p.id === input.id)
    const counter = await openRevCounter(ctx)
    const updated: MemberProfile = {
      ...(index === -1 ? {} : withoutRev(list[index])),
      id: input.id,
      displayName: input.displayName,
      color: input.color,
      updatedAt: nowIso(),
    }
    delete updated.deletedAt
    const stamped = withUpdatedBy(updated, counter.member ?? null)
    const next = [...list]
    if (index === -1) next.push({ ...stamped, rev: counter.next() })
    else next[index] = { ...stamped, rev: counter.next() }
    await writeKeysMany(ctx, { [MEMBER_PROFILES_KEY]: next }, counter)
    return stamped
  })
  await afterCommit(ctx, [MEMBER_PROFILES_KEY])
  return profile
}

// ── Personal exports and the space handle ─────────────────────────────────────
//
// The top-level functions below are the Personal space and keep their
// signatures. spaceDb(id) gives the same members for any space.

const P_CTX = PERSONAL_CTX

export async function getLocalRev(): Promise<number> {
  return getLocalRevIn(P_CTX)
}
export function readSyncedSettings(): Promise<SyncedSettingsRecord> {
  return readSyncedSettingsIn(P_CTX)
}
export function updateSyncedSettings(patch: { fetchExchangeRates?: boolean }): Promise<void> {
  return updateSyncedSettingsIn(P_CTX, patch)
}
export function getExpensesForRange(from: string, to: string): Promise<Array<Expense>> {
  return getExpensesForRangeIn(P_CTX, from, to)
}
export function getAllExpenses(): Promise<Array<Expense>> {
  return getAllExpensesIn(P_CTX)
}
export function addExpense(input: CreateExpenseInput): Promise<Expense> {
  return addExpenseIn(P_CTX, input)
}
export function deleteExpense(id: string, createdAt: string): Promise<void> {
  return deleteExpenseIn(P_CTX, id, createdAt)
}
export function undeleteExpense(id: string, createdAt: string): Promise<Expense> {
  return undeleteExpenseIn(P_CTX, id, createdAt)
}
export function updateExpense(
  id: string,
  originalCreatedAt: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  return updateExpenseIn(P_CTX, id, originalCreatedAt, patch)
}
export function getAllCategories(): Promise<Array<Category>> {
  return getAllCategoriesIn(P_CTX)
}
export function addCategory(input: CreateCategoryInput): Promise<Category> {
  return addCategoryIn(P_CTX, input)
}
export function updateCategory(input: UpdateCategoryInput): Promise<Category> {
  return updateCategoryIn(P_CTX, input)
}
export function deleteCategory(id: string): Promise<void> {
  return deleteCategoryIn(P_CTX, id)
}
export function provisionDefaultCategories(lang?: Lang): Promise<void> {
  return provisionDefaultCategoriesIn(P_CTX, lang)
}
export function getAllIncomeCategories(): Promise<Array<Category>> {
  return getAllIncomeCategoriesIn(P_CTX)
}
export function addIncomeCategory(input: CreateCategoryInput): Promise<Category> {
  return addIncomeCategoryIn(P_CTX, input)
}
export function updateIncomeCategory(input: UpdateCategoryInput): Promise<Category> {
  return updateIncomeCategoryIn(P_CTX, input)
}
export function deleteIncomeCategory(id: string): Promise<void> {
  return deleteIncomeCategoryIn(P_CTX, id)
}
export function ensureIncomeCategories(lang?: Lang): Promise<boolean> {
  return ensureIncomeCategoriesIn(P_CTX, lang)
}
export function getAllIncome(): Promise<Array<IncomeEntry>> {
  return getAllIncomeIn(P_CTX)
}
export function addIncome(input: CreateIncomeInput): Promise<IncomeEntry> {
  return addIncomeIn(P_CTX, input)
}
export function deleteIncome(id: string): Promise<void> {
  return deleteIncomeIn(P_CTX, id)
}
export function getAllBudgets(): Promise<
  Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>
> {
  return getAllBudgetsIn(P_CTX)
}
export function upsertBudget(input: UpsertBudgetInput): Promise<BudgetEntry> {
  return upsertBudgetIn(P_CTX, input)
}
export function deleteBudget(id: string): Promise<void> {
  return deleteBudgetIn(P_CTX, id)
}
export function readEntriesForConversion(): Promise<Array<ConversionStorageGroup>> {
  return readEntriesForConversionIn(P_CTX)
}
export function applyEntryConversions(
  storageKey: string,
  mainCurrency: Currency,
  updates: Array<EntryConversionUpdate>,
): Promise<number> {
  return applyEntryConversionsIn(P_CTX, storageKey, mainCurrency, updates)
}
export function convertBudgets(
  target: Currency,
  rateFor: (from: Currency) => number,
  options: { setMainCurrency: boolean },
): Promise<number> {
  return convertBudgetsIn(P_CTX, target, rateFor, options)
}
export function getAllRecurring(): Promise<Array<RecurringItem>> {
  return getAllRecurringIn(P_CTX)
}
export function getDueRecurring(today?: string): Promise<Array<RecurringOccurrence>> {
  return getDueRecurringIn(P_CTX, today)
}
export function processDueRecurring(
  today?: string,
): Promise<{ created: number; itemsTouched: number }> {
  return processDueRecurringIn(P_CTX, today)
}
export function addRecurring(
  input: CreateRecurringInput,
  options: { createThroughToday: boolean; today?: string },
): Promise<RecurringItem> {
  return addRecurringIn(P_CTX, input, options)
}
export function updateRecurring(id: string, patch: UpdateRecurringInput): Promise<RecurringItem> {
  return updateRecurringIn(P_CTX, id, patch)
}
export function setRecurringPaused(
  id: string,
  paused: boolean,
  today?: string,
): Promise<RecurringItem> {
  return setRecurringPausedIn(P_CTX, id, paused, today)
}
export function deleteRecurring(id: string): Promise<void> {
  return deleteRecurringIn(P_CTX, id)
}
export function confirmRecurringOccurrence(
  itemId: string,
  date: string,
  overrides?: OccurrenceOverrides,
): Promise<void> {
  return confirmRecurringOccurrenceIn(P_CTX, itemId, date, overrides)
}
export function skipRecurringOccurrence(itemId: string, date: string): Promise<void> {
  return skipRecurringOccurrenceIn(P_CTX, itemId, date)
}
export function addRepeatingExpense(
  input: CreateExpenseInput,
  unit: QuickRepeatUnit,
): Promise<Expense> {
  return addRepeatingExpenseIn(P_CTX, input, unit)
}
export function addRepeatingIncome(
  input: CreateIncomeInput,
  unit: QuickRepeatUnit,
): Promise<IncomeEntry> {
  return addRepeatingIncomeIn(P_CTX, input, unit)
}

// The sync API also takes a leading spaceId; the one-argument forms are
// personal (the sync engine and its ports use them unchanged).
export function listChangedRecords(sinceRev: number): Promise<ChangedRecords>
export function listChangedRecords(spaceId: SpaceId, sinceRev: number): Promise<ChangedRecords>
export function listChangedRecords(
  first: SpaceId | number,
  second?: number,
): Promise<ChangedRecords> {
  if (typeof first === 'string') {
    return listChangedRecordsIn(ctxFor(first), second ?? -1)
  }
  return listChangedRecordsIn(P_CTX, first)
}

export function applyIncomingRecords(
  records: Array<SyncRecord>,
  options?: ApplyIncomingOptions,
): Promise<ApplyIncomingResult>
export function applyIncomingRecords(
  spaceId: SpaceId,
  records: Array<SyncRecord>,
  options?: ApplyIncomingOptions,
): Promise<ApplyIncomingResult>
export function applyIncomingRecords(
  first: SpaceId | Array<SyncRecord>,
  second?: Array<SyncRecord> | ApplyIncomingOptions,
  third?: ApplyIncomingOptions,
): Promise<ApplyIncomingResult> {
  if (typeof first === 'string') {
    return applyIncomingRecordsIn(ctxFor(first), second as Array<SyncRecord>, third)
  }
  return applyIncomingRecordsIn(P_CTX, first, second as ApplyIncomingOptions | undefined)
}

export function compactTombstones(
  olderThan: string,
  options?: { maxRev?: number },
): Promise<number> {
  return compactTombstonesIn(P_CTX, olderThan, options)
}
export function dedupeOccurrences(recurringIds: Array<string>): Promise<number> {
  return dedupeOccurrencesIn(P_CTX, recurringIds)
}

// The data functions of one space, with exactly the signatures of the
// same-named top-level (personal) exports.
export interface SpaceDb {
  getLocalRev: () => Promise<number>
  readSyncedSettings: typeof readSyncedSettings
  updateSyncedSettings: typeof updateSyncedSettings
  getExpensesForRange: typeof getExpensesForRange
  getAllExpenses: typeof getAllExpenses
  addExpense: typeof addExpense
  deleteExpense: typeof deleteExpense
  undeleteExpense: typeof undeleteExpense
  updateExpense: typeof updateExpense
  getAllCategories: typeof getAllCategories
  addCategory: typeof addCategory
  updateCategory: typeof updateCategory
  deleteCategory: typeof deleteCategory
  provisionDefaultCategories: typeof provisionDefaultCategories
  getAllIncomeCategories: typeof getAllIncomeCategories
  addIncomeCategory: typeof addIncomeCategory
  updateIncomeCategory: typeof updateIncomeCategory
  deleteIncomeCategory: typeof deleteIncomeCategory
  ensureIncomeCategories: typeof ensureIncomeCategories
  getAllIncome: typeof getAllIncome
  addIncome: typeof addIncome
  deleteIncome: typeof deleteIncome
  getAllBudgets: typeof getAllBudgets
  upsertBudget: typeof upsertBudget
  deleteBudget: typeof deleteBudget
  readEntriesForConversion: typeof readEntriesForConversion
  applyEntryConversions: typeof applyEntryConversions
  convertBudgets: typeof convertBudgets
  getAllRecurring: typeof getAllRecurring
  getDueRecurring: typeof getDueRecurring
  processDueRecurring: typeof processDueRecurring
  addRecurring: typeof addRecurring
  updateRecurring: typeof updateRecurring
  setRecurringPaused: typeof setRecurringPaused
  deleteRecurring: typeof deleteRecurring
  confirmRecurringOccurrence: typeof confirmRecurringOccurrence
  skipRecurringOccurrence: typeof skipRecurringOccurrence
  addRepeatingExpense: typeof addRepeatingExpense
  addRepeatingIncome: typeof addRepeatingIncome
  listChangedRecords: (sinceRev: number) => Promise<ChangedRecords>
  applyIncomingRecords: (
    records: Array<SyncRecord>,
    options?: ApplyIncomingOptions,
  ) => Promise<ApplyIncomingResult>
  compactTombstones: typeof compactTombstones
  dedupeOccurrences: typeof dedupeOccurrences
}

function buildSpaceDb(ctx: SpaceCtx): SpaceDb {
  return {
    getLocalRev: () => getLocalRevIn(ctx),
    readSyncedSettings: () => readSyncedSettingsIn(ctx),
    updateSyncedSettings: (patch) => updateSyncedSettingsIn(ctx, patch),
    getExpensesForRange: (from, to) => getExpensesForRangeIn(ctx, from, to),
    getAllExpenses: () => getAllExpensesIn(ctx),
    addExpense: (input) => addExpenseIn(ctx, input),
    deleteExpense: (id, createdAt) => deleteExpenseIn(ctx, id, createdAt),
    undeleteExpense: (id, createdAt) => undeleteExpenseIn(ctx, id, createdAt),
    updateExpense: (id, createdAt, patch) => updateExpenseIn(ctx, id, createdAt, patch),
    getAllCategories: () => getAllCategoriesIn(ctx),
    addCategory: (input) => addCategoryIn(ctx, input),
    updateCategory: (input) => updateCategoryIn(ctx, input),
    deleteCategory: (id) => deleteCategoryIn(ctx, id),
    provisionDefaultCategories: (lang) => provisionDefaultCategoriesIn(ctx, lang),
    getAllIncomeCategories: () => getAllIncomeCategoriesIn(ctx),
    addIncomeCategory: (input) => addIncomeCategoryIn(ctx, input),
    updateIncomeCategory: (input) => updateIncomeCategoryIn(ctx, input),
    deleteIncomeCategory: (id) => deleteIncomeCategoryIn(ctx, id),
    ensureIncomeCategories: (lang) => ensureIncomeCategoriesIn(ctx, lang),
    getAllIncome: () => getAllIncomeIn(ctx),
    addIncome: (input) => addIncomeIn(ctx, input),
    deleteIncome: (id) => deleteIncomeIn(ctx, id),
    getAllBudgets: () => getAllBudgetsIn(ctx),
    upsertBudget: (input) => upsertBudgetIn(ctx, input),
    deleteBudget: (id) => deleteBudgetIn(ctx, id),
    readEntriesForConversion: () => readEntriesForConversionIn(ctx),
    applyEntryConversions: (key, main, updates) =>
      applyEntryConversionsIn(ctx, key, main, updates),
    convertBudgets: (target, rateFor, options) =>
      convertBudgetsIn(ctx, target, rateFor, options),
    getAllRecurring: () => getAllRecurringIn(ctx),
    getDueRecurring: (today) => getDueRecurringIn(ctx, today),
    processDueRecurring: (today) => processDueRecurringIn(ctx, today),
    addRecurring: (input, options) => addRecurringIn(ctx, input, options),
    updateRecurring: (id, patch) => updateRecurringIn(ctx, id, patch),
    setRecurringPaused: (id, paused, today) => setRecurringPausedIn(ctx, id, paused, today),
    deleteRecurring: (id) => deleteRecurringIn(ctx, id),
    confirmRecurringOccurrence: (itemId, date, overrides) =>
      confirmRecurringOccurrenceIn(ctx, itemId, date, overrides),
    skipRecurringOccurrence: (itemId, date) => skipRecurringOccurrenceIn(ctx, itemId, date),
    addRepeatingExpense: (input, unit) => addRepeatingExpenseIn(ctx, input, unit),
    addRepeatingIncome: (input, unit) => addRepeatingIncomeIn(ctx, input, unit),
    listChangedRecords: (sinceRev) => listChangedRecordsIn(ctx, sinceRev),
    applyIncomingRecords: (records, options) => applyIncomingRecordsIn(ctx, records, options),
    compactTombstones: (olderThan, options) => compactTombstonesIn(ctx, olderThan, options),
    dedupeOccurrences: (ids) => dedupeOccurrencesIn(ctx, ids),
  }
}

const handles = new Map<string, SpaceDb>()

// The data handle of a space: the same object for the same id every time.
// spaceDb('personal') behaves exactly like the top-level functions. A bad
// Family id throws TypeError.
export function spaceDb(spaceId: SpaceId): SpaceDb {
  let handle = handles.get(spaceId)
  if (!handle) {
    handle = buildSpaceDb(ctxFor(spaceId))
    handles.set(spaceId, handle)
  }
  return handle
}
