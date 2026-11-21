// Layer 4 of src/lib/db: expenses.

import { isLive } from '../syncRecords'
import {
  SYNC_META_KEY,
  stampCreated,
  withSpaceLock,
  withUpdatedBy,
} from './context'
import { liveRecords, nowIso, withoutRev } from './records'
import { openRevCounter } from './revs'
import {
  allExpenseChunkKeys,
  chunkKeysBetween,
  expenseChunkKey,
  readChunk,
  writeKeysMany,
} from './storage'
import { afterCommit } from './events'
import { conversionOnSave, readMainCurrency } from './settings'
import { liveCategories } from './categories'
import type { CreateExpenseInput, Expense, UpdateExpenseInput } from '../domain'
import type { SpaceCtx } from './context'

// ── Expenses ──────────────────────────────────────────────────────────────────

async function joinCategories(
  ctx: SpaceCtx,
  expenses: Array<Expense>,
): Promise<Array<Expense>> {
  const categoryMap = new Map(
    (await liveCategories(ctx, 'categories')).map((c) => [c.id, c]),
  )
  return expenses.map((e) => ({
    ...e,
    category: categoryMap.get(e.categoryId),
  }))
}

export async function getExpensesForRangeIn(
  ctx: SpaceCtx,
  from: string,
  to: string,
): Promise<Array<Expense>> {
  const chunkKeys = chunkKeysBetween(from, to)
  const chunks = await Promise.all(chunkKeys.map((k) => readChunk(ctx, k)))
  const expenses = liveRecords(chunks.flat())
    .filter((e) => e.createdAt >= from && e.createdAt <= to)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return joinCategories(ctx, expenses)
}

// TODO: could possible create a spike if user will export all data for 5 years
export async function getAllExpensesIn(ctx: SpaceCtx): Promise<Array<Expense>> {
  const chunkKeys = await allExpenseChunkKeys(ctx)
  const chunks = await Promise.all(chunkKeys.map((k) => readChunk(ctx, k)))
  const expenses = liveRecords(chunks.flat()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )
  return joinCategories(ctx, expenses)
}

export async function withExpenseCategory(ctx: SpaceCtx, entry: Expense): Promise<Expense> {
  const categories = await liveCategories(ctx, 'categories')
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...withoutRev(entry), category }
}

export async function addExpenseIn(ctx: SpaceCtx, input: CreateExpenseInput): Promise<Expense> {
  if (
    input.createdAt !== undefined &&
    isNaN(new Date(input.createdAt).getTime())
  ) {
    throw new Error(`addExpense: invalid createdAt "${input.createdAt}"`)
  }
  const now = nowIso()
  const entry: Expense = {
    id: crypto.randomUUID(),
    amount: input.amount,
    currency: input.currency,
    categoryId: input.categoryId,
    description: input.description,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  }
  const conversion = conversionOnSave(entry, await readMainCurrency(ctx))
  if (conversion) entry.conversion = conversion
  const chunkKey = expenseChunkKey(entry.createdAt)
  await withSpaceLock(ctx, [chunkKey, SYNC_META_KEY], async () => {
    const existing = await readChunk(ctx, chunkKey)
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, entry, { paidBy: input.paidBy })
    await writeKeysMany(
      ctx,
      { [chunkKey]: [...existing, { ...entry, rev: counter.next() }] },
      counter,
    )
  })
  await afterCommit(ctx, [chunkKey])
  return withExpenseCategory(ctx, entry)
}

// createdAt is required so we can derive the correct chunk without a full scan.
// The record stays in its chunk as a tombstone. Deleting a missing or already
// deleted expense writes nothing.
export async function deleteExpenseIn(
  ctx: SpaceCtx,
  id: string,
  createdAt: string,
): Promise<void> {
  const chunkKey = expenseChunkKey(createdAt)
  const wrote = await withSpaceLock(ctx, [chunkKey, SYNC_META_KEY], async () => {
    const chunk = await readChunk(ctx, chunkKey)
    const index = chunk.findIndex((e) => e.id === id && isLive(e))
    if (index === -1) return false
    const counter = await openRevCounter(ctx)
    const now = nowIso()
    const next = [...chunk]
    next[index] = { ...chunk[index], deletedAt: now, updatedAt: now, rev: counter.next() }
    await writeKeysMany(ctx, { [chunkKey]: next }, counter)
    return true
  })
  if (wrote) await afterCommit(ctx, [chunkKey])
}

// Undo of a delete: clears deletedAt, bumps updatedAt and stamps a new rev.
// An expense that is already live is returned unchanged (nothing written).
export async function undeleteExpenseIn(
  ctx: SpaceCtx,
  id: string,
  createdAt: string,
): Promise<Expense> {
  const chunkKey = expenseChunkKey(createdAt)
  const { record, wrote } = await withSpaceLock(
    ctx,
    [chunkKey, SYNC_META_KEY],
    async () => {
      const chunk = await readChunk(ctx, chunkKey)
      const live = chunk.find((e) => e.id === id && isLive(e))
      if (live) return { record: live, wrote: false }
      const index = chunk.findIndex((e) => e.id === id)
      if (index === -1) {
        throw new Error(`undeleteExpense: expense not found: ${id}`)
      }
      const counter = await openRevCounter(ctx)
      const revived: Expense = { ...chunk[index], updatedAt: nowIso() }
      delete revived.deletedAt
      revived.rev = counter.next()
      const next = [...chunk]
      next[index] = revived
      await writeKeysMany(ctx, { [chunkKey]: next }, counter)
      const member = counter.member
      return {
        record: member === undefined ? revived : withUpdatedBy(revived, member),
        wrote: true,
      }
    },
  )
  if (wrote) await afterCommit(ctx, [chunkKey])
  return withExpenseCategory(ctx, record)
}

// originalCreatedAt locates the current chunk; if the patch moves createdAt
// into a different month the record is moved to that month's chunk. Both
// chunks and meta:sync are written in ONE setMany.
export async function updateExpenseIn(
  ctx: SpaceCtx,
  id: string,
  originalCreatedAt: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  const oldKey = expenseChunkKey(originalCreatedAt)
  const main = await readMainCurrency(ctx)
  const lockKeys = [oldKey, SYNC_META_KEY]
  if (
    patch.createdAt !== undefined &&
    !isNaN(new Date(patch.createdAt).getTime())
  ) {
    lockKeys.push(expenseChunkKey(patch.createdAt))
  }

  const { result, written } = await withSpaceLock(ctx, lockKeys, async () => {
    const oldChunk = await readChunk(ctx, oldKey)
    const index = oldChunk.findIndex((e) => e.id === id && isLive(e))
    if (index === -1) {
      throw new Error(`updateExpense: expense not found: ${id}`)
    }
    const existing = oldChunk[index]

    const createdAt = patch.createdAt ?? existing.createdAt
    if (isNaN(new Date(createdAt).getTime())) {
      throw new Error(`updateExpense: invalid createdAt "${createdAt}"`)
    }

    const categories = await liveCategories(ctx, 'categories')
    if (
      patch.categoryId !== undefined &&
      !categories.some((c) => c.id === patch.categoryId)
    ) {
      throw new Error(`updateExpense: unknown categoryId "${patch.categoryId}"`)
    }

    const description =
      patch.description !== undefined
        ? patch.description === ''
          ? null
          : patch.description
        : existing.description

    const updated: Expense = {
      id: existing.id,
      amount: patch.amount ?? existing.amount,
      currency: patch.currency ?? existing.currency,
      categoryId: patch.categoryId ?? existing.categoryId,
      description,
      createdAt,
      updatedAt: nowIso(),
    }
    // A generated record keeps its idempotency key (recurringId +
    // occurrenceDate); ordinary records keep their exact shape.
    if (existing.recurringId !== undefined) {
      updated.recurringId = existing.recurringId
    }
    if (existing.occurrenceDate !== undefined) {
      updated.occurrenceDate = existing.occurrenceDate
    }
    // The conversion stays only while amount, currency and date are
    // unchanged; otherwise it is the identity (in the main currency) or
    // dropped (pending). A manual rate stays unless the currency changed.
    const sameMoney =
      updated.amount === existing.amount &&
      updated.currency === existing.currency &&
      updated.createdAt === existing.createdAt
    const conversion = sameMoney
      ? existing.conversion
      : conversionOnSave(updated, main)
    if (conversion !== undefined) updated.conversion = conversion
    if (
      existing.manualRate !== undefined &&
      updated.currency === existing.currency
    ) {
      updated.manualRate = existing.manualRate
    }

    const counter = await openRevCounter(ctx)
    // Family: createdBy and paidBy stay unless paidBy is given; updatedBy is
    // this writer (removed when unknown).
    if (counter.member !== undefined) {
      if (existing.createdBy !== undefined) updated.createdBy = existing.createdBy
      const paidBy = patch.paidBy ?? existing.paidBy
      if (paidBy !== undefined) updated.paidBy = paidBy
      if (counter.member) updated.updatedBy = counter.member
    }
    const stored: Expense = { ...updated, rev: counter.next() }
    const newKey = expenseChunkKey(createdAt)
    let writtenKeys: Array<string>
    if (newKey === oldKey) {
      const next = [...oldChunk]
      next[index] = stored
      await writeKeysMany(ctx, { [oldKey]: next }, counter)
      writtenKeys = [oldKey]
    } else {
      // One transaction: the record is never lost or duplicated.
      const newChunk = await readChunk(ctx, newKey)
      await writeKeysMany(
        ctx,
        {
          [newKey]: [...newChunk.filter((e) => e.id !== id), stored],
          [oldKey]: oldChunk.filter((e) => e.id !== id),
        },
        counter,
      )
      writtenKeys = [newKey, oldKey]
    }

    const category = categories.find((c) => c.id === updated.categoryId)
    return { result: { ...updated, category }, written: writtenKeys }
  })
  await afterCommit(ctx, written)
  return result
}
