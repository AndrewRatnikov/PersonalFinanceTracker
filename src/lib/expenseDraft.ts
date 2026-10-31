// Draft and URL helpers for the expense drawer. Pure: no IndexedDB, no React.

import dayjs from 'dayjs'

import { isCurrency } from './domain'
import type { Currency } from './domain'

/** Prefill values for the add drawer; `amount` is draft text. */
export interface ExpenseDrawerInitial {
  categoryId?: string
  amount?: string
  currency?: Currency
  description?: string
}

/** The sanitised search params of /transactions. */
export type TransactionsSearch = {
  add?: 'expense'
  edit?: string
  category?: string
  amount?: string
  currency?: Currency
  description?: string
  /** Which space the add drawer opens in; kept only with `add: 'expense'`. */
  space?: 'personal' | 'family'
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/
const DESCRIPTION_MAX = 120

/**
 * The typed amount as a number, accepting "," or "." as the decimal separator.
 * More than one separator, an empty text or anything else unparsable is NaN.
 */
export function parseDraftAmount(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return NaN
  const separators = trimmed.match(/[.,]/g)?.length ?? 0
  if (separators > 1) return NaN
  return Number(trimmed.replace(',', '.'))
}

/**
 * Builds the ISO createdAt for the chosen calendar date. An unchanged date
 * passes the original timestamp through untouched; a changed date keeps the
 * original local time of day.
 */
export function buildCreatedAt(
  date: string,
  initialDate: string,
  original: string,
): string {
  if (date === initialDate) return original
  if (date === '') return ''
  const picked = dayjs(date)
  if (!picked.isValid()) return date
  const orig = dayjs(original)
  return picked
    .hour(orig.hour())
    .minute(orig.minute())
    .second(orig.second())
    .millisecond(orig.millisecond())
    .toISOString()
}

/**
 * createdAt for a new expense: undefined for today (addExpense stamps "now"),
 * otherwise the picked local date with the local time of day of `now`. An
 * invalid date comes back unchanged, so validation fails on it.
 */
export function createdAtForDate(
  date: string,
  today: string,
  now: Date = new Date(),
): string | undefined {
  if (date === today) return undefined
  const picked = dayjs(date)
  if (!picked.isValid()) return date
  const at = dayjs(now)
  return picked
    .hour(at.hour())
    .minute(at.minute())
    .second(at.second())
    .millisecond(at.millisecond())
    .toISOString()
}

function validId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_RE.test(value) ? value : undefined
}

function validAmount(value: unknown): string | undefined {
  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    text = String(value)
  } else if (typeof value === 'string') {
    text = value.trim()
  } else {
    return undefined
  }
  text = text.replace(',', '.')
  if (!AMOUNT_RE.test(text)) return undefined
  return Number(text) > 0 ? text : undefined
}

function validCurrency(value: unknown): Currency | undefined {
  if (typeof value !== 'string') return undefined
  const upper = value.toUpperCase()
  return isCurrency(upper) ? upper : undefined
}

function validDescription(value: unknown): string | undefined {
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value)) {
    text = String(value)
  } else return undefined
  const trimmed = text.trim().slice(0, DESCRIPTION_MAX).trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * validateSearch for /transactions: types and sanitises the drawer params.
 * A valid `edit` id wins and is returned alone; the prefill params are read
 * only together with `add=expense`. Anything invalid or unknown is dropped.
 */
export function validateTransactionsSearch(
  search: Record<string, unknown>,
): TransactionsSearch {
  const edit = validId(search.edit)
  if (edit !== undefined) return { edit }
  if (search.add !== 'expense') return {}

  const result: TransactionsSearch = { add: 'expense' }
  const category = validId(search.category)
  if (category !== undefined) result.category = category
  const amount = validAmount(search.amount)
  if (amount !== undefined) result.amount = amount
  const currency = validCurrency(search.currency)
  if (currency !== undefined) result.currency = currency
  const description = validDescription(search.description)
  if (description !== undefined) result.description = description
  if (search.space === 'personal' || search.space === 'family') {
    result.space = search.space
  }
  return result
}

export function drawerInitialFromSearch(
  search: TransactionsSearch,
): ExpenseDrawerInitial {
  const initial: ExpenseDrawerInitial = {}
  if (search.category !== undefined) initial.categoryId = search.category
  if (search.amount !== undefined) initial.amount = search.amount
  if (search.currency !== undefined) initial.currency = search.currency
  if (search.description !== undefined) {
    initial.description = search.description
  }
  return initial
}
