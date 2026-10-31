// The plaintext `space:<id>:meta:sync` record of a Family space (spec §22):
// `{ localRev, pushedRev?, pullCursor?, keyVersion?, state?, lastSyncAt?,
// lastError?, rotationPendingFrom?, reencryptPending?, notifiedRequests? }`.
// localDb owns `localRev` (every Family user write of the space bumps it and
// keeps the other fields); only the Family stream and the Family actions write
// the other fields, through this module, under the same write lock as the
// space's user writes. Works before unlock; does nothing at import time.

import { get, set } from 'idb-keyval'

import type {
  FamilySyncFields,
  FamilySyncMeta,
  FamilySyncStatus,
  SyncLastError,
} from './types'
import { SYNC_META_KEY, getLocalStore } from '@/lib/localDb'
import { keyFor } from '@/lib/spaces/types'
import { withWriteLock } from '@/lib/writeLock'

export const FAMILY_SYNC_FIELD_NAMES: ReadonlyArray<keyof FamilySyncFields> = [
  'pushedRev',
  'pullCursor',
  'keyVersion',
  'state',
  'lastSyncAt',
  'lastError',
  'rotationPendingFrom',
  'reencryptPending',
  'notifiedRequests',
]

const FAMILY_STATUSES: ReadonlyArray<FamilySyncStatus> = [
  'none',
  'syncing',
  'synced',
  'offline',
  'paused',
  'pending-approval',
  'removed',
  'space-gone',
  'rotation-pending',
  'error',
]

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

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

function isStatus(value: unknown): value is FamilySyncStatus {
  return typeof value === 'string' && (FAMILY_STATUSES as ReadonlyArray<string>).includes(value)
}

// Junk gives { localRev: 0 }; only well-typed known fields are kept.
export function parseFamilyMeta(raw: unknown): FamilySyncMeta {
  const obj = asObject(raw)
  if (!obj) return { localRev: 0 }
  const meta: FamilySyncMeta = { localRev: parseLocalRev(obj.localRev) }
  for (const key of ['pushedRev', 'pullCursor', 'keyVersion', 'rotationPendingFrom'] as const) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isInteger(value)) meta[key] = value
  }
  if (isStatus(obj.state)) meta.state = obj.state
  if (obj.lastSyncAt === null || typeof obj.lastSyncAt === 'string') {
    meta.lastSyncAt = obj.lastSyncAt
  }
  const lastError = parseLastError(obj.lastError)
  if (lastError !== undefined) meta.lastError = lastError
  if (typeof obj.reencryptPending === 'boolean') meta.reencryptPending = obj.reencryptPending
  if (
    Array.isArray(obj.notifiedRequests) &&
    obj.notifiedRequests.every((id) => typeof id === 'string')
  ) {
    meta.notifiedRequests = [...obj.notifiedRequests]
  }
  return meta
}

function metaKeyOf(spaceId: string): string {
  return keyFor(spaceId, SYNC_META_KEY)
}

export async function readFamilyMeta(spaceId: string): Promise<FamilySyncMeta> {
  const store = getLocalStore()
  if (!store) return { localRev: 0 }
  return parseFamilyMeta(await get<unknown>(metaKeyOf(spaceId), store))
}

// Merges the patch into the stored record under the space's meta:sync lock.
// localRev is never changed here; an undefined value removes the field.
export async function updateFamilyMeta(
  spaceId: string,
  patch: Partial<FamilySyncFields>,
): Promise<FamilySyncMeta> {
  const store = getLocalStore()
  if (!store) throw new Error('Local storage is not available')
  const metaKey = metaKeyOf(spaceId)
  return withWriteLock(metaKey, async () => {
    const raw = asObject(await get<unknown>(metaKey, store)) ?? {}
    const next: Record<string, unknown> = { ...raw }
    for (const key of FAMILY_SYNC_FIELD_NAMES) {
      if (!Object.hasOwn(patch, key)) continue
      const value = patch[key]
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    next.localRev = parseLocalRev(raw.localRev)
    await set(metaKey, next, store)
    return parseFamilyMeta(next)
  })
}
