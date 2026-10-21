// Human text for a recurring schedule, one function per language (each has its
// own grammar), plus a dispatcher on the UI language.

import { getLang } from './core'
import type { Lang } from './lang'
import type { RecurringItem } from '../lib/domain'

type FrequencyItem = Pick<RecurringItem, 'frequency' | 'startDate'>

function intervalOf(item: FrequencyItem): number {
  const n = Math.floor(item.frequency.interval)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

// Month (0-based) and day of a YYYY-MM-DD date, without timezone parsing.
function monthAndDay(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m: m - 1, d }
}

// ── English ──────────────────────────────────────────────────────────────────

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
export function describeFrequencyEn(item: FrequencyItem): string {
  const interval = intervalOf(item)
  const { m, d } = monthAndDay(item.startDate)
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

// ── Ukrainian ────────────────────────────────────────────────────────────────

interface UkUnit {
  // "Щодня", "Щотижня", ... for an interval of 1
  each: string
  // noun forms after a number: 1 (21, 31 …), 2–4 (22–24 …), 5+ (11–14 …)
  one: string
  few: string
  many: string
}

const UK_UNITS: Record<RecurringItem['frequency']['unit'], UkUnit> = {
  day: { each: 'Щодня', one: 'день', few: 'дні', many: 'днів' },
  week: { each: 'Щотижня', one: 'тиждень', few: 'тижні', many: 'тижнів' },
  month: { each: 'Щомісяця', one: 'місяць', few: 'місяці', many: 'місяців' },
  year: { each: 'Щороку', one: 'рік', few: 'роки', many: 'років' },
}

const ukPluralRules = new Intl.PluralRules('uk-UA')

// "Кожен 21 день", "Кожні 3 дні", "Кожні 5 днів"
function ukEvery(interval: number, unit: UkUnit): string {
  if (interval === 1) return unit.each
  switch (ukPluralRules.select(interval)) {
    case 'one':
      return `Кожен ${interval} ${unit.one}`
    case 'few':
      return `Кожні ${interval} ${unit.few}`
    default:
      return `Кожні ${interval} ${unit.many}`
  }
}

// "1 березня": the day and the genitive month name.
function ukDayAndMonth(y: number, m: number, d: number): string {
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long' }).format(
    new Date(y, m, d, 12),
  )
}

// "Щодня", "Кожні 2 тижні", "Щомісяця, 31-го", "Щороку, 1 березня".
export function describeFrequencyUk(item: FrequencyItem): string {
  const interval = intervalOf(item)
  const unit = item.frequency.unit
  const every = ukEvery(interval, UK_UNITS[unit])
  const { y, m, d } = monthAndDay(item.startDate)
  switch (unit) {
    case 'day':
    case 'week':
      return every
    case 'month':
      return `${every}, ${d}-го`
    case 'year':
      return `${every}, ${ukDayAndMonth(y, m, d)}`
  }
}

export function describeFrequency(item: FrequencyItem, lang: Lang = getLang()): string {
  return lang === 'uk' ? describeFrequencyUk(item) : describeFrequencyEn(item)
}
