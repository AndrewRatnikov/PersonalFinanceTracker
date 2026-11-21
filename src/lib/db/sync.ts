// Layer 6 of src/lib/db: the sync API (changed records, tombstone compaction,
// legacy duplicate occurrences).

import { occurrenceRecordId } from '../occurrenceId'
import { postChanged } from '../syncChannel'
import { isLive } from '../syncRecords'
import {
  IDENTITY_KEY,
  SETTINGS_DEFAULT_UPDATED_AT,
  SPACE_INFO_KEY,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  cryptoFor,
  personalLocked,
  readStore,
  store,
  withSpaceLock,
} from './context'
import { nowIso } from './records'
import { getLocalRevIn, openRevCounter } from './revs'
import { allExpenseChunkKeys, readChunk, writeKeysMany } from './storage'
import { afterCommit } from './events'
import { RECURRING_ATTEMPTS } from './recurringOccurrences'
import type { SyncRecord, SyncRecordType } from '../syncRecords'
import type { SpaceCtx } from './context'
import type { Revisioned, SingleListKey } from './records'

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
  /**
   * Called once after the commit with every record that was taken (not the
   * kept ones). A throwing callback is logged and never fails the apply.
   */
  onApplied?: (records: Array<AppliedIncomingRecord>) => void
}

/** A record applyIncomingRecords took; `created` = no local copy existed. */
export interface AppliedIncomingRecord {
  type: SyncRecordType
  id: string
  created: boolean
  deleted: boolean
  createdBy?: string
}

export type StoredRecord = Record<string, unknown> & { id: string }

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
export function keyOfTypeFor(ctx: SpaceCtx): Map<SyncRecordType, string> {
  return new Map<SyncRecordType, string>([...listTypesOf(ctx), ...objectTypesOf(ctx)])
}

export function isObjectKey(key: string): key is ObjectKey {
  return key === SYNCED_SETTINGS_KEY || key === IDENTITY_KEY || key === SPACE_INFO_KEY
}

// The stored record without the local and derived fields.
export function syncData(record: object): Record<string, unknown> {
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
export async function listChangedRecordsIn(
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

// Really removes the tombstones whose deletedAt is strictly older than
// `olderThan` from every list (records and revs otherwise untouched). With
// `maxRev`, only tombstones whose rev is at most maxRev (already pushed to the
// server) are removed. Only the changed keys are written, in one setMany, and
// announced to other tabs; no lastDataChangeAt, no conversion request, no
// local-change notification. Returns how many records it removed. Called by
// the sync engine after a cycle.
export async function compactTombstonesIn(
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
export async function dedupeOccurrencesIn(
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
