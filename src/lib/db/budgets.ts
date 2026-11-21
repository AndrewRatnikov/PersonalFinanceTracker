// Layer 4 of src/lib/db: budgets.

import { isLive } from '../syncRecords'
import {
  SYNC_META_KEY,
  readStore,
  stampCreated,
  withSpaceLock,
  withUpdatedBy,
} from './context'
import { liveRecords, nowIso, softDeleteIn, withoutRev } from './records'
import { openRevCounter } from './revs'
import { writeKeysMany } from './storage'
import { afterCommit } from './events'
import { liveCategories } from './categories'
import type { BudgetEntry, UpsertBudgetInput } from '../domain'
import type { SpaceCtx } from './context'

// ── Budgets ───────────────────────────────────────────────────────────────────

export async function getAllBudgetsIn(ctx: SpaceCtx): Promise<
  Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>
> {
  const budgets = liveRecords((await readStore(ctx, 'budgets')) ?? [])
  const categoryMap = new Map(
    (await liveCategories(ctx, 'categories')).map((c) => [c.id, c]),
  )
  return budgets.map((b) => {
    const cat = categoryMap.get(b.categoryId)
    return {
      ...b,
      categoryName: cat?.name ?? '',
      categoryIcon: cat?.icon ?? null,
    }
  })
}

// Updates the live budget of the category, or creates a new one (a new id,
// also after the old budget was deleted).
export async function upsertBudgetIn(
  ctx: SpaceCtx,
  input: UpsertBudgetInput,
): Promise<BudgetEntry> {
  const result = await withSpaceLock(ctx, ['budgets', SYNC_META_KEY], async () => {
    const budgets = (await readStore(ctx, 'budgets')) ?? []
    const index = budgets.findIndex(
      (b) => b.categoryId === input.categoryId && isLive(b),
    )
    const updatedAt = nowIso()
    const counter = await openRevCounter(ctx)
    let entry: BudgetEntry
    const updated = [...budgets]
    if (index !== -1) {
      entry = {
        ...withoutRev(budgets[index]),
        monthlyLimit: input.monthlyLimit,
        currency: input.currency,
        updatedAt,
      }
      updated[index] = { ...entry, rev: counter.next() }
    } else {
      entry = {
        id: crypto.randomUUID(),
        categoryId: input.categoryId,
        monthlyLimit: input.monthlyLimit,
        currency: input.currency,
        updatedAt,
      }
      stampCreated(counter.member, entry)
      updated.push({ ...entry, rev: counter.next() })
    }
    await writeKeysMany(ctx, { budgets: updated }, counter)
    return counter.member === undefined ? entry : withUpdatedBy(entry, counter.member)
  })
  await afterCommit(ctx, ['budgets'])
  return result
}

export async function deleteBudgetIn(ctx: SpaceCtx, id: string): Promise<void> {
  if (await softDeleteIn(ctx, 'budgets', id)) await afterCommit(ctx, ['budgets'])
}
