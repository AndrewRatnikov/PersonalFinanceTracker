// Money display and main-currency helpers. Pure: no IndexedDB, no React.
//
// Amounts and conversions are stored unrounded; rounding to 2 decimals
// happens only here, for display. Every total in the app sums mainAmountOf().

import { plural } from '../i18n/core'
import type { Currency, EntryConversion } from './domain'

// The local calendar date of an ISO timestamp as YYYY-MM-DD (a machine date,
// whatever the UI language). Same rule as recurrence.toLocalDateString (kept
// local to avoid an import cycle, since recurrence formats its amounts with
// formatMoney).
function localDateOf(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Display formatting lives in src/i18n/format.ts (it follows the UI language);
// re-exported here so every existing import keeps working.
export { formatAmount, formatMoney, formatShortMoney, formatRate } from '../i18n/format'

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

// "1 entry waiting for exchange rates" / "3 entries waiting for exchange rates"
export function pendingLabel(count: number): string {
  return plural('common.pendingEntries', count)
}
