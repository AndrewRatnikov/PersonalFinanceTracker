// Exchange rate provider contract. A provider turns a local calendar date
// into a table of rates against one base currency. Nothing here talks to the
// network; see nbu.ts for the National Bank of Ukraine implementation and
// index.ts for the single swap point.

import type { Currency } from '../domain'

export interface RateTable {
  /** The currency every rate is expressed in (1 unit of X = perBase[X] base). */
  base: Currency
  /** YYYY-MM-DD of the rates actually used (may be earlier than requested). */
  effectiveDate: string
  perBase: Partial<Record<Currency, number>>
}

export interface RateProvider {
  /** Stored as `conversion.source`. */
  id: string
  /** Rates for the local date `date` (YYYY-MM-DD). Rejects when unavailable. */
  getRates: (date: string) => Promise<RateTable>
}

export class RateUnavailableError extends Error {
  readonly date?: string
  constructor(message: string, date?: string) {
    super(message)
    this.name = 'RateUnavailableError'
    this.date = date
  }
}

function usableRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// 1 unit of `from` expressed in `to`, through the table's base currency.
export function crossRate(rates: RateTable, from: Currency, to: Currency): number {
  const fromRate = rates.perBase[from]
  const toRate = rates.perBase[to]
  if (!usableRate(fromRate) || !usableRate(toRate)) {
    throw new RateUnavailableError(
      `No usable rate for ${from} → ${to} on ${rates.effectiveDate}`,
      rates.effectiveDate,
    )
  }
  if (from === to) return 1
  return fromRate / toRate
}
