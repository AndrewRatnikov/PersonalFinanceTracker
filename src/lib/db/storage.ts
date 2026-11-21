// Layer 1 of src/lib/db: encrypted writes (writeKeysMany), the local and
// Family change listeners and the expense chunk helpers.

import { get, keys, setMany } from 'idb-keyval'

import { DecryptError } from '../dataErrors'
import { isSpaceReadOnly } from '../spaces/keyring'
import { SpaceReadOnlyError } from '../spaces/types'
import {
  cryptoFor,
  personalLocked,
  storageKeyOf,
  store,
  withUpdatedBy,
} from './context'
import type { Expense } from '../domain'
import type { SpaceCtx } from './context'
import type { RevCounter } from './revs'

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

// Encrypts every value (base keys of the space: single keys or expense chunks)
// with the space's crypto and writes them all in ONE IndexedDB transaction
// (idb-keyval setMany), together with any plaintext entries (full keys) and,
// when the counter advanced, the space's `meta:sync`. If the transaction fails
// nothing is written. Family records stamped with this write's revs get
// updatedBy. Only personal user writes notify the sync engine.
export async function writeKeysMany(
  ctx: SpaceCtx,
  values: object,
  counter?: RevCounter,
  plain: Array<[string, unknown]> = [],
): Promise<void> {
  const c = await cryptoFor(ctx.spaceId)
  if (!store) return
  // A Family user write into a read-only copy (removed, left, deleted space).
  if (!ctx.personal && counter && isSpaceReadOnly(ctx.spaceId)) {
    throw new SpaceReadOnlyError(ctx.spaceId)
  }
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
  if (counter?.changed && !ctx.personal) notifySpaceLocalChange(ctx.spaceId)
}

// ── Family local change hook (the Family stream's trigger) ────────────────────

const spaceChangeListeners = new Set<(spaceId: string) => void>()

// Called with the space id after every committed Family user write. Personal
// writes never call it (they call the onLocalChange listeners only).
export function onSpaceLocalChange(listener: (spaceId: string) => void): () => void {
  spaceChangeListeners.add(listener)
  return () => {
    spaceChangeListeners.delete(listener)
  }
}

export function notifySpaceLocalChange(spaceId: string): void {
  for (const listener of Array.from(spaceChangeListeners)) {
    try {
      listener(spaceId)
    } catch (err) {
      console.error(
        'Space change listener failed:',
        err instanceof Error ? err.name : typeof err,
      )
    }
  }
}

// ── Expense chunk helpers ─────────────────────────────────────────────────────

export const EXPENSE_CHUNK_KEY_RE = /^expenses_\d{4}_\d{2}$/

export function expenseChunkKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime()))
    throw new Error(`expenseChunkKey: invalid date string "${dateStr}"`)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `expenses_${y}_${m}`
}

export function chunkKeysBetween(from: string, to: string): Array<string> {
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
export async function readChunk(ctx: SpaceCtx, chunkKey: string): Promise<Array<Expense>> {
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
export async function allExpenseChunkKeys(ctx: SpaceCtx): Promise<Array<string>> {
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
