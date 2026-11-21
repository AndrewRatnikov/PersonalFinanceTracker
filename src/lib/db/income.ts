// Layer 4 of src/lib/db: income entries.

import {
  SYNC_META_KEY,
  readStore,
  stampCreated,
  withSpaceLock,
} from './context'
import { liveRecords, nowIso, softDeleteIn, withoutRev } from './records'
import { openRevCounter } from './revs'
import { writeKeysMany } from './storage'
import { afterCommit } from './events'
import { conversionOnSave, readMainCurrency } from './settings'
import { liveCategories } from './categories'
import type { Category, CreateIncomeInput, IncomeEntry } from '../domain'
import type { SpaceCtx } from './context'

// ── Income ────────────────────────────────────────────────────────────────────

function joinIncomeCategories(
  income: Array<IncomeEntry>,
  categories: Array<Category>,
): Array<IncomeEntry> {
  const categoryMap = new Map(categories.map((c) => [c.id, c]))
  return income.map((i) => ({
    ...i,
    category: categoryMap.get(i.categoryId),
  }))
}

export async function getAllIncomeIn(ctx: SpaceCtx): Promise<Array<IncomeEntry>> {
  const income = liveRecords((await readStore(ctx, 'income')) ?? [])
  return joinIncomeCategories(income, await liveCategories(ctx, 'incomeCategories'))
}

export async function withIncomeCategory(ctx: SpaceCtx, entry: IncomeEntry): Promise<IncomeEntry> {
  const categories = await liveCategories(ctx, 'incomeCategories')
  const category = categories.find((c) => c.id === entry.categoryId)
  return { ...withoutRev(entry), category }
}

export async function addIncomeIn(
  ctx: SpaceCtx,
  input: CreateIncomeInput,
): Promise<IncomeEntry> {
  const main = await readMainCurrency(ctx)
  const entry = await withSpaceLock(ctx, ['income', SYNC_META_KEY], async () => {
    const income = (await readStore(ctx, 'income')) ?? []
    const now = nowIso()
    const created: IncomeEntry = {
      id: crypto.randomUUID(),
      categoryId: input.categoryId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    }
    const conversion = conversionOnSave(created, main)
    if (conversion) created.conversion = conversion
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, created, { paidBy: input.paidBy })
    await writeKeysMany(
      ctx,
      { income: [...income, { ...created, rev: counter.next() }] },
      counter,
    )
    return created
  })
  await afterCommit(ctx, ['income'])
  return withIncomeCategory(ctx, entry)
}

export async function deleteIncomeIn(ctx: SpaceCtx, id: string): Promise<void> {
  if (await softDeleteIn(ctx, 'income', id)) await afterCommit(ctx, ['income'])
}
