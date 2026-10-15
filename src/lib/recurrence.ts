// Pure schedule maths for recurring items: occurrence dates, ask-mode
// bookkeeping, monthly totals and labels. No IndexedDB, no React.
//
// Every date here is a local calendar date written as YYYY-MM-DD. All
// arithmetic runs on those strings through Date.UTC / getUTC*, never by
// parsing a date as local time, so a timezone or a DST change can't shift a
// date. Only toLocalDateString and occurrenceCreatedAt depend on the device
// timezone, on purpose.
//
// Occurrence k (k = 0, 1, 2, …) is always computed from startDate, so month
// and year steps clamp to the end of a short month without drifting:
// Jan 31 monthly gives Feb 28, then Mar 31 again.

import { CURRENCIES } from './domain'
import { formatMoney } from './money'
import { crossRate } from './rates/types'
import type { RateTable } from './rates/types'
import type {
  Currency,
  RecurringItem,
  RecurringKind,
  RecurringOccurrence,
} from './domain'

type Schedule = Pick<RecurringItem, 'frequency' | 'startDate' | 'end'>

const DAY_MS = 24 * 60 * 60 * 1000

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

interface DateParts {
  y: number
  // 0-based month
  m: number
  d: number
}

function parseDate(date: string): DateParts {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m: m - 1, d }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatParts(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad(m + 1)}-${pad(d)}`
}

function dayNumber(date: string): number {
  const { y, m, d } = parseDate(date)
  return Math.round(Date.UTC(y, m, d) / DAY_MS)
}

function fromDayNumber(n: number): string {
  const date = new Date(n * DAY_MS)
  return formatParts(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  )
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

function intervalOf(s: Pick<RecurringItem, 'frequency'>): number {
  const n = Math.floor(s.frequency.interval)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

// ── Local-time helpers (TZ-dependent on purpose) ─────────────────────────────

// The local calendar date of `d` (default: now) as YYYY-MM-DD.
export function toLocalDateString(d: Date = new Date()): string {
  return formatParts(d.getFullYear(), d.getMonth(), d.getDate())
}

// The createdAt of a generated record: local noon of the occurrence date.
export function occurrenceCreatedAt(date: string): string {
  const { y, m, d } = parseDate(date)
  return new Date(y, m, d, 12).toISOString()
}

// ── Date-only arithmetic ──────────────────────────────────────────────────────

export function addDaysToDate(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days)
}

// Occurrence k of the schedule, ignoring the end rule.
function occurrenceAt(s: Schedule, k: number): string {
  const interval = intervalOf(s)
  const start = parseDate(s.startDate)
  switch (s.frequency.unit) {
    case 'day':
      return fromDayNumber(dayNumber(s.startDate) + k * interval)
    case 'week':
      return fromDayNumber(dayNumber(s.startDate) + 7 * k * interval)
    case 'month': {
      const total = start.m + k * interval
      const y = start.y + Math.floor(total / 12)
      const m = total % 12
      return formatParts(y, m, Math.min(start.d, daysInMonth(y, m)))
    }
    case 'year': {
      const y = start.y + k * interval
      return formatParts(y, start.m, Math.min(start.d, daysInMonth(y, start.m)))
    }
  }
}

// Whether occurrence k (on `date`) is still inside the schedule.
function withinEnd(s: Schedule, k: number, date: string): boolean {
  if (s.end.type === 'afterCount') return k < s.end.count
  if (s.end.type === 'onDate') return date <= s.end.date
  return true
}

// The smallest k whose occurrence is after `after` (0 for null). Jumps close
// to the answer with day/month arithmetic instead of walking from k = 0.
function firstIndexAfter(s: Schedule, after: string | null): number {
  if (after === null || after < s.startDate) return 0
  const interval = intervalOf(s)
  const start = parseDate(s.startDate)
  const target = parseDate(after)
  let k = 0
  switch (s.frequency.unit) {
    case 'day':
    case 'week': {
      const step = interval * (s.frequency.unit === 'week' ? 7 : 1)
      k = Math.floor((dayNumber(after) - dayNumber(s.startDate)) / step)
      break
    }
    case 'month': {
      const months = (target.y - start.y) * 12 + (target.m - start.m)
      k = Math.floor(months / interval) - 1
      break
    }
    case 'year':
      k = Math.floor((target.y - start.y) / interval) - 1
      break
  }
  k = Math.max(0, k)
  while (occurrenceAt(s, k) <= after) k++
  return k
}

// ── Schedule queries ──────────────────────────────────────────────────────────

// Occurrence dates in (afterExclusive, throughInclusive], in order. A null
// afterExclusive starts at startDate. Respects end.onDate (inclusive) and
// end.afterCount (counted from startDate).
export function occurrencesBetween(
  item: Schedule,
  afterExclusive: string | null,
  throughInclusive: string,
): Array<string> {
  const result: Array<string> = []
  for (let k = firstIndexAfter(item, afterExclusive); ; k++) {
    const date = occurrenceAt(item, k)
    if (date > throughInclusive || !withinEnd(item, k, date)) break
    result.push(date)
  }
  return result
}

export function nextOccurrence(
  item: Schedule,
  afterExclusive: string | null,
): string | null {
  const k = firstIndexAfter(item, afterExclusive)
  const date = occurrenceAt(item, k)
  return withinEnd(item, k, date) ? date : null
}

export function lastOccurrenceOnOrBefore(
  item: Schedule,
  date: string,
): string | null {
  const limit =
    item.end.type === 'onDate' && item.end.date < date ? item.end.date : date
  let k = firstIndexAfter(item, limit) - 1
  if (item.end.type === 'afterCount') k = Math.min(k, item.end.count - 1)
  if (k < 0) return null
  return occurrenceAt(item, k)
}

// The first occurrence after handledThrough that isn't in handledAhead.
export function nextUnhandledOccurrence(item: RecurringItem): string | null {
  const ahead = new Set(item.handledAhead)
  let after = item.handledThrough
  for (;;) {
    const next = nextOccurrence(item, after)
    if (next === null || !ahead.has(next)) return next
    after = next
  }
}

// Marks one occurrence handled (created, confirmed or skipped). The next
// occurrence advances handledThrough, then past any following dates already
// in handledAhead; a later date goes into handledAhead. Pure: updatedAt is
// left to the caller.
export function markOccurrenceHandled(
  item: RecurringItem,
  date: string,
): RecurringItem {
  const ahead = item.handledAhead.filter((d) => d !== date)
  const occurrenceCount = item.occurrenceCount + 1
  if (nextOccurrence(item, item.handledThrough) === date) {
    const aheadSet = new Set(ahead)
    let handledThrough = date
    for (;;) {
      const next = nextOccurrence(item, handledThrough)
      if (next === null || !aheadSet.has(next)) break
      handledThrough = next
    }
    return {
      ...item,
      handledThrough,
      handledAhead: ahead.filter((d) => d > handledThrough),
      occurrenceCount,
    }
  }
  return {
    ...item,
    handledAhead: Array.from(new Set([...ahead, date])).sort(),
    occurrenceCount,
  }
}

function byDate(a: RecurringOccurrence, b: RecurringOccurrence): number {
  return a.occurrenceDate.localeCompare(b.occurrenceDate)
}

// Due, unhandled occurrences of active ask-mode items, oldest first.
export function dueOccurrences(
  items: Array<RecurringItem>,
  today: string,
): Array<RecurringOccurrence> {
  const result: Array<RecurringOccurrence> = []
  for (const item of items) {
    if (item.mode !== 'ask' || item.paused) continue
    const ahead = new Set(item.handledAhead)
    for (const date of occurrencesBetween(item, item.handledThrough, today)) {
      if (!ahead.has(date)) result.push({ item, occurrenceDate: date })
    }
  }
  return result.sort(byDate)
}

// Occurrences of active items in (today, today + days], soonest first.
export function upcomingOccurrences(
  items: Array<RecurringItem>,
  today: string,
  options: { days?: number; limit?: number } = {},
): Array<RecurringOccurrence> {
  const days = options.days ?? 7
  const limit = options.limit ?? 5
  const through = addDaysToDate(today, days)
  const result: Array<RecurringOccurrence> = []
  for (const item of items) {
    if (item.paused) continue
    const after =
      item.handledThrough !== null && item.handledThrough > today
        ? item.handledThrough
        : today
    const ahead = new Set(item.handledAhead)
    for (const date of occurrencesBetween(item, after, through)) {
      if (!ahead.has(date)) result.push({ item, occurrenceDate: date })
    }
  }
  return result.sort(byDate).slice(0, limit)
}

// ── Totals and labels ─────────────────────────────────────────────────────────

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

export function monthlyEquivalent(
  item: Pick<RecurringItem, 'amount' | 'frequency'>,
): number {
  const interval = intervalOf(item)
  switch (item.frequency.unit) {
    case 'day':
      return round2((item.amount * 365) / 12 / interval)
    case 'week':
      return round2((item.amount * 52) / 12 / interval)
    case 'month':
      return round2(item.amount / interval)
    case 'year':
      return round2(item.amount / (12 * interval))
  }
}

const KINDS: ReadonlyArray<RecurringKind> = ['expense', 'income']

// Per (kind, currency) monthly totals of active items (not paused, with an
// occurrence on or after today). Expenses first, currencies in CURRENCIES
// order; currencies are never mixed.
export function monthlyTotals(
  items: Array<RecurringItem>,
  today: string,
): Array<{ kind: RecurringKind; currency: Currency; total: number }> {
  const sums = new Map<string, number>()
  const yesterday = addDaysToDate(today, -1)
  for (const item of items) {
    if (item.paused) continue
    if (nextOccurrence(item, yesterday) === null) continue
    const key = `${item.kind}:${item.currency}`
    sums.set(key, (sums.get(key) ?? 0) + monthlyEquivalent(item))
  }
  const result: Array<{
    kind: RecurringKind
    currency: Currency
    total: number
  }> = []
  for (const kind of KINDS) {
    for (const currency of CURRENCIES) {
      const sum = sums.get(`${kind}:${currency}`)
      if (sum !== undefined) result.push({ kind, currency, total: round2(sum) })
    }
  }
  return result
}

// One monthly total per kind in the main currency (expenses first, only kinds
// with active items). Items in another currency are converted at today's
// `rates` and make their kind `approximate`. Null when an active item needs a
// rate that `rates` doesn't have (the caller falls back to monthlyTotals).
export function monthlyTotalsInMain(
  items: Array<RecurringItem>,
  today: string,
  mainCurrency: Currency,
  rates: RateTable | null,
): Array<{ kind: RecurringKind; total: number; approximate: boolean }> | null {
  const sums = new Map<RecurringKind, { total: number; approximate: boolean }>()
  const yesterday = addDaysToDate(today, -1)
  for (const item of items) {
    if (item.paused) continue
    if (nextOccurrence(item, yesterday) === null) continue
    let rate = 1
    const converted = item.currency !== mainCurrency
    if (converted) {
      if (!rates) return null
      try {
        rate = crossRate(rates, item.currency, mainCurrency)
      } catch {
        return null
      }
    }
    const sum = sums.get(item.kind) ?? { total: 0, approximate: false }
    sum.total += monthlyEquivalent(item) * rate
    sum.approximate ||= converted
    sums.set(item.kind, sum)
  }
  const result: Array<{
    kind: RecurringKind
    total: number
    approximate: boolean
  }> = []
  for (const kind of KINDS) {
    const sum = sums.get(kind)
    if (sum) result.push({ kind, total: sum.total, approximate: sum.approximate })
  }
  return result
}

function ordinal(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

// "Every day", "Every 2 weeks", "Every month on the 31st", "Every year on Mar 1".
export function describeFrequency(
  item: Pick<RecurringItem, 'frequency' | 'startDate'>,
): string {
  const interval = intervalOf(item)
  const { m, d } = parseDate(item.startDate)
  const every = (singular: string) =>
    interval === 1 ? `Every ${singular}` : `Every ${interval} ${singular}s`
  switch (item.frequency.unit) {
    case 'day':
      return every('day')
    case 'week':
      return every('week')
    case 'month':
      return `${every('month')} on the ${ordinal(d)}`
    case 'year':
      return `${every('year')} on ${MONTH_NAMES[m]} ${d}`
  }
}

export function formatRecurringAmount(
  amount: number,
  currency: Currency,
): string {
  return formatMoney(amount, currency)
}

export function recurringCreatedMessage(count: number): string {
  return count === 1
    ? 'Added 1 recurring transaction'
    : `Added ${count} recurring transactions`
}
