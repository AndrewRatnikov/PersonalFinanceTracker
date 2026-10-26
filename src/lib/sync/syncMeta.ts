// The plaintext `meta:sync` record (docs/free-tier-spec.md §19):
// `{ localRev, enabled, userId, vaultId, deviceId, pushedRev, pullCursor,
// headerRev, lastSyncAt, lastError, headerPending? }`. localDb owns `localRev`
// (every user write bumps it and keeps the other fields); only the sync engine
// and the sync actions write the other fields, through this module, under the
// same write lock as localDb. A missing or ill-typed field means "sync off".
// Works before unlock; does nothing at import time.

import { get, set } from 'idb-keyval'

import type { SyncFields, SyncLastError, SyncMeta } from './types'
import { SYNC_META_KEY, getLocalStore } from '@/lib/localDb'
import { withWriteLock } from '@/lib/writeLock'

export const SYNC_FIELD_NAMES: ReadonlyArray<keyof SyncFields> = [
  'enabled',
  'userId',
  'vaultId',
  'deviceId',
  'pushedRev',
  'pullCursor',
  'headerRev',
  'lastSyncAt',
  'lastError',
  'headerPending',
]

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

// Same rule as localDb: a non-negative integer, else 0.
function parseLocalRev(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0
}

function parseLastError(value: unknown): SyncLastError | null | undefined {
  if (value === null) return null
  const obj = asObject(value)
  if (!obj) return undefined
  if (typeof obj.code !== 'string' || typeof obj.at !== 'string') return undefined
  const result: SyncLastError = { code: obj.code, at: obj.at }
  if (obj.count !== undefined) {
    if (typeof obj.count !== 'number' || !Number.isFinite(obj.count)) return undefined
    result.count = obj.count
  }
  return result
}

// The parsed record: junk gives { localRev: 0 }; only well-typed known fields
// are kept.
export function parseSyncMeta(raw: unknown): SyncMeta {
  const obj = asObject(raw)
  if (!obj) return { localRev: 0 }
  const meta: SyncMeta = { localRev: parseLocalRev(obj.localRev) }
  if (typeof obj.enabled === 'boolean') meta.enabled = obj.enabled
  for (const key of ['userId', 'vaultId', 'deviceId'] as const) {
    const value = obj[key]
    if (typeof value === 'string') meta[key] = value
  }
  for (const key of ['pushedRev', 'pullCursor', 'headerRev'] as const) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isInteger(value)) meta[key] = value
  }
  if (obj.lastSyncAt === null || typeof obj.lastSyncAt === 'string') {
    meta.lastSyncAt = obj.lastSyncAt
  }
  const lastError = parseLastError(obj.lastError)
  if (lastError !== undefined) meta.lastError = lastError
  if (typeof obj.headerPending === 'boolean') meta.headerPending = obj.headerPending
  return meta
}

// Sync is on only with every identifying field present.
export function isSyncOn(meta: SyncMeta): meta is SyncMeta & SyncFields {
  return (
    meta.enabled === true &&
    typeof meta.userId === 'string' &&
    meta.userId !== '' &&
    typeof meta.vaultId === 'string' &&
    meta.vaultId !== '' &&
    typeof meta.deviceId === 'string' &&
    meta.deviceId !== '' &&
    typeof meta.pushedRev === 'number' &&
    typeof meta.pullCursor === 'number' &&
    typeof meta.headerRev === 'number'
  )
}

export async function readSyncMeta(): Promise<SyncMeta> {
  const store = getLocalStore()
  if (!store) return { localRev: 0 }
  return parseSyncMeta(await get<unknown>(SYNC_META_KEY, store))
}

function requireStore() {
  const store = getLocalStore()
  if (!store) throw new Error('Local storage is not available')
  return store
}

// Merges the patch into the stored record. The stored localRev is never
// changed here (only user writes advance it). An undefined value removes the
// field.
export async function updateSyncMeta(
  patch: Partial<SyncFields>,
): Promise<SyncMeta> {
  const store = requireStore()
  return withWriteLock(SYNC_META_KEY, async () => {
    const raw = asObject(await get<unknown>(SYNC_META_KEY, store)) ?? {}
    const next: Record<string, unknown> = { ...raw }
    for (const key of SYNC_FIELD_NAMES) {
      if (!Object.hasOwn(patch, key)) continue
      const value = patch[key]
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    next.localRev = parseLocalRev(raw.localRev)
    await set(SYNC_META_KEY, next, store)
    return parseSyncMeta(next)
  })
}

// Removes every sync field and keeps localRev: the record is { localRev } again.
export async function clearSyncFields(): Promise<SyncMeta> {
  const store = requireStore()
  return withWriteLock(SYNC_META_KEY, async () => {
    const raw = asObject(await get<unknown>(SYNC_META_KEY, store)) ?? {}
    const next = { localRev: parseLocalRev(raw.localRev) }
    await set(SYNC_META_KEY, next, store)
    return { ...next }
  })
}
