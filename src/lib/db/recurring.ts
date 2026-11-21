// Layer 5 of src/lib/db: recurring item CRUD, confirm/skip and quick repeat.

import { AppError } from '../appErrors'
import { occurrenceRecordId } from '../occurrenceId'
import {
  addDaysToDate,
  lastOccurrenceOnOrBefore,
  markOccurrenceHandled,
  nextOccurrence,
  occurrenceCreatedAt,
  occurrencesBetween,
  toLocalDateString,
} from '../recurrence'
import { recurringInputSchema } from '../schemas'
import {
  SYNC_META_KEY,
  readStore,
  stampCreated,
  withSpaceLock,
  withUpdatedBy,
} from './context'
import { nowIso, softDeleteIn, withoutRev } from './records'
import { openRevCounter } from './revs'
import { expenseChunkKey, readChunk, writeKeysMany } from './storage'
import { afterCommit } from './events'
import { conversionOnSave, readMainCurrency } from './settings'
import { withExpenseCategory } from './expenses'
import { withIncomeCategory } from './income'
import {
  DATE_STRING_RE,
  categoryIdsFor,
  isUnhandledOccurrence,
  liveItemIndex,
  occurrenceNotDue,
  occurrenceTargetKeys,
  planOccurrenceWrites,
  recurringNotFound,
  validateRecurringInput,
  validationError,
} from './recurringOccurrences'
import type {
  CreateExpenseInput,
  CreateIncomeInput,
  CreateRecurringInput,
  Expense,
  IncomeEntry,
  RecurringItem,
  RecurringKind,
  UpdateRecurringInput,
} from '../domain'
import type { SpaceCtx } from './context'
import type { OccurrenceOverrides } from './recurringOccurrences'

export async function addRecurringIn(
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
      // Family: the payer defaults to the creator; personal never gets one.
      stampCreated(counter.member, created, { paidBy: data.paidBy })
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

export async function updateRecurringIn(
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
    const updated: RecurringItem = {
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
    // Family only: an explicit payer replaces the stored one.
    if (!ctx.personal && data.paidBy !== undefined) updated.paidBy = data.paidBy
    return updated
  })
}

// Pausing stops generation. Resuming skips the occurrences that fell inside
// the pause (D3): handledThrough moves to the last occurrence before today,
// so today's occurrence onward is generated as normal.
export async function setRecurringPausedIn(
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
export async function deleteRecurringIn(ctx: SpaceCtx, id: string): Promise<void> {
  if (await softDeleteIn(ctx, 'recurring', id)) await afterCommit(ctx, ['recurring'])
}

// Ask mode: creates the record for one due occurrence (with optional
// overrides for that record only) and marks the date handled. When a record
// for the date already exists (even a deleted one), nothing new is created.
export async function confirmRecurringOccurrenceIn(
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
export async function skipRecurringOccurrenceIn(
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

export type QuickRepeatUnit = 'week' | 'month' | 'year'

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
export async function addRepeatingExpenseIn(
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
    // The item gets the entry's payer (Family only).
    stampCreated(counter.member, item, { paidBy: entry.paidBy })
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
export async function addRepeatingIncomeIn(
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
    // The item gets the entry's payer (Family only).
    stampCreated(counter.member, item, { paidBy: entry.paidBy })
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
