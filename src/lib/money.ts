// Money display and main-currency helpers. Pure: no IndexedDB, no React.
//
// Amounts and conversions are stored unrounded; rounding to 2 decimals
// happens only here, for display. Every total in the app sums mainAmountOf().

import type { Currency, EntryConversion } from './domain'

// The local calendar date of an ISO timestamp as YYYY-MM-DD. Same rule as
// recurrence.toLocalDateString (kept local to avoid an import cycle, since
// recurrence formats its amounts with formatMoney).
function localDateOf(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatAmount(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// "830.40 UAH" (en-US) / "830,40 UAH" (uk-UA)
export function formatMoney(value: number, currency: Currency): string {
  return `${formatAmount(value)} ${currency}`
}

export function formatRate(rate: number): string {
  return rate.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

// The stored definition: converted iff the stored conversion is for `main`.
export function isConverted(
  entry: { conversion?: EntryConversion },
  main: Currency,
): boolean {
  return entry.conversion?.mainCurrency === main
}

// The entry's amount in `main`: the stored conversion, else the amount itself
// when the entry is already in `main`, else null (pending, left out of totals).
export function mainAmountOf(
  entry: { amount: number; currency: Currency; conversion?: EntryConversion },
  main: Currency,
): number | null {
  if (entry.conversion?.mainCurrency === main) return entry.conversion.mainAmount
  if (entry.currency === main) return Number(entry.amount)
  return null
}

export function identityConversion(
  entry: { amount: number; createdAt: string },
  main: Currency,
): EntryConversion {
  return {
    mainCurrency: main,
    rate: 1,
    mainAmount: entry.amount,
    rateDate: localDateOf(entry.createdAt),
    source: 'identity',
  }
}

export function pendingLabel(count: number): string {
  return count === 1
    ? '1 entry waiting for exchange rates'
    : `${count} entries waiting for exchange rates`
}
