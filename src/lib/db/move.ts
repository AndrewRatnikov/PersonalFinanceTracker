// Layer 6 of src/lib/db: moving records between spaces.

import { setMany } from 'idb-keyval'

import { AppError } from '../appErrors'
import { isCurrency } from '../domain'
import { isSpaceReadOnly } from '../spaces/keyring'
import { categoryMatchKey } from '../spaces/categoryMatch'
import { SpaceReadOnlyError } from '../spaces/types'
import { isLive } from '../syncRecords'
import { withWriteLock } from '../writeLock'
import {
  SYNC_META_KEY,
  cryptoFor,
  ctxFor,
  readStore,
  stampCreated,
  storageKeyOf,
  store,
  withSpaceLock,
  withUpdatedBy,
} from './context'
import { editedAt, liveRecords, nowIso } from './records'
import { openRevCounter } from './revs'
import {
  allExpenseChunkKeys,
  expenseChunkKey,
  notifyLocalChange,
  notifySpaceLocalChange,
  readChunk,
  writeKeysMany,
} from './storage'
import { afterCommit } from './events'
import { RECURRING_ATTEMPTS } from './recurringOccurrences'
import type { Category, RecurringKind } from '../domain'
import type { SpaceId } from '../spaces/types'
import type { SpaceCtx } from './context'
import type { CategoryKey } from './categories'
import type { StoredRecord } from './sync'

// ── Moving records between spaces (spec §23, D2) ──────────────────────────────

/** The most ids one moveRecords call accepts (all-or-nothing, D6). */
export const MOVE_RECORDS_MAX = 500

export type MoveRecordType = 'expense' | 'income' | 'recurring'

export interface MoveRecordsInput {
  from: SpaceId
  to: SpaceId
  type: MoveRecordType
  ids: Array<string>
}

export interface MoveRecordsResult {
  moved: number
  createdCategories: number
  skipped: number
}

export interface CopyCategoriesResult {
  categories: number
  incomeCategories: number
}

type MovableRecord = StoredRecord & {
  categoryId?: unknown
  createdAt?: unknown
  kind?: unknown
  updatedAt?: string
  deletedAt?: string
}

function categoryKeyOfKind(kind: RecurringKind): CategoryKey {
  return kind === 'income' ? 'incomeCategories' : 'categories'
}

function moveCategoryKeys(type: MoveRecordType): Array<CategoryKey> {
  if (type === 'expense') return ['categories']
  if (type === 'income') return ['incomeCategories']
  return ['categories', 'incomeCategories']
}

// The target base key of a source record: an expense keeps its createdAt and
// so lands in the chunk of that month; income and recurring are single keys.
function moveTargetKey(type: MoveRecordType, record: MovableRecord): string {
  if (type === 'expense') return expenseChunkKey(record.createdAt as string)
  return type
}

async function readMoveList(
  ctx: SpaceCtx,
  type: MoveRecordType,
  key: string,
): Promise<Array<MovableRecord>> {
  if (type === 'expense') return (await readChunk(ctx, key)) as unknown as Array<MovableRecord>
  return ((await readStore(ctx, key as 'income' | 'recurring')) ?? []) as unknown as Array<MovableRecord>
}

// Outside the lock: where each live source record is (id -> base key) and the
// target base keys they need.
async function planMove(
  ctx: SpaceCtx,
  type: MoveRecordType,
  ids: Set<string>,
): Promise<{ sourceOf: Map<string, string>; targetKeys: Set<string> }> {
  const sourceOf = new Map<string, string>()
  const targetKeys = new Set<string>()
  const keysToScan = type === 'expense' ? await allExpenseChunkKeys(ctx) : [type]
  for (const key of keysToScan) {
    for (const r of await readMoveList(ctx, type, key)) {
      if (!ids.has(r.id) || !isLive(r) || sourceOf.has(r.id)) continue
      sourceOf.set(r.id, key)
      targetKeys.add(moveTargetKey(type, r))
    }
  }
  return { sourceOf, targetKeys }
}

// A Family side that is a read-only copy refuses the move (D2).
function assertWritableSpace(ctx: SpaceCtx): void {
  if (!ctx.personal && isSpaceReadOnly(ctx.spaceId)) {
    throw new SpaceReadOnlyError(ctx.spaceId)
  }
}

// Moves live records between two spaces: each is created in the target with
// the same id (categories mapped by name, conversion and member fields reset,
// recurring progress kept) and becomes a tombstone in the source. Both spaces'
// data and meta:sync go into ONE setMany, so a failure leaves both unchanged.
// Ids that are gone, or already live in the target, are skipped.
export async function moveRecords(input: MoveRecordsInput): Promise<MoveRecordsResult> {
  const { from, to, type } = input
  if (from === to) {
    throw new AppError('move-same-space', 'Cannot move records into the same space')
  }
  if (input.ids.length > MOVE_RECORDS_MAX) {
    throw new AppError('move-too-many', `Cannot move more than ${MOVE_RECORDS_MAX} records`, {
      max: MOVE_RECORDS_MAX,
    })
  }
  const fromCtx = ctxFor(from)
  const toCtx = ctxFor(to)
  const ids = new Set(input.ids.filter((id) => typeof id === 'string' && id !== ''))
  const none: MoveRecordsResult = { moved: 0, createdCategories: 0, skipped: 0 }
  if (ids.size === 0) return none
  // Locked or unheld side: "LocalDb not initialized" / SpaceLockedError.
  const fromCrypto = await cryptoFor(from)
  const toCrypto = await cryptoFor(to)
  if (!store) return none
  const s = store
  assertWritableSpace(fromCtx)
  assertWritableSpace(toCtx)
  const catKeys = moveCategoryKeys(type)

  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === RECURRING_ATTEMPTS - 1
    const plan = await planMove(fromCtx, type, ids)
    if (plan.sourceOf.size === 0) return { ...none, skipped: ids.size }
    const sourceKeys = Array.from(new Set(plan.sourceOf.values()))
    const targetKeys = Array.from(plan.targetKeys)
    const lockKeys = [
      ...sourceKeys.map((k) => storageKeyOf(fromCtx, k)),
      storageKeyOf(fromCtx, SYNC_META_KEY),
      ...targetKeys.map((k) => storageKeyOf(toCtx, k)),
      ...catKeys.map((k) => storageKeyOf(toCtx, k)),
      storageKeyOf(toCtx, SYNC_META_KEY),
    ]
    const outcome = await withWriteLock(
      lockKeys,
      async (): Promise<
        | { status: 'retry' }
        | {
            status: 'done'
            result: MoveRecordsResult
            sourceWritten: Array<string>
            targetWritten: Array<string>
          }
      > => {
        assertWritableSpace(fromCtx)
        assertWritableSpace(toCtx)
        const lockedTarget = new Set(targetKeys)

        // Re-read under the lock.
        const sourceLists = new Map<string, Array<MovableRecord>>()
        for (const key of sourceKeys) {
          sourceLists.set(key, [...(await readMoveList(fromCtx, type, key))])
        }
        const found: Array<{ key: string; index: number }> = []
        let skipped = 0
        for (const id of ids) {
          const key = plan.sourceOf.get(id)
          if (key === undefined) {
            skipped++
            continue
          }
          const list = sourceLists.get(key) ?? []
          const index = list.findIndex((r) => r.id === id && isLive(r))
          const movedAway =
            index === -1 ||
            (type === 'expense' && !lockedTarget.has(moveTargetKey(type, list[index])))
          if (movedAway) {
            if (!lastAttempt) return { status: 'retry' }
            skipped++
            continue
          }
          found.push({ key, index })
        }

        const targetLists = new Map<string, Array<MovableRecord>>()
        for (const key of targetKeys) {
          targetLists.set(key, [...(await readMoveList(toCtx, type, key))])
        }
        const sourceCats = new Map<CategoryKey, Array<Category>>()
        const targetCats = new Map<CategoryKey, Array<Category>>()
        for (const key of catKeys) {
          sourceCats.set(key, (await readStore(fromCtx, key)) ?? [])
          targetCats.set(key, [...((await readStore(toCtx, key)) ?? [])])
        }

        const fromCounter = await openRevCounter(fromCtx)
        const toCounter = await openRevCounter(toCtx)
        const now = nowIso()
        const changedSource = new Set<string>()
        const changedTarget = new Set<string>()
        let createdCategories = 0
        let moved = 0

        // The target category id for a source category id: a live target
        // category with the same match key, else one new category per key.
        const mapCategory = (kind: RecurringKind, sourceId: unknown): unknown => {
          const catKey = categoryKeyOfKind(kind)
          const source = (sourceCats.get(catKey) ?? []).find((c) => c.id === sourceId)
          // An unknown source category keeps its id (shows as Uncategorized).
          if (!source) return sourceId
          const matchKey = categoryMatchKey(source.name)
          const list = targetCats.get(catKey) ?? []
          const match = list.find((c) => isLive(c) && categoryMatchKey(c.name) === matchKey)
          if (match) return match.id
          const created: Category = {
            id: crypto.randomUUID(),
            name: source.name.trim(),
            icon: source.icon ?? null,
            updatedAt: now,
          }
          if (isCurrency(source.defaultCurrency)) created.defaultCurrency = source.defaultCurrency
          stampCreated(toCounter.member, created)
          list.push({ ...created, rev: toCounter.next() })
          targetCats.set(catKey, list)
          changedTarget.add(catKey)
          createdCategories++
          return created.id
        }

        for (const { key, index } of found) {
          const list = sourceLists.get(key) ?? []
          const source = list[index]
          const targetKey = moveTargetKey(type, source)
          const target = targetLists.get(targetKey)
          if (!target) {
            skipped++
            continue
          }
          const at = target.findIndex((r) => r.id === source.id)
          const existing = at === -1 ? undefined : target[at]
          // Never overwrite a live record of the target.
          if (existing && isLive(existing)) {
            skipped++
            continue
          }
          const kind: RecurringKind =
            type === 'income'
              ? 'income'
              : type === 'expense'
                ? 'expense'
                : source.kind === 'income'
                  ? 'income'
                  : 'expense'
          const copy: MovableRecord = { ...source }
          for (const field of [
            'rev',
            'conversion',
            'manualRate',
            'category',
            'createdBy',
            'updatedBy',
            'paidBy',
            'deletedAt',
          ]) {
            delete copy[field]
          }
          copy.categoryId = mapCategory(kind, source.categoryId)
          // After an old tombstone of the same id, so it wins newest-wins sync.
          copy.updatedAt = editedAt(existing?.updatedAt)
          // Into a Family: createdBy = updatedBy = paidBy = me.
          stampCreated(toCounter.member, copy as { paidBy?: string }, {})
          copy.rev = toCounter.next()
          if (at === -1) target.push(copy)
          else target[at] = copy
          changedTarget.add(targetKey)

          let tombstone: MovableRecord = {
            ...source,
            deletedAt: now,
            updatedAt: now,
            rev: fromCounter.next(),
          }
          if (fromCounter.member !== undefined) {
            tombstone = withUpdatedBy(tombstone, fromCounter.member)
          }
          list[index] = tombstone
          changedSource.add(key)
          moved++
        }

        const result: MoveRecordsResult = { moved, createdCategories, skipped }
        if (moved === 0) {
          return { status: 'done', result, sourceWritten: [], targetWritten: [] }
        }

        const entries: Array<[IDBValidKey, unknown]> = []
        for (const key of changedSource) {
          entries.push([storageKeyOf(fromCtx, key), await fromCrypto.encrypt(sourceLists.get(key))])
        }
        entries.push([fromCounter.metaKey, { ...fromCounter.base, localRev: fromCounter.last }])
        for (const key of changedTarget) {
          const value = targetLists.has(key)
            ? targetLists.get(key)
            : targetCats.get(key as CategoryKey)
          entries.push([storageKeyOf(toCtx, key), await toCrypto.encrypt(value)])
        }
        entries.push([toCounter.metaKey, { ...toCounter.base, localRev: toCounter.last }])
        await setMany(entries, s)
        return {
          status: 'done',
          result,
          sourceWritten: Array.from(changedSource),
          targetWritten: Array.from(changedTarget),
        }
      },
    )
    if (outcome.status === 'retry') continue
    if (outcome.sourceWritten.length > 0 || outcome.targetWritten.length > 0) {
      for (const ctx of [fromCtx, toCtx]) {
        if (ctx.personal) notifyLocalChange()
        else notifySpaceLocalChange(ctx.spaceId)
      }
      await afterCommit(fromCtx, outcome.sourceWritten)
      await afterCommit(toCtx, outcome.targetWritten)
    }
    return outcome.result
  }
  throw new Error('moveRecords: storage kept changing')
}

// Adds to `to` every live expense and income category of `from` whose name
// (categoryMatchKey) has no live match in `to`, with its icon and default
// currency. One setMany in `to`; nothing missing writes nothing.
export async function copyCategoriesFromSpace(input: {
  from: SpaceId
  to: SpaceId
}): Promise<CopyCategoriesResult> {
  const { from, to } = input
  if (from === to) {
    throw new AppError('move-same-space', 'Cannot copy categories into the same space')
  }
  const fromCtx = ctxFor(from)
  const toCtx = ctxFor(to)
  await cryptoFor(from)
  await cryptoFor(to)
  assertWritableSpace(toCtx)
  const keysOf: Array<CategoryKey> = ['categories', 'incomeCategories']
  const done = await withSpaceLock(toCtx, [...keysOf, SYNC_META_KEY], async () => {
    const counter = await openRevCounter(toCtx)
    const result: CopyCategoriesResult = { categories: 0, incomeCategories: 0 }
    const values: Record<string, Array<Category>> = {}
    for (const key of keysOf) {
      const source = liveRecords((await readStore(fromCtx, key)) ?? [])
      const target = (await readStore(toCtx, key)) ?? []
      const taken = new Set(target.filter(isLive).map((c) => categoryMatchKey(c.name)))
      const next = [...target]
      let added = 0
      for (const c of source) {
        const matchKey = categoryMatchKey(c.name)
        if (matchKey === '' || taken.has(matchKey)) continue
        taken.add(matchKey)
        const created: Category = {
          id: crypto.randomUUID(),
          name: c.name.trim(),
          icon: c.icon ?? null,
          updatedAt: nowIso(),
        }
        if (isCurrency(c.defaultCurrency)) created.defaultCurrency = c.defaultCurrency
        stampCreated(counter.member, created)
        next.push({ ...created, rev: counter.next() })
        added++
      }
      if (added > 0) {
        values[key] = next
        result[key] = added
      }
    }
    const written = Object.keys(values)
    if (written.length > 0) await writeKeysMany(toCtx, values, counter)
    return { result, written }
  })
  if (done.written.length > 0) await afterCommit(toCtx, done.written)
  return done.result
}
