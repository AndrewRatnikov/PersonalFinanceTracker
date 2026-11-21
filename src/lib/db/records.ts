// Layer 1 of src/lib/db: record liveness helpers and soft deletes.

import { isLive } from '../syncRecords'
import { SYNC_META_KEY, readStore, withSpaceLock } from './context'
import { openRevCounter } from './revs'
import { writeKeysMany } from './storage'
import type { SpaceCtx } from './context'

// ── Records: liveness and the local rev ───────────────────────────────────────

export type Revisioned = { rev?: number; deletedAt?: string }

// A copy without the local `rev` (never returned by the public API).
export function withoutRev<T extends { rev?: number }>(record: T): T {
  if (!('rev' in record)) return record
  const copy = { ...record }
  delete copy.rev
  return copy
}

// The live records of a stored list, without `rev`.
export function liveRecords<T extends Revisioned>(list: Array<T>): Array<T> {
  return list.filter(isLive).map(withoutRev)
}

export function nowIso(): string {
  return new Date().toISOString()
}

// updatedAt for an edit of a shared record (spaceKeys entries, spaceInfo,
// member profiles): now, but always after the record's previous updatedAt,
// so an edit made in the same millisecond still wins newest-wins sync.
export function editedAt(previous: string | undefined): string {
  const now = nowIso()
  if (previous === undefined) return now
  const before = Date.parse(previous)
  if (!Number.isFinite(before) || Date.parse(now) > before) return now
  return new Date(before + 1).toISOString()
}

// ── Soft deletes ──────────────────────────────────────────────────────────────

export type SingleListKey =
  | 'categories'
  | 'incomeCategories'
  | 'income'
  | 'budgets'
  | 'recurring'
  | 'spaceKeys'
  | 'memberProfiles'

// Turns the live record `id` of a single key into a tombstone. Returns false
// (nothing written) when there is no live record with that id.
export async function softDeleteIn(ctx: SpaceCtx, key: SingleListKey, id: string): Promise<boolean> {
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
