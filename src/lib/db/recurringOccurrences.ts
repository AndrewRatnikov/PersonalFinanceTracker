// Layer 5 of src/lib/db: recurring item helpers, occurrence planning and
// processing of due occurrences.

import { isMessageKey, translate } from '../../i18n/core'
import { AppError } from '../appErrors'
import { occurrenceRecordId } from '../occurrenceId'
import {
  dueOccurrences,
  occurrenceCreatedAt,
  occurrencesBetween,
  toLocalDateString,
} from '../recurrence'
import { recurringInputSchema, recurringInputSchemaFor } from '../schemas'
import { isSpaceReadOnly } from '../spaces/keyring'
import { isLive } from '../syncRecords'
import {
  SYNC_META_KEY,
  cryptoFor,
  personalLocked,
  readStore,
  stampCreated,
  store,
  withSpaceLock,
} from './context'
import { liveRecords, nowIso } from './records'
import { openRevCounter } from './revs'
import { expenseChunkKey, readChunk, writeKeysMany } from './storage'
import { afterCommit } from './events'
import { conversionOnSave, readMainCurrency } from './settings'
import { liveCategories } from './categories'
import type {
  CreateRecurringInput,
  Expense,
  IncomeEntry,
  RecurringItem,
  RecurringKind,
  RecurringOccurrence,
} from '../domain'
import type { SpaceCtx } from './context'
import type { RevCounter } from './revs'
import type { CategoryKey } from './categories'

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

export interface OccurrenceOverrides {
  amount?: number
  description?: string | null
}

export const RECURRING_ATTEMPTS = 3
export const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/

function categoryKeyFor(kind: RecurringKind): CategoryKey {
  return kind === 'income' ? 'incomeCategories' : 'categories'
}

// The storage key a generated record of `kind` on `date` is written to.
function occurrenceTargetKey(kind: RecurringKind, date: string): string {
  return kind === 'income'
    ? 'income'
    : expenseChunkKey(occurrenceCreatedAt(date))
}

export function occurrenceTargetKeys(
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
export async function categoryIdsFor(ctx: SpaceCtx, kind: RecurringKind): Promise<Array<string>> {
  return (await liveCategories(ctx, categoryKeyFor(kind))).map((c) => c.id)
}

// A zod issue message is a catalog key (errors.validation.*): the error keeps
// the key for the UI and today's English text as its message.
export function validationError(key: string): AppError {
  const message = isMessageKey(key) ? translate('en', key) : key
  return new AppError('validation', message, { key })
}

export function recurringNotFound(id: string): AppError {
  return new AppError('recurring-not-found', `Recurring item not found: ${id}`, { id })
}

export function occurrenceNotDue(): AppError {
  return new AppError('occurrence-not-due', 'Occurrence is not due')
}

// Validates with recurringInputSchemaFor (the live categories of the input's
// kind) and throws the first issue (an AppError 'validation').
export async function validateRecurringInput(
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
export async function planOccurrenceWrites(
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
    // A generated entry inherits the item's payer; without one, the
    // generating member (D7).
    stampCreated(counter.member, record, { paidBy: item.paidBy })
    record.rev = counter.next()
    const next = [...list, record]
    lists.set(key, next)
    values[key] = next
    created++
  }
  return { values, created }
}

// True when `date` is an occurrence of the item that isn't handled yet.
export function isUnhandledOccurrence(item: RecurringItem, date: string): boolean {
  if (!DATE_STRING_RE.test(date)) return false
  if (item.handledThrough !== null && date <= item.handledThrough) return false
  if (item.handledAhead.includes(date)) return false
  const dates = occurrencesBetween(item, item.handledThrough, date)
  return dates[dates.length - 1] === date
}

export async function getAllRecurringIn(ctx: SpaceCtx): Promise<Array<RecurringItem>> {
  return liveRecords((await readStore(ctx, 'recurring')) ?? [])
}

export async function getDueRecurringIn(
  ctx: SpaceCtx,
  today: string = toLocalDateString(),
): Promise<Array<RecurringOccurrence>> {
  return dueOccurrences(await getAllRecurringIn(ctx), today)
}

// The index of the live item `id` in a stored list, or -1.
export function liveItemIndex(items: Array<RecurringItem>, id: string): number {
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
export async function processDueRecurringIn(
  ctx: SpaceCtx,
  today: string = toLocalDateString(),
): Promise<{ created: number; itemsTouched: number }> {
  if (!store || personalLocked(ctx)) return { created: 0, itemsTouched: 0 }
  if (!ctx.personal) {
    // Loads the keyring (SpaceLockedError as before) to see the share status.
    await cryptoFor(ctx.spaceId)
    if (isSpaceReadOnly(ctx.spaceId)) return { created: 0, itemsTouched: 0 }
  }
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
