// The single number / money / date formatting module. Everything follows the
// UI language (getLang()) unless a language is passed, never the device locale.
// Machine formats (YYYY-MM-DD for storage, CSV, URLs, file names) stay on dayjs
// in their own modules and never come through here.

import dayjs from 'dayjs'

import { getLang, localeOf } from './core'
import type { Lang } from './lang'
import type { Currency } from '../lib/domain'

type DateInput = Date | string | number

function toDate(input: DateInput): Date {
  return dayjs(input).toDate()
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  lang: Lang = getLang(),
): string {
  return new Intl.NumberFormat(localeOf(lang), options).format(value)
}

// Always 2 decimals: "1,234.50" (en) / "1 234,50" (uk).
export function formatAmount(value: number, lang: Lang = getLang()): string {
  return formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }, lang)
}

// Ukrainian shows the hryvnia as "грн"; every other case keeps the code.
export function currencyLabel(currency: Currency, lang: Lang = getLang()): string {
  return lang === 'uk' && currency === 'UAH' ? 'грн' : currency
}

// "1,234.50 UAH" (en) / "1 234,50 грн", "20,00 USD" (uk)
export function formatMoney(value: number, currency: Currency, lang: Lang = getLang()): string {
  return `${formatAmount(value, lang)} ${currencyLabel(currency, lang)}`
}

// "65 UAH" / "65 грн" for whole numbers, "12.50 USD" / "12,50 USD" otherwise.
// Used for short hints, chips, chart ticks and toasts.
export function formatShortMoney(
  amount: number,
  currency: Currency,
  lang: Lang = getLang(),
): string {
  const digits = Number.isInteger(amount) ? 0 : 2
  const text = formatNumber(
    amount,
    { minimumFractionDigits: digits, maximumFractionDigits: digits },
    lang,
  )
  return `${text} ${currencyLabel(currency, lang)}`
}

// Up to 4 fraction digits: "41.52" / "41,52".
export function formatRate(rate: number, lang: Lang = getLang()): string {
  return formatNumber(rate, { maximumFractionDigits: 4 }, lang)
}

// "Oct 14" / "14 жовт."
export function formatDay(date: DateInput, lang: Lang = getLang()): string {
  return new Intl.DateTimeFormat(localeOf(lang), { day: 'numeric', month: 'short' }).format(
    toDate(date),
  )
}

// "October 2026" / "жовтень 2026" (without the Ukrainian "р.")
export function formatMonth(date: DateInput, lang: Lang = getLang()): string {
  const parts = new Intl.DateTimeFormat(localeOf(lang), {
    month: 'long',
    year: 'numeric',
  }).formatToParts(toDate(date))
  const month = parts.find((p) => p.type === 'month')?.value ?? ''
  const year = parts.find((p) => p.type === 'year')?.value ?? ''
  return `${month} ${year}`
}

// Chart axes: "Oct '26" / "жовт. '26"
export function formatShortMonth(date: DateInput, lang: Lang = getLang()): string {
  const d = toDate(date)
  const month = new Intl.DateTimeFormat(localeOf(lang), { month: 'short' }).format(d)
  const year = String(d.getFullYear() % 100).padStart(2, '0')
  return `${month} '${year}`
}

// "Oct 14, 2026" / "14 жовт. 2026 р."
export function formatFullDate(date: DateInput, lang: Lang = getLang()): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(toDate(date))
}

// "09:05 AM" (en, ASCII space) / "09:05" (uk, 24-hour clock)
export function formatTime(date: DateInput, lang: Lang = getLang()): string {
  const d = toDate(date)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours = d.getHours()
  const minutes = pad(d.getMinutes())
  if (lang === 'uk') return `${pad(hours)}:${minutes}`
  const hours12 = hours % 12 === 0 ? 12 : hours % 12
  return `${pad(hours12)}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
}
