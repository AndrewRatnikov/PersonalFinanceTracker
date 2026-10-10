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

import dayjs from 'dayjs'
import { get, keys, setMany } from 'idb-keyval'

import { getAppSettings } from './appSettings'
import { getBackupSettings, recordBackupCompleted } from './backupReminder'
import {
  base64ToBytes,
  bytesToBase64,
  decryptValue,
  encryptValue,
} from './crypto'
import { DecryptError, isDataStorageKey } from './dataErrors'
import { saveFile } from './fileDownload'
import {
  expenseChunkKey,
  getLocalDbKey,
  getLocalStore,
  unlockLocalDb,
} from './localDb'
import { postChanged } from './syncChannel'
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
import type { BudgetEntry, Category, Expense, IncomeEntry } from './domain'
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
  settings: { autoLockMinutes: number; backupReminderDays: number }
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

  constructor(code: BackupErrorCode, message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
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
  let income: Array<IncomeEntry> = []
  let budgets: Array<BudgetEntry> = []
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
    if (!Array.isArray(value)) continue
    if (key === 'categories') categories = value as Array<Category>
    else if (key === 'income') income = value as Array<IncomeEntry>
    else if (key === 'budgets') budgets = value as Array<BudgetEntry>
    else {
      for (const e of value as Array<Expense>) expenses.push(stripCategory(e))
    }
  }

  const payload: BackupPayload = {
    schemaVersion: 1,
    categories,
    expenses,
    income,
    budgets,
    settings: {
      autoLockMinutes: (await getAppSettings()).autoLockMinutes,
      backupReminderDays: (await getBackupSettings()).backupReminderDays,
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

// 'replace' when this device holds no expenses, income or budgets (default
// categories don't count), otherwise 'merge'.
export async function defaultRestoreMode(): Promise<RestoreMode> {
  const store = getLocalStore()
  const dek = getLocalDbKey()
  if (!store || !dek) return 'replace'
  for (const key of await dataKeysOf(store)) {
    if (key === 'categories') continue
    const raw = await get<unknown>(key, store)
    if (!(raw instanceof Uint8Array)) continue
    try {
      const value = await decryptValue(dek, raw)
      if (Array.isArray(value) && value.length > 0) return 'merge'
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
    !isRecordList(value.budgets)
  ) {
    throw notABackup()
  }
  for (const e of value.expenses as Array<Record<string, unknown>>) {
    if (!isString(e.createdAt) || Number.isNaN(Date.parse(e.createdAt))) {
      throw notABackup()
    }
  }
  const settings = isObject(value.settings) ? value.settings : {}
  return {
    schemaVersion: 1,
    categories: value.categories as Array<Category>,
    expenses: (value.expenses as Array<Expense>).map(stripCategory),
    income: value.income as Array<IncomeEntry>,
    budgets: value.budgets as Array<BudgetEntry>,
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

function timestampOf(r: { updatedAt?: string; createdAt?: string }): number {
  const t = Date.parse(r.updatedAt ?? r.createdAt ?? '')
  return Number.isNaN(t) ? 0 : t
}

function contentOf(r: object): string {
  if ('category' in r) return JSON.stringify(stripCategory(r as Expense))
  return JSON.stringify(r)
}

type Outcome = 'added' | 'updated' | 'conflict' | 'same'

interface MergeRecord {
  id: string
  updatedAt?: string
  createdAt?: string
}

// The merge rule: the backup record wins only when it is strictly newer.
function compare(
  local: MergeRecord | undefined,
  incoming: MergeRecord,
): Outcome {
  if (!local) return 'added'
  const a = timestampOf(local)
  const b = timestampOf(incoming)
  if (b > a) return 'updated'
  if (b === a && contentOf(local) !== contentOf(incoming)) return 'conflict'
  return 'same'
}

interface Counters {
  added: number
  updated: number
  conflicts: number
}

// Upserts a single-key collection by id. Returns the merged list and how many
// records were written, or null when nothing changed.
function mergeList(
  local: Array<MergeRecord>,
  incoming: Array<MergeRecord>,
  counters: Counters,
): { records: Array<MergeRecord>; written: number } | null {
  const result = [...local]
  const index = new Map(result.map((r, i) => [r.id, i]))
  let written = 0
  for (const record of incoming) {
    const i = index.get(record.id)
    const outcome = compare(i === undefined ? undefined : result[i], record)
    if (outcome === 'added') {
      index.set(record.id, result.length)
      result.push(record)
      counters.added++
      written++
    } else if (outcome === 'updated' && i !== undefined) {
      result[i] = record
      counters.updated++
      written++
    } else if (outcome === 'conflict') {
      counters.conflicts++
    }
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
  // Decrypted value per data key.
  values: Map<string, Array<unknown>>
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
  for (const key of dataKeys) {
    const raw = await get<unknown>(key, store)
    if (!(raw instanceof Uint8Array)) continue
    try {
      const value = await decryptValue(dek, raw)
      values.set(key, Array.isArray(value) ? value : [])
    } catch (err) {
      if (mode === 'merge') throw new DecryptError(key, err)
      unreadable.set(key, raw)
    }
  }
  return { values, unreadable }
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

interface Plan {
  writes: Map<string, Array<unknown>>
  counts: Pick<RestoreSummary, 'expenses' | 'income' | 'categories' | 'budgets'>
  counters: Counters
}

function planReplace(local: LocalData, payload: BackupPayload): Plan {
  const writes = new Map<string, Array<unknown>>()
  writes.set('categories', payload.categories)
  writes.set('income', payload.income)
  writes.set('budgets', payload.budgets)
  for (const [key, list] of groupExpenses(payload.expenses)) {
    writes.set(key, list)
  }
  // Keys the backup doesn't cover become an encrypted empty list, so the
  // restore stays one setMany with no deletes.
  for (const key of [...local.values.keys(), ...local.unreadable.keys()]) {
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
  count(localIds(local, 'income'), payload.income)
  count(localIds(local, 'budgets'), payload.budgets)
  count(localExpenseIds(local), payload.expenses)

  return {
    writes,
    counts: {
      expenses: payload.expenses.length,
      income: payload.income.length,
      categories: payload.categories.length,
      budgets: payload.budgets.length,
    },
    counters,
  }
}

function planMerge(local: LocalData, payload: BackupPayload): Plan {
  const writes = new Map<string, Array<unknown>>()
  const counters: Counters = { added: 0, updated: 0, conflicts: 0 }
  const counts = { expenses: 0, income: 0, categories: 0, budgets: 0 }

  const single: Array<['categories' | 'income' | 'budgets', Array<MergeRecord>]> =
    [
      ['categories', payload.categories],
      ['income', payload.income],
      ['budgets', payload.budgets],
    ]
  for (const [key, incoming] of single) {
    const merged = mergeList(
      (local.values.get(key) ?? []) as Array<MergeRecord>,
      incoming,
      counters,
    )
    if (merged) {
      writes.set(key, merged.records)
      counts[key] = merged.written
    }
  }

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
    const outcome = compare(current, incoming)
    if (outcome !== 'added' && outcome !== 'updated') {
      if (outcome === 'conflict') counters.conflicts++
      continue
    }
    if (outcome === 'added') counters.added++
    else counters.updated++
    counts.expenses++

    if (oldKey !== undefined) {
      chunks.set(
        oldKey,
        (chunks.get(oldKey) ?? []).filter((e) => e.id !== incoming.id),
      )
      changed.add(oldKey)
    }
    const newKey = expenseChunkKey(incoming.createdAt)
    chunks.set(newKey, [...(chunks.get(newKey) ?? []), incoming])
    where.set(incoming.id, newKey)
    changed.add(newKey)
  }
  for (const key of changed) writes.set(key, chunks.get(key) ?? [])

  return { writes, counts, counters }
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
    'income',
    'budgets',
    ...groupExpenses(payload.expenses).keys(),
  ]
  const localKeys = fresh ? [] : await dataKeysOf(store)
  const lockKeys = [
    ...new Set([...localKeys, ...backupKeys]),
    META_SETTINGS_KEY,
    ...(adopt ? [META_VAULT_KEY] : []),
  ]

  const result = await withWriteLock(lockKeys, async () => {
    // 4. Read the local data.
    const local: LocalData = fresh
      ? { values: new Map(), unreadable: new Map() }
      : orphaned
        ? await readOrphaned(store, localKeys)
        : await readLocal(store, targetDek, localKeys, effectiveMode)

    // 5. Compute the final collections.
    const plan =
      effectiveMode === 'replace'
        ? planReplace(local, payload)
        : planMerge(local, payload)

    const summary: RestoreSummary = {
      mode: effectiveMode,
      ...plan.counts,
      ...plan.counters,
      skipped: backup.skipped ?? [],
      adoptedVault: adopt,
    }
    if (
      effectiveMode === 'merge' &&
      plan.counters.added + plan.counters.updated === 0
    ) {
      return { summary, written: [] as Array<string> }
    }

    // 6. Write once.
    const now = new Date().toISOString()
    const entries: Array<[string, unknown]> = []
    for (const [key, records] of plan.writes) {
      entries.push([key, await encryptValue(targetDek, records)])
    }
    if (effectiveMode === 'replace') {
      for (const [key, raw] of local.unreadable) {
        entries.push([`quarantine:${key}:${now}`, raw])
      }
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
    const storedRaw = await get<unknown>(META_SETTINGS_KEY, store)
    const settings: Record<string, unknown> = {
      ...(isObject(storedRaw) ? storedRaw : {}),
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
    }
    entries.push([META_SETTINGS_KEY, settings])

    // One transaction: everything commits or nothing does.
    await setMany(entries, store)
    return { summary, written: [...plan.writes.keys()] }
  })

  // 7. After commit.
  if (adopt) unlockLocalDb(backupDek)
  if (result.written.length > 0) postChanged(result.written)
  return result.summary
}

export function formatRestoreSummary(s: RestoreSummary): string {
  return `${s.expenses} expenses, ${s.income} income, ${s.categories} categories, ${s.budgets} budgets restored (${s.updated} updated, ${s.conflicts} conflicts)`
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
