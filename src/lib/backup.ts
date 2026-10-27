// Encrypted, lossless `.minima` backups (spec §7).
//
// createBackup reads the raw encrypted store directly (so a partial backup can
// skip unreadable keys), encrypts JSON(BackupPayload), gzipped when the
// browser has CompressionStream, with the vault DEK, and carries a snapshot of
// the vault header. The backup therefore opens with the password that was
// current when it was made, or the recovery key.
//
// restoreBackup validates the file, unwraps the backup's DEK with the given
// secret and decrypts the payload before anything is written. It then writes
// the result in ONE setMany transaction: re-encrypted data keys, quarantine
// copies of unreadable local blobs (replace), the adopted header (fresh or
// orphaned device) and `meta:settings`.
//
// An orphaned device (data keys but no header, so nothing can be opened) is
// restored like a fresh device: the backup's header is adopted, the mode is
// forced to replace and the backup's DEK is unlocked after the commit. Every
// existing data value is first copied, unchanged, to
// `quarantine:<key>:<ISO timestamp>` in the same transaction; orphaned data is
// never deleted.
//
// The payload carries `incomeCategories` and `recurring` (both additive;
// schemaVersion stays 1). A restore never generates recurring records itself:
// the next processDueRecurring run does, and its idempotency check
// (recurringId + occurrenceDate) prevents duplicates.
// A payload from before income categories (no `incomeCategories`, or income
// records with only a free-text `source`) is converted with
// convertIncomeSources before planning, so old backups restore into
// categories.
//
// Sync groundwork: tombstones (`deletedAt`) travel in the payload, the local
// `rev` never does. Merge decides per record with syncRecords.mergeRecord and
// its same-time tie-break, so a newer tombstone in a backup deletes on merge.
// Replace keeps local-only live records as fresh tombstones. Every record a
// restore writes gets a fresh rev, committed with `meta:sync` in the one
// setMany. The currency settings live in the encrypted `syncedSettings`
// record: createBackup reads them from it, replace writes it, merge leaves it.

import dayjs from 'dayjs'
import { get, keys, setMany } from 'idb-keyval'
import { t as translateMessage } from '../i18n/core'

import { getAppSettings } from './appSettings'
import { getBackupSettings, recordBackupCompleted } from './backupReminder'
import {
  base64ToBytes,
  bytesToBase64,
  decryptValue,
  encryptValue,
} from './crypto'
import { DecryptError, isDataStorageKey } from './dataErrors'
import { isCurrency } from './domain'
import { saveFile } from './fileDownload'
import { convertIncomeSources } from './incomeCategories'
import {
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  ensureIncomeCategories,
  expenseChunkKey,
  getLocalDbKey,
  getLocalRev,
  getLocalStore,
  notifyLocalChange,
  readSyncedSettings,
  requestEntryConversion,
  syncMetaEntry,
  unlockLocalDb,
} from './localDb'
import { postChanged } from './syncChannel'
import { isLive, mergeRecord, sameTimeWinner } from './syncRecords'
import {
  META_SETTINGS_KEY,
  META_VAULT_KEY,
  VaultError,
  getVaultHeader,
  getVaultState,
  openHeaderWithSecret,
} from './vault'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type { SaveResult } from './fileDownload'
import type {
  BudgetEntry,
  Category,
  Currency,
  Expense,
  IncomeEntry,
  RecurringItem,
  SyncedSettingsRecord,
} from './domain'
import type { VaultHeaderV2 } from './vault'

export const BACKUP_FORMAT = 'minima-backup'
export const BACKUP_VERSION = 1
// package.json has no version field, so the app version is a constant.
export const APP_VERSION = '1.0.0'

export type BackupPayloadEncoding = 'gzip+aes-gcm' | 'aes-gcm'

export interface BackupPayload {
  schemaVersion: 1
  categories: Array<Category>
  expenses: Array<Expense> // raw stored records (no joined `category` field)
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  // Optional so backups made before income categories still validate.
  incomeCategories?: Array<Category>
  // Optional so backups made before recurring items still validate.
  recurring?: Array<RecurringItem>
  // Records keep their raw `conversion` / `manualRate` and `deletedAt`, never
  // the local `rev`. The currency settings are optional so backups made
  // before the main currency still validate (and are left out when the
  // settings record was unreadable in a partial backup).
  settings: {
    autoLockMinutes: number
    backupReminderDays: number
    mainCurrency?: Currency
    fetchExchangeRates?: boolean
  }
}

export interface MinimaBackupV1 {
  format: 'minima-backup'
  version: 1
  createdAt: string
  appVersion: string
  vault: Pick<
    VaultHeaderV2,
    'vaultId' | 'kdf' | 'wrappedByPassword' | 'recovery' | 'verifier'
  >
  payload: { enc: BackupPayloadEncoding; iv: string; ct: string } // base64
  skipped?: Array<string>
}

export type RestoreMode = 'replace' | 'merge'

export interface RestoreSummary {
  mode: RestoreMode
  // Records written per collection.
  expenses: number
  income: number
  categories: number
  incomeCategories: number
  budgets: number
  added: number
  updated: number
  conflicts: number
  skipped: Array<string> // the backup file's own `skipped` list
  adoptedVault: boolean // true on a fresh or orphaned device
}

export type BackupErrorCode =
  | 'invalid-file'
  | 'unsupported-version'
  | 'wrong-secret'
  | 'damaged'
  | 'invalid-state'

export class BackupError extends Error {
  readonly code: BackupErrorCode
  // Tells "this browser can't decompress" apart from a plain invalid file
  // (the UI words them differently); the code stays 'invalid-file'.
  readonly reason?: 'compression'

  constructor(code: BackupErrorCode, message: string, reason?: 'compression') {
    super(message)
    this.name = 'BackupError'
    this.code = code
    if (reason !== undefined) this.reason = reason
  }
}

export interface DownloadBackupResult {
  status: SaveResult
  filename: string
  skipped: Array<string>
}

const IV_BYTES = 12
const EXPENSE_CHUNK_PREFIX = 'expenses_'

function notABackup(): BackupError {
  return new BackupError('invalid-file', "This file isn't a MinimaSpend backup")
}

function damagedBackup(): BackupError {
  return new BackupError('damaged', 'This backup file is damaged')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function stripCategory(e: Expense): Expense {
  if (!('category' in e)) return e
  const copy = { ...e }
  delete copy.category
  return copy
}

// A copy without the local `rev` (local bookkeeping never leaves the device).
function stripRev<T extends object>(record: T): T {
  if (!('rev' in record)) return record
  const copy: Record<string, unknown> = { ...record }
  delete copy.rev
  return copy as T
}

function stripRevs<T extends object>(list: Array<T>): Array<T> {
  return list.map(stripRev)
}

async function dataKeysOf(store: UseStore): Promise<Array<string>> {
  return (await keys(store))
    .filter((k): k is string => typeof k === 'string' && isDataStorageKey(k))
    .sort()
}

// ── Gzip ──────────────────────────────────────────────────────────────────────

async function pipeBytes(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = new Response(bytes).body
  if (!body) throw new Error('Could not read the backup payload')
  const piped = body.pipeThrough(transform)
  return new Uint8Array(await new Response(piped).arrayBuffer())
}

function canCompress(): boolean {
  return typeof CompressionStream === 'function'
}

function canDecompress(): boolean {
  return typeof DecompressionStream === 'function'
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createBackup(
  options: { allowPartial?: boolean } = {},
): Promise<MinimaBackupV1> {
  const store = getLocalStore()
  const dek = getLocalDbKey()
  if (!store || !dek) {
    throw new BackupError('invalid-state', 'Unlock the app to make a backup')
  }
  const header = await getVaultHeader()

  const skipped: Array<string> = []
  let categories: Array<Category> = []
  let incomeCategories: Array<Category> = []
  let income: Array<IncomeEntry> = []
  let budgets: Array<BudgetEntry> = []
  let recurring: Array<RecurringItem> = []
  const expenses: Array<Expense> = []

  for (const key of await dataKeysOf(store)) {
    const raw = await get<unknown>(key, store)
    if (!(raw instanceof Uint8Array)) continue
    let value: unknown
    try {
      value = await decryptValue(dek, raw)
    } catch (err) {
      if (!options.allowPartial) throw new DecryptError(key, err)
      skipped.push(key)
      continue
    }
    // `syncedSettings` is a single record, read through readSyncedSettings.
    if (key === SYNCED_SETTINGS_KEY || !Array.isArray(value)) continue
    if (key === 'categories') categories = stripRevs(value as Array<Category>)
    else if (key === 'incomeCategories') {
      incomeCategories = stripRevs(value as Array<Category>)
    } else if (key === 'income') income = stripRevs(value as Array<IncomeEntry>)
    else if (key === 'budgets') budgets = stripRevs(value as Array<BudgetEntry>)
    else if (key === 'recurring') {
      recurring = stripRevs(value as Array<RecurringItem>)
    } else {
      for (const e of value as Array<Expense>) {
        expenses.push(stripRev(stripCategory(e)))
      }
    }
  }

  // The record when readable, else the legacy fields or the defaults. Left
  // out when the record was skipped as unreadable.
  let currency: Pick<SyncedSettingsRecord, 'mainCurrency' | 'fetchExchangeRates'> | null =
    null
  if (!skipped.includes(SYNCED_SETTINGS_KEY)) {
    const record = await readSyncedSettings()
    currency = {
      mainCurrency: record.mainCurrency,
      fetchExchangeRates: record.fetchExchangeRates,
    }
  }

  const payload: BackupPayload = {
    schemaVersion: 1,
    categories,
    expenses,
    income,
    budgets,
    incomeCategories,
    recurring,
    settings: {
      autoLockMinutes: (await getAppSettings()).autoLockMinutes,
      backupReminderDays: (await getBackupSettings()).backupReminderDays,
      ...(currency ?? {}),
    },
  }

  let bytes = new TextEncoder().encode(JSON.stringify(payload))
  let enc: BackupPayloadEncoding = 'aes-gcm'
  if (canCompress()) {
    bytes = await pipeBytes(bytes, new CompressionStream('gzip'))
    enc = 'gzip+aes-gcm'
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes),
  )

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    vault: {
      vaultId: header.vaultId,
      kdf: header.kdf,
      wrappedByPassword: header.wrappedByPassword,
      recovery: header.recovery,
      verifier: header.verifier,
    },
    payload: { enc, iv: bytesToBase64(iv), ct: bytesToBase64(ct) },
    ...(skipped.length > 0 ? { skipped } : {}),
  }
}

export function serializeBackup(b: MinimaBackupV1): string {
  return JSON.stringify(b)
}

// ── Parse ─────────────────────────────────────────────────────────────────────

function isBox(value: unknown): value is { iv: string; ct: string } {
  return isObject(value) && isString(value.iv) && isString(value.ct)
}

function isBackupVault(value: unknown): value is MinimaBackupV1['vault'] {
  if (!isObject(value)) return false
  const { kdf, recovery } = value
  return (
    isString(value.vaultId) &&
    isObject(kdf) &&
    isString(kdf.salt) &&
    typeof kdf.iterations === 'number' &&
    isBox(value.wrappedByPassword) &&
    isObject(recovery) &&
    isBox(recovery) &&
    isString((recovery as Record<string, unknown>).salt) &&
    isBox(value.verifier)
  )
}

export function parseBackupFile(text: string): MinimaBackupV1 {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw notABackup()
  }
  if (!isObject(data) || data.format !== BACKUP_FORMAT) throw notABackup()
  if (data.version !== BACKUP_VERSION) {
    throw new BackupError(
      'unsupported-version',
      'This backup was made by a newer version of MinimaSpend',
    )
  }
  if (!isBackupVault(data.vault)) throw notABackup()
  const payload = data.payload
  if (!isObject(payload) || !isBox(payload)) throw notABackup()
  const enc = (payload as Record<string, unknown>).enc ?? 'aes-gcm'
  if (enc !== 'aes-gcm' && enc !== 'gzip+aes-gcm') throw notABackup()
  if (
    data.skipped !== undefined &&
    !(Array.isArray(data.skipped) && data.skipped.every(isString))
  ) {
    throw notABackup()
  }
  return {
    ...(data as unknown as MinimaBackupV1),
    payload: { ...payload, enc } as MinimaBackupV1['payload'],
  }
}

export function backupFileName(now = new Date()): string {
  return `minima-backup-${dayjs(now).format('YYYY-MM-DD')}.minima`
}

// ── Restore ───────────────────────────────────────────────────────────────────

// 'replace' when this device holds no live expenses, income, budgets or
// recurring items (default expense and income categories, the synced settings
// and tombstones don't count), otherwise 'merge'.
export async function defaultRestoreMode(): Promise<RestoreMode> {
  const store = getLocalStore()
  const dek = getLocalDbKey()
  if (!store || !dek) return 'replace'
  for (const key of await dataKeysOf(store)) {
    if (
      key === 'categories' ||
      key === 'incomeCategories' ||
      key === SYNCED_SETTINGS_KEY
    ) {
      continue
    }
    const raw = await get<unknown>(key, store)
    if (!(raw instanceof Uint8Array)) continue
    try {
      const value = await decryptValue(dek, raw)
      if (
        Array.isArray(value) &&
        value.some((r) => isObject(r) && isLive(r as { deletedAt?: string }))
      ) {
        return 'merge'
      }
    } catch {
      // Unreadable data is still data: don't offer to replace it by default.
      return 'merge'
    }
  }
  return 'replace'
}

function isRecordList(value: unknown): value is Array<{ id: string }> {
  return (
    Array.isArray(value) &&
    value.every((r) => isObject(r) && isString(r.id))
  )
}

function validatePayload(value: unknown): BackupPayload {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !isRecordList(value.categories) ||
    !isRecordList(value.expenses) ||
    !isRecordList(value.income) ||
    !isRecordList(value.budgets) ||
    (value.incomeCategories !== undefined &&
      !isRecordList(value.incomeCategories)) ||
    (value.recurring !== undefined && !isRecordList(value.recurring))
  ) {
    throw notABackup()
  }
  for (const e of value.expenses as Array<Record<string, unknown>>) {
    if (!isString(e.createdAt) || Number.isNaN(Date.parse(e.createdAt))) {
      throw notABackup()
    }
  }
  const settings = isObject(value.settings) ? value.settings : {}
  // A `rev` inside a file is dropped: revs are local bookkeeping.
  return {
    schemaVersion: 1,
    categories: stripRevs(value.categories as Array<Category>),
    expenses: (value.expenses as Array<Expense>).map((e) =>
      stripRev(stripCategory(e)),
    ),
    income: stripRevs(value.income as Array<IncomeEntry>),
    budgets: stripRevs(value.budgets as Array<BudgetEntry>),
    ...(value.incomeCategories !== undefined
      ? {
          incomeCategories: stripRevs(
            value.incomeCategories as Array<Category>,
          ),
        }
      : {}),
    ...(value.recurring !== undefined
      ? { recurring: stripRevs(value.recurring as Array<RecurringItem>) }
      : {}),
    settings: settings as BackupPayload['settings'],
  }
}

async function decryptPayload(
  dek: CryptoKey,
  payload: MinimaBackupV1['payload'],
): Promise<BackupPayload> {
  const gzipped = payload.enc === 'gzip+aes-gcm'
  if (gzipped && !canDecompress()) {
    throw new BackupError(
      'invalid-file',
      'This browser cannot open compressed backups',
      'compression',
    )
  }
  let parsed: unknown
  try {
    let bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
        dek,
        base64ToBytes(payload.ct),
      ),
    )
    if (gzipped) bytes = await pipeBytes(bytes, new DecompressionStream('gzip'))
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw damagedBackup()
  }
  return validatePayload(parsed)
}

async function openBackup(
  backup: MinimaBackupV1,
  secret: string,
): Promise<{ dek: CryptoKey; payload: BackupPayload }> {
  let dek: CryptoKey | null
  try {
    dek = await openHeaderWithSecret(backup.vault, secret)
  } catch (err) {
    if (err instanceof VaultError && err.code === 'damaged') {
      throw damagedBackup()
    }
    throw err
  }
  if (!dek) {
    throw new BackupError(
      'wrong-secret',
      "This password or recovery key doesn't open this backup",
    )
  }
  return { dek, payload: await decryptPayload(dek, backup.payload) }
}

interface MergeRecord {
  id: string
  updatedAt?: string
  createdAt?: string
  deletedAt?: string
}

interface Counters {
  added: number
  updated: number
  conflicts: number
}

// Hands out fresh revs for the records a restore writes; committed as
// `meta:sync` in the same setMany.
interface RevSource {
  next: () => number
}

function stamped<T extends object>(record: T, revs: RevSource): T {
  return { ...record, rev: revs.next() }
}

// The merge decision for one record: whether the backup's record is written,
// and how it counts. A same-time conflict is always counted; the backup's
// record is written when it wins the tie-break.
function mergeOutcome(
  local: MergeRecord | undefined,
  incoming: MergeRecord,
  counters: Counters,
): boolean {
  const decision = mergeRecord(local, incoming)
  if (decision === 'take-incoming') {
    if (local) counters.updated++
    else counters.added++
    return true
  }
  if (decision === 'conflict-same-time' && local) {
    counters.conflicts++
    return sameTimeWinner(local, incoming) === 'incoming'
  }
  return false
}

// Upserts a single-key collection by id. Returns the merged list and how many
// records were written, or null when nothing changed.
function mergeList(
  local: Array<MergeRecord>,
  incoming: Array<MergeRecord>,
  counters: Counters,
  revs: RevSource,
): { records: Array<MergeRecord>; written: number } | null {
  const result = [...local]
  const index = new Map(result.map((r, i) => [r.id, i]))
  let written = 0
  for (const record of incoming) {
    const i = index.get(record.id)
    const current = i === undefined ? undefined : result[i]
    if (!mergeOutcome(current, record, counters)) continue
    const next = stamped(record, revs)
    if (i === undefined) {
      index.set(record.id, result.length)
      result.push(next)
    } else {
      result[i] = next
    }
    written++
  }
  return written > 0 ? { records: result, written } : null
}

function groupExpenses(expenses: Array<Expense>): Map<string, Array<Expense>> {
  const chunks = new Map<string, Array<Expense>>()
  for (const e of expenses) {
    const key = expenseChunkKey(e.createdAt)
    const list = chunks.get(key)
    if (list) list.push(e)
    else chunks.set(key, [e])
  }
  return chunks
}

interface LocalData {
  // Decrypted list per data key (not the settings record).
  values: Map<string, Array<unknown>>
  // The decrypted synced settings record, when readable.
  settings?: unknown
  // Raw stored values that could not be decrypted (replace only), or every
  // stored value of an orphaned device. Quarantined unchanged.
  unreadable: Map<string, unknown>
}

async function readLocal(
  store: UseStore,
  dek: CryptoKey,
  dataKeys: Array<string>,
  mode: RestoreMode,
): Promise<LocalData> {
  const values = new Map<string, Array<unknown>>()
  const unreadable = new Map<string, unknown>()
  let settings: unknown
  for (const key of dataKeys) {
    const raw = await get<unknown>(key, store)
    if (!(raw instanceof Uint8Array)) continue
    try {
      const value = await decryptValue(dek, raw)
      if (key === SYNCED_SETTINGS_KEY) settings = value
      else values.set(key, Array.isArray(value) ? value : [])
    } catch (err) {
      if (mode === 'merge') throw new DecryptError(key, err)
      unreadable.set(key, raw)
    }
  }
  return { values, settings, unreadable }
}

// An orphaned device has no key that could open its data: every stored value
// under a data key goes to quarantine as it is.
async function readOrphaned(
  store: UseStore,
  dataKeys: Array<string>,
): Promise<LocalData> {
  const unreadable = new Map<string, unknown>()
  for (const key of dataKeys) {
    const raw = await get<unknown>(key, store)
    if (raw !== undefined) unreadable.set(key, raw)
  }
  return { values: new Map(), unreadable }
}

function localIds(local: LocalData, key: string): Set<string> {
  return new Set(
    (local.values.get(key) ?? []).map((r) => (r as { id: string }).id),
  )
}

function localExpenseIds(local: LocalData): Set<string> {
  const ids = new Set<string>()
  for (const [key, list] of local.values) {
    if (!key.startsWith(EXPENSE_CHUNK_PREFIX)) continue
    for (const r of list) ids.add((r as { id: string }).id)
  }
  return ids
}

// The payload after the legacy income conversion: always has a list.
type PreparedPayload = BackupPayload & { incomeCategories: Array<Category> }

// Converts legacy income (no incomeCategories in the payload, or records with
// only a free-text source) into income categories. The backup records keep
// their own updatedAt, so merging the same legacy backup again is a no-op
// and never overwrites a newer local edit. In a merge the live local income
// categories are reused by name. Defaults are added only when a payload
// without incomeCategories replaces the data.
function prepareIncome(
  payload: BackupPayload,
  local: LocalData,
  mode: RestoreMode,
): PreparedPayload {
  const needsConversion =
    payload.incomeCategories === undefined ||
    payload.income.some(
      (i) => typeof i.categoryId !== 'string' || i.categoryId === '',
    )
  if (!needsConversion) {
    return { ...payload, incomeCategories: payload.incomeCategories ?? [] }
  }
  const base: Array<Category> = [...(payload.incomeCategories ?? [])]
  if (mode === 'merge') {
    const ids = new Set(base.map((c) => c.id))
    for (const c of (local.values.get('incomeCategories') ??
      []) as Array<Category>) {
      if (!ids.has(c.id) && isLive(c)) base.push(stripRev(c))
    }
  }
  const converted = convertIncomeSources(payload.income, base, {
    preserveUpdatedAt: true,
    addDefaults: mode === 'replace' && payload.incomeCategories === undefined,
  })
  return {
    ...payload,
    incomeCategories: converted.incomeCategories,
    income: converted.income,
  }
}

interface Plan {
  writes: Map<string, Array<unknown>>
  counts: Pick<
    RestoreSummary,
    'expenses' | 'income' | 'categories' | 'incomeCategories' | 'budgets'
  >
  counters: Counters
}

type SingleCollection =
  | 'categories'
  | 'incomeCategories'
  | 'income'
  | 'budgets'
  | 'recurring'

function planReplace(
  local: LocalData,
  payload: PreparedPayload,
  revs: RevSource,
  now: string,
): Plan {
  const writes = new Map<string, Array<unknown>>()
  const recurring = payload.recurring ?? []
  const singles: Array<[SingleCollection, Array<MergeRecord>]> = [
    ['categories', payload.categories],
    ['incomeCategories', payload.incomeCategories],
    ['income', payload.income],
    ['budgets', payload.budgets],
    ['recurring', recurring],
  ]
  // Every backup record is written with a fresh rev and its own times.
  for (const [key, list] of singles) {
    writes.set(
      key,
      list.map((r) => stamped(r, revs)),
    )
  }
  for (const [key, list] of groupExpenses(payload.expenses)) {
    writes.set(
      key,
      list.map((r) => stamped(r, revs)),
    )
  }

  // A live local record the backup doesn't have stays as a fresh tombstone
  // (so a later sync can't bring it back); a local tombstone stays as it is.
  const keepLocal = (record: MergeRecord): MergeRecord =>
    isLive(record)
      ? stamped({ ...record, deletedAt: now, updatedAt: now }, revs)
      : record
  for (const [key, incoming] of singles) {
    const ids = new Set(incoming.map((r) => r.id))
    const list = writes.get(key) ?? []
    for (const r of (local.values.get(key) ?? []) as Array<MergeRecord>) {
      if (!ids.has(r.id)) list.push(keepLocal(r))
    }
    writes.set(key, list)
  }
  const backupExpenseIds = new Set(payload.expenses.map((e) => e.id))
  for (const [key, list] of local.values) {
    if (!key.startsWith(EXPENSE_CHUNK_PREFIX)) continue
    for (const r of list as Array<Expense>) {
      if (backupExpenseIds.has(r.id)) continue
      const chunk = expenseChunkKey(r.createdAt)
      const target = writes.get(chunk) ?? []
      target.push(keepLocal(r))
      writes.set(chunk, target)
    }
  }
  // Keys the backup doesn't cover and nothing was kept in become an
  // encrypted empty list, so the restore stays one setMany with no deletes.
  for (const key of [...local.values.keys(), ...local.unreadable.keys()]) {
    if (key === SYNCED_SETTINGS_KEY) continue
    if (!writes.has(key)) writes.set(key, [])
  }

  const counters: Counters = { added: 0, updated: 0, conflicts: 0 }
  const count = (ids: Set<string>, records: Array<{ id: string }>) => {
    for (const r of records) {
      if (ids.has(r.id)) counters.updated++
      else counters.added++
    }
  }
  count(localIds(local, 'categories'), payload.categories)
  count(localIds(local, 'incomeCategories'), payload.incomeCategories)
  count(localIds(local, 'income'), payload.income)
  count(localIds(local, 'budgets'), payload.budgets)
  count(localIds(local, 'recurring'), recurring)
  count(localExpenseIds(local), payload.expenses)

  return {
    writes,
    counts: {
      expenses: payload.expenses.length,
      income: payload.income.length,
      categories: payload.categories.length,
      incomeCategories: payload.incomeCategories.length,
      budgets: payload.budgets.length,
    },
    counters,
  }
}

function planMerge(
  local: LocalData,
  payload: PreparedPayload,
  revs: RevSource,
): Plan {
  const writes = new Map<string, Array<unknown>>()
  const counters: Counters = { added: 0, updated: 0, conflicts: 0 }
  const counts = {
    expenses: 0,
    income: 0,
    categories: 0,
    incomeCategories: 0,
    budgets: 0,
  }

  const single: Array<
    [
      'categories' | 'incomeCategories' | 'income' | 'budgets',
      Array<MergeRecord>,
    ]
  > = [
    ['categories', payload.categories],
    ['incomeCategories', payload.incomeCategories],
    ['income', payload.income],
    ['budgets', payload.budgets],
  ]
  for (const [key, incoming] of single) {
    const merged = mergeList(
      (local.values.get(key) ?? []) as Array<MergeRecord>,
      incoming,
      counters,
      revs,
    )
    if (merged) {
      writes.set(key, merged.records)
      counts[key] = merged.written
    }
  }

  // Recurring items: upsert by id with the same rule. They have no count of
  // their own in RestoreSummary; they show in added / updated / conflicts.
  const mergedRecurring = mergeList(
    (local.values.get('recurring') ?? []) as Array<MergeRecord>,
    payload.recurring ?? [],
    counters,
    revs,
  )
  if (mergedRecurring) writes.set('recurring', mergedRecurring.records)

  // Expenses: upsert by id across month chunks.
  const chunks = new Map<string, Array<Expense>>()
  const where = new Map<string, string>()
  for (const [key, list] of local.values) {
    if (!key.startsWith(EXPENSE_CHUNK_PREFIX)) continue
    chunks.set(key, [...(list as Array<Expense>)])
    for (const e of list as Array<Expense>) where.set(e.id, key)
  }
  const changed = new Set<string>()
  for (const incoming of payload.expenses) {
    const oldKey = where.get(incoming.id)
    const current =
      oldKey === undefined
        ? undefined
        : chunks.get(oldKey)?.find((e) => e.id === incoming.id)
    if (!mergeOutcome(current, incoming, counters)) continue
    counts.expenses++

    if (oldKey !== undefined) {
      chunks.set(
        oldKey,
        (chunks.get(oldKey) ?? []).filter((e) => e.id !== incoming.id),
      )
      changed.add(oldKey)
    }
    const newKey = expenseChunkKey(incoming.createdAt)
    chunks.set(newKey, [...(chunks.get(newKey) ?? []), stamped(incoming, revs)])
    where.set(incoming.id, newKey)
    changed.add(newKey)
  }
  for (const key of changed) writes.set(key, chunks.get(key) ?? [])

  return { writes, counts, counters }
}

// The local currency settings: the readable record, else the legacy
// plaintext fields, else the defaults.
function localCurrency(
  local: LocalData,
  plain: Record<string, unknown>,
): Pick<SyncedSettingsRecord, 'mainCurrency' | 'fetchExchangeRates'> {
  const record = isObject(local.settings) ? local.settings : plain
  return {
    mainCurrency: isCurrency(record.mainCurrency)
      ? record.mainCurrency
      : isCurrency(plain.mainCurrency)
        ? plain.mainCurrency
        : 'UAH',
    fetchExchangeRates:
      typeof record.fetchExchangeRates === 'boolean'
        ? record.fetchExchangeRates
        : typeof plain.fetchExchangeRates === 'boolean'
          ? plain.fetchExchangeRates
          : true,
  }
}

export async function restoreBackup(
  file: Blob | string,
  secret: string,
  mode: RestoreMode,
): Promise<RestoreSummary> {
  // 1. Read and validate.
  const text = typeof file === 'string' ? file : await file.text()
  const backup = parseBackupFile(text)

  // 2. Check the target, then open the backup. Nothing is written before the
  //    payload has decrypted and validated.
  const store = getLocalStore()
  const state = await getVaultState()
  const fresh = state === 'none'
  const orphaned = state === 'orphaned'
  // A fresh or orphaned device adopts the backup's vault.
  const adopt = fresh || orphaned
  const localDek = getLocalDbKey()
  if (!store || (!adopt && (state !== 'v2' || !localDek))) {
    throw new BackupError(
      'invalid-state',
      'Unlock the app before restoring into it',
    )
  }
  const { dek: backupDek, payload } = await openBackup(backup, secret)

  // 3. Target key and mode. A fresh or orphaned device adopts the backup's
  //    vault.
  const targetDek = adopt ? backupDek : localDek
  if (!targetDek) {
    throw new BackupError(
      'invalid-state',
      'Unlock the app before restoring into it',
    )
  }
  const effectiveMode: RestoreMode = adopt ? 'replace' : mode
  const backupKeys = [
    'categories',
    'incomeCategories',
    'income',
    'budgets',
    'recurring',
    SYNCED_SETTINGS_KEY,
    ...groupExpenses(payload.expenses).keys(),
  ]
  const localKeys = fresh ? [] : await dataKeysOf(store)
  const lockKeys = [
    ...new Set([...localKeys, ...backupKeys]),
    META_SETTINGS_KEY,
    SYNC_META_KEY,
    ...(adopt ? [META_VAULT_KEY] : []),
  ]

  const result = await withWriteLock(lockKeys, async () => {
    // 4. Read the local data.
    const local: LocalData = fresh
      ? { values: new Map(), unreadable: new Map() }
      : orphaned
        ? await readOrphaned(store, localKeys)
        : await readLocal(store, targetDek, localKeys, effectiveMode)

    // 5. Convert legacy income, then compute the final collections. Every
    //    record written gets a fresh rev.
    const startRev = await getLocalRev()
    let lastRev = startRev
    const revs: RevSource = { next: () => ++lastRev }
    const now = new Date().toISOString()
    const prepared = prepareIncome(payload, local, effectiveMode)
    const plan =
      effectiveMode === 'replace'
        ? planReplace(local, prepared, revs, now)
        : planMerge(local, prepared, revs)

    const summary: RestoreSummary = {
      mode: effectiveMode,
      ...plan.counts,
      ...plan.counters,
      skipped: backup.skipped ?? [],
      adoptedVault: adopt,
    }
    // A merge that changes nothing (no added, no updated, no tie won by the
    // backup) writes nothing.
    if (effectiveMode === 'merge' && plan.writes.size === 0) {
      return { summary, written: [] as Array<string>, stamped: false }
    }

    // 6. Write once.
    const storedRaw = await get<unknown>(META_SETTINGS_KEY, store)
    const plain: Record<string, unknown> = isObject(storedRaw) ? storedRaw : {}
    const entries: Array<[string, unknown]> = []
    for (const [key, records] of plan.writes) {
      entries.push([key, await encryptValue(targetDek, records)])
    }
    const written = [...plan.writes.keys()]
    if (effectiveMode === 'replace') {
      for (const [key, raw] of local.unreadable) {
        entries.push([`quarantine:${key}:${now}`, raw])
      }
      // The synced settings: the backup's valid values, else the local ones.
      const current = localCurrency(local, plain)
      const { mainCurrency, fetchExchangeRates } = payload.settings as Record<
        string,
        unknown
      >
      const record: SyncedSettingsRecord = {
        id: 'settings',
        mainCurrency: isCurrency(mainCurrency) ? mainCurrency : current.mainCurrency,
        fetchExchangeRates:
          typeof fetchExchangeRates === 'boolean'
            ? fetchExchangeRates
            : current.fetchExchangeRates,
        updatedAt: now,
        rev: revs.next(),
      }
      entries.push([SYNCED_SETTINGS_KEY, await encryptValue(targetDek, record)])
      written.push(SYNCED_SETTINGS_KEY)
    }
    if (adopt) {
      const header: VaultHeaderV2 = {
        v: 2,
        vaultId: backup.vault.vaultId,
        createdAt: backup.createdAt,
        kdf: backup.vault.kdf,
        wrappedByPassword: backup.vault.wrappedByPassword,
        recovery: backup.vault.recovery,
        verifier: backup.vault.verifier,
      }
      entries.push([META_VAULT_KEY, header])
    }
    const settings: Record<string, unknown> = {
      ...plain,
      lastDataChangeAt: now,
    }
    if (adopt) {
      // The adopted vault's recovery key belongs to the backup; a stale flag
      // from a lost vault must not nag (a missing field means confirmed).
      delete settings.recoveryKeyConfirmed
    }
    if (effectiveMode === 'replace') {
      const { autoLockMinutes, backupReminderDays } =
        payload.settings as Partial<BackupPayload['settings']>
      if (typeof autoLockMinutes === 'number') {
        settings.autoLockMinutes = autoLockMinutes
      }
      if (typeof backupReminderDays === 'number') {
        settings.backupReminderDays = backupReminderDays
      }
      // The currency settings now live in `syncedSettings`.
      delete settings.mainCurrency
      delete settings.fetchExchangeRates
    }
    entries.push([META_SETTINGS_KEY, settings])
    const revAdvanced = lastRev !== startRev
    if (revAdvanced) {
      // The stored sync fields of meta:sync stay; only localRev advances.
      entries.push(await syncMetaEntry(lastRev))
    }

    // One transaction: everything commits or nothing does.
    await setMany(entries, store)
    return { summary, written, stamped: revAdvanced }
  })

  // 7. After commit.
  if (adopt) unlockLocalDb(backupDek)
  // The restored records carry fresh revs: a user write the sync engine pushes.
  if (result.stamped) notifyLocalChange()
  if (result.written.length > 0) {
    postChanged(result.written)
    // Safety net after a replace (a no-op whenever the restore wrote
    // incomeCategories). Runs after the restore lock is released (the lock
    // isn't re-entrant). A merge writes only the records that changed: a
    // device without income categories gets them at the next unlock
    // (prepareUnlockedVault), so the merge stays one transaction.
    if (result.summary.mode === 'replace') await ensureIncomeCategories()
    // Records from the backup may be pending (an older backup, or another
    // main currency): convert them in the background.
    requestEntryConversion()
  }
  return result.summary
}

// "12 expenses, 3 income, … restored (4 updated, 1 conflicts)", in the UI
// language.
export function formatRestoreSummary(s: RestoreSummary): string {
  return translateMessage('backup.restoreSummary', {
    expenses: s.expenses,
    income: s.income,
    categories: s.categories,
    budgets: s.budgets,
    updated: s.updated,
    conflicts: s.conflicts,
  })
}

// ── Download ──────────────────────────────────────────────────────────────────

// Creates a backup and saves it (share sheet where supported). lastBackupAt
// is recorded only after the save has resolved as 'saved'.
export async function downloadBackup(
  options: { partial?: boolean } = {},
): Promise<DownloadBackupResult> {
  // Capture the snapshot time up front: changes made while the save/share
  // sheet is open must still count as newer than this backup.
  const now = new Date()
  const b = await createBackup({ allowPartial: options.partial })
  const blob = new Blob([serializeBackup(b)], {
    type: 'application/octet-stream',
  })
  const filename = backupFileName()
  const status = await saveFile(blob, filename, { share: true })
  if (status === 'saved') await recordBackupCompleted(now)
  return { status, filename, skipped: b.skipped ?? [] }
}
