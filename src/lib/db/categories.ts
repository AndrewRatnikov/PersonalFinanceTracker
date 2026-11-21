// Layer 4 of src/lib/db: expense and income categories.

import { get } from 'idb-keyval'

import { AppError } from '../appErrors'
import {
  defaultExpenseCategories,
  defaultIncomeCategories,
} from '../defaultCategories'
import { isCurrency } from '../domain'
import { convertIncomeSources } from '../incomeCategories'
import { isLive } from '../syncRecords'
import {
  SYNC_META_KEY,
  cryptoFor,
  personalLocked,
  readStore,
  stampCreated,
  storageKeyOf,
  store,
  withSpaceLock,
  withUpdatedBy,
} from './context'
import { liveRecords, nowIso, withoutRev } from './records'
import { openRevCounter } from './revs'
import { allExpenseChunkKeys, readChunk, writeKeysMany } from './storage'
import { afterCommit } from './events'
import type {
  Category,
  CreateCategoryInput,
  RecurringKind,
  UpdateCategoryInput,
} from '../domain'
import type { Lang } from '../../i18n/lang'
import type { LocalDbMap, SpaceCtx } from './context'

export async function liveCategories(ctx: SpaceCtx, key: CategoryKey): Promise<Array<Category>> {
  return liveRecords((await readStore(ctx, key)) ?? [])
}

// ── Categories ────────────────────────────────────────────────────────────────

export async function getAllCategoriesIn(ctx: SpaceCtx): Promise<Array<Category>> {
  return liveCategories(ctx, 'categories')
}

export type CategoryKey = 'categories' | 'incomeCategories'

function categoryNotFound(id: string): AppError {
  return new AppError('category-not-found', `Category not found: ${id}`, { id })
}

// Shared by the expense and the income category mutations: the whole
// read-modify-write runs under the lock of `key`. Names are trimmed and unique
// among the live categories, ignoring case (a deleted name can be reused; it
// gets a new id).
async function addCategoryTo(
  ctx: SpaceCtx,
  key: CategoryKey,
  input: CreateCategoryInput,
): Promise<Category> {
  const entry = await withSpaceLock(ctx, [key, SYNC_META_KEY], async () => {
    const categories = (await readStore(ctx, key)) ?? []
    const name = input.name.trim()
    if (!name) throw new AppError('category-name-required', 'Category name is required')
    if (
      categories.some(
        (c) => isLive(c) && c.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new AppError('category-exists', `Category "${name}" already exists`, {
        name,
      })
    }
    const created: Category = {
      id: crypto.randomUUID(),
      name,
      icon: input.icon ?? null,
      updatedAt: nowIso(),
    }
    if (input.defaultCurrency !== undefined) {
      if (!isCurrency(input.defaultCurrency)) {
        throw new AppError('invalid-currency', 'Invalid currency')
      }
      created.defaultCurrency = input.defaultCurrency
    }
    const counter = await openRevCounter(ctx)
    stampCreated(counter.member, created)
    await writeKeysMany(
      ctx,
      { [key]: [...categories, { ...created, rev: counter.next() }] },
      counter,
    )
    return created
  })
  await afterCommit(ctx, [key])
  return entry
}

async function updateCategoryTo(
  ctx: SpaceCtx,
  key: CategoryKey,
  input: UpdateCategoryInput,
): Promise<Category> {
  const result = await withSpaceLock(ctx, [key, SYNC_META_KEY], async () => {
    const categories = (await readStore(ctx, key)) ?? []
    const name = input.name.trim()
    if (!name) throw new AppError('category-name-required', 'Category name is required')
    const index = categories.findIndex((c) => c.id === input.id && isLive(c))
    if (index === -1) throw categoryNotFound(input.id)
    if (
      categories.some(
        (c) =>
          c.id !== input.id &&
          isLive(c) &&
          c.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new AppError('category-exists', `Category "${name}" already exists`, {
        name,
      })
    }
    // defaultCurrency: undefined keeps the stored value (a rename keeps it),
    // null removes the key (never stored as null), a currency sets it.
    const nextCurrency = input.defaultCurrency
    if (
      nextCurrency !== undefined &&
      nextCurrency !== null &&
      !isCurrency(nextCurrency)
    ) {
      throw new AppError('invalid-currency', 'Invalid currency')
    }
    const updated: Category = {
      ...withoutRev(categories[index]),
      name,
      icon: input.icon ?? null,
      updatedAt: nowIso(),
    }
    if (nextCurrency === null) delete updated.defaultCurrency
    else if (nextCurrency !== undefined) updated.defaultCurrency = nextCurrency
    const counter = await openRevCounter(ctx)
    const next = [...categories]
    next[index] = { ...updated, rev: counter.next() }
    await writeKeysMany(ctx, { [key]: next }, counter)
    return counter.member === undefined ? updated : withUpdatedBy(updated, counter.member)
  })
  await afterCommit(ctx, [key])
  return result
}

export async function addCategoryIn(
  ctx: SpaceCtx,
  input: CreateCategoryInput,
): Promise<Category> {
  return addCategoryTo(ctx, 'categories', input)
}

export async function updateCategoryIn(
  ctx: SpaceCtx,
  input: UpdateCategoryInput,
): Promise<Category> {
  return updateCategoryTo(ctx, 'categories', input)
}

// Refuses while a live recurring item of `kind` uses the category.
async function assertNoRecurringUses(
  ctx: SpaceCtx,
  kind: RecurringKind,
  categoryId: string,
): Promise<void> {
  const items = (await readStore(ctx, 'recurring')) ?? []
  const using = items.filter(
    (i) => isLive(i) && i.kind === kind && i.categoryId === categoryId,
  ).length
  if (using > 0) {
    throw new AppError(
      'category-used-by-recurring',
      `Used by ${using} recurring item${using === 1 ? '' : 's'}`,
      { count: using },
    )
  }
}

// Refused while live expenses or live recurring items use the category.
// Otherwise the category and every live budget of it become tombstones, in
// one transaction.
export async function deleteCategoryIn(ctx: SpaceCtx, id: string): Promise<void> {
  const written = await withSpaceLock(
    ctx,
    ['budgets', 'categories', 'recurring', SYNC_META_KEY],
    async () => {
      // Check all expense chunks for references to this category. This only
      // reads chunks, so it takes no chunk locks.
      const chunkKeys = await allExpenseChunkKeys(ctx)
      const chunks = await Promise.all(chunkKeys.map((k) => readChunk(ctx, k)))
      const using = chunks
        .flat()
        .filter((e) => isLive(e) && e.categoryId === id).length
      if (using > 0) {
        throw new AppError(
          'category-used-by-expenses',
          `${using} expense${using === 1 ? '' : 's'} use this category`,
          { count: using },
        )
      }
      await assertNoRecurringUses(ctx, 'expense', id)
      const categories = (await readStore(ctx, 'categories')) ?? []
      const index = categories.findIndex((c) => c.id === id && isLive(c))
      if (index === -1) return []

      const counter = await openRevCounter(ctx)
      const now = nowIso()
      const nextCategories = [...categories]
      nextCategories[index] = {
        ...categories[index],
        deletedAt: now,
        updatedAt: now,
        rev: counter.next(),
      }
      const values: Partial<LocalDbMap> = { categories: nextCategories }

      const budgets = (await readStore(ctx, 'budgets')) ?? []
      const nextBudgets = budgets.map((b) =>
        b.categoryId !== id || !isLive(b)
          ? b
          : { ...b, deletedAt: now, updatedAt: now, rev: counter.next() },
      )
      const budgetsChanged = nextBudgets.some((b, i) => b !== budgets[i])
      if (budgetsChanged) values.budgets = nextBudgets
      await writeKeysMany(ctx, values, counter)
      return budgetsChanged ? ['categories', 'budgets'] : ['categories']
    },
  )
  if (written.length > 0) await afterCommit(ctx, written)
}

// Writes the default expense categories in `lang` when there are no live
// categories yet. Existing categories are user data and are never renamed.
export async function provisionDefaultCategoriesIn(
  ctx: SpaceCtx,
  lang: Lang = 'en',
): Promise<void> {
  const wrote = await withSpaceLock(ctx, ['categories', SYNC_META_KEY], async () => {
    const categories = (await readStore(ctx, 'categories')) ?? []
    if (categories.some(isLive)) return false
    const updatedAt = nowIso()
    const counter = await openRevCounter(ctx)
    const defaults: Array<Category> = defaultExpenseCategories(lang).map((c) =>
      stampCreated<Category>(counter.member, {
        id: crypto.randomUUID(),
        name: c.name,
        icon: c.icon,
        updatedAt,
        rev: counter.next(),
      }),
    )
    await writeKeysMany(ctx, { categories: [...categories, ...defaults] }, counter)
    return true
  })
  if (wrote) await afterCommit(ctx, ['categories'])
}

// ── Income categories ─────────────────────────────────────────────────────────

export async function getAllIncomeCategoriesIn(ctx: SpaceCtx): Promise<Array<Category>> {
  return liveCategories(ctx, 'incomeCategories')
}

export async function addIncomeCategoryIn(
  ctx: SpaceCtx,
  input: CreateCategoryInput,
): Promise<Category> {
  return addCategoryTo(ctx, 'incomeCategories', input)
}

export async function updateIncomeCategoryIn(
  ctx: SpaceCtx,
  input: UpdateCategoryInput,
): Promise<Category> {
  return updateCategoryTo(ctx, 'incomeCategories', input)
}

// Refused while live income entries or live income recurring items use it.
export async function deleteIncomeCategoryIn(ctx: SpaceCtx, id: string): Promise<void> {
  const wrote = await withSpaceLock(
    ctx,
    ['income', 'incomeCategories', 'recurring', SYNC_META_KEY],
    async () => {
      const income = (await readStore(ctx, 'income')) ?? []
      const using = income.filter((e) => isLive(e) && e.categoryId === id).length
      if (using > 0) {
        throw new AppError(
          'category-used-by-income',
          using === 1
            ? '1 income entry uses this category'
            : `${using} income entries use this category`,
          { count: using },
        )
      }
      await assertNoRecurringUses(ctx, 'income', id)
      const categories = (await readStore(ctx, 'incomeCategories')) ?? []
      const index = categories.findIndex((c) => c.id === id && isLive(c))
      if (index === -1) return false
      const counter = await openRevCounter(ctx)
      const now = nowIso()
      const next = [...categories]
      next[index] = { ...categories[index], deletedAt: now, updatedAt: now, rev: counter.next() }
      await writeKeysMany(ctx, { incomeCategories: next }, counter)
      return true
    },
  )
  if (wrote) await afterCommit(ctx, ['incomeCategories'])
}

// Provisions the default income categories and converts legacy free-text
// income sources into categories, once: when `incomeCategories` already
// exists (even as an unreadable blob) it does nothing. Both keys and meta:sync
// are written in one transaction; each created category gets a rev, the
// rewritten income records (a derived field) don't. A DecryptError on
// `income` propagates and nothing is written. Returns true when it wrote.
// `lang` is the language of the defaults and of the "Other" fallback.
export async function ensureIncomeCategoriesIn(
  ctx: SpaceCtx,
  lang: Lang = 'en',
): Promise<boolean> {
  const s = store
  if (!s || personalLocked(ctx)) return false
  if (!ctx.personal) {
    // A Family space has no legacy income sources: only the defaults, when
    // the key is absent.
    await cryptoFor(ctx.spaceId)
    const wroteDefaults = await withSpaceLock(
      ctx,
      ['incomeCategories', SYNC_META_KEY],
      async () => {
        if ((await get<unknown>(storageKeyOf(ctx, 'incomeCategories'), s)) !== undefined) {
          return false
        }
        const counter = await openRevCounter(ctx)
        const updatedAt = nowIso()
        const incomeCategories: Array<Category> = defaultIncomeCategories(lang).map((c) =>
          stampCreated<Category>(counter.member, {
            id: crypto.randomUUID(),
            name: c.name,
            icon: c.icon,
            updatedAt,
            rev: counter.next(),
          }),
        )
        await writeKeysMany(ctx, { incomeCategories }, counter)
        return true
      },
    )
    if (wroteDefaults) await afterCommit(ctx, ['incomeCategories'])
    return wroteDefaults
  }
  const wrote = await withSpaceLock(
    ctx,
    ['income', 'incomeCategories', SYNC_META_KEY],
    async () => {
      const existing = await get<unknown>('incomeCategories', s)
      if (existing !== undefined) return false
      const income = (await readStore(ctx, 'income')) ?? []
      const converted = convertIncomeSources(income, [], { addDefaults: true, lang })
      const counter = await openRevCounter(ctx)
      const incomeCategories = converted.incomeCategories.map((c) => ({
        ...c,
        rev: counter.next(),
      }))
      await writeKeysMany(ctx, { incomeCategories, income: converted.income }, counter)
      return true
    },
  )
  if (wrote) await afterCommit(ctx, ['incomeCategories', 'income'])
  return wrote
}
