// Income categories: the defaults and the pure conversion of legacy free-text
// income `source` values into income categories. No storage access here, so
// both localDb.ensureIncomeCategories() and backup restore can reuse it.

import { t } from '../i18n/core'
import { defaultIncomeCategories } from './defaultCategories'
import type { Lang } from '../i18n/lang'
import type { Category, IncomeEntry } from './domain'

export const DEFAULT_INCOME_CATEGORIES: ReadonlyArray<{
  name: string
  icon: string
}> = defaultIncomeCategories('en')

export interface ConvertIncomeSourcesOptions {
  /** ISO timestamp; defaults to the current time. */
  now?: string
  /** Also append every default that isn't present yet. Default false. */
  addDefaults?: boolean
  /** Keep each converted entry's own updatedAt instead of `now`. Default false. */
  preserveUpdatedAt?: boolean
  /** Language of the defaults and of the "Other" fallback. Default 'en'. */
  lang?: Lang
}

export interface ConvertIncomeSourcesResult {
  incomeCategories: Array<Category>
  income: Array<IncomeEntry>
  /** Number of categories appended to the list. */
  created: number
}

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

function needsConversion(entry: IncomeEntry): boolean {
  return typeof entry.categoryId !== 'string' || entry.categoryId === ''
}

function trimmedSource(entry: IncomeEntry): string {
  return typeof entry.source === 'string' ? entry.source.trim() : ''
}

// Deterministic apart from the generated ids; never mutates its inputs.
// Entries that already have a categoryId are returned as the same object.
export function convertIncomeSources(
  income: ReadonlyArray<IncomeEntry>,
  existingIncomeCategories: ReadonlyArray<Category>,
  options: ConvertIncomeSourcesOptions = {},
): ConvertIncomeSourcesResult {
  const now = options.now ?? new Date().toISOString()
  const defaults = defaultIncomeCategories(options.lang ?? 'en')
  const other = defaults[defaults.length - 1]
  const list: Array<Category> = [...existingIncomeCategories]
  const byName = new Map<string, Category>()
  for (const c of list) {
    const key = nameKey(c.name)
    if (!byName.has(key)) byName.set(key, c)
  }
  let created = 0

  const append = (name: string, icon: string | null): Category => {
    const category: Category = {
      id: crypto.randomUUID(),
      name,
      icon,
      updatedAt: now,
    }
    list.push(category)
    byName.set(nameKey(name), category)
    created++
    return category
  }

  // Pass 1: every distinct source of an entry that needs conversion.
  for (const entry of income) {
    if (!needsConversion(entry)) continue
    const source = trimmedSource(entry)
    if (source && !byName.has(nameKey(source))) append(source, null)
  }

  // Pass 2: missing defaults.
  if (options.addDefaults) {
    for (const d of defaults) {
      if (!byName.has(nameKey(d.name))) append(d.name, d.icon)
    }
  }

  // Pass 3: map each entry that needs conversion to its category.
  const converted = income.map((entry): IncomeEntry => {
    if (!needsConversion(entry)) return entry
    const source = trimmedSource(entry)
    let category = source ? byName.get(nameKey(source)) : undefined
    if (!category) {
      category =
        byName.get(nameKey(other.name)) ?? append(other.name, other.icon)
    }
    const rest: Record<string, unknown> = { ...entry }
    delete rest.source
    delete rest.category
    delete rest.updatedAt
    const result = {
      ...rest,
      categoryId: category.id,
    } as unknown as IncomeEntry
    if (options.preserveUpdatedAt) {
      if (entry.updatedAt !== undefined) result.updatedAt = entry.updatedAt
    } else {
      result.updatedAt = now
    }
    return result
  })

  return { incomeCategories: list, income: converted, created }
}

/** Category name, then the trimmed legacy source, then 'Uncategorized'. */
export function incomeSourceLabel(
  entry: Pick<IncomeEntry, 'category' | 'source'>,
): string {
  const name = entry.category?.name
  if (name) return name
  const source = typeof entry.source === 'string' ? entry.source.trim() : ''
  return source || t('common.uncategorized')
}
