// National Bank of Ukraine official rates.
//
// GET {base}/NBUStatService/v1/statdirectory/exchange?json&date=YYYYMMDD
// returns `[{ r030, txt, rate, cc, exchangedate: 'DD.MM.YYYY', special }]`
// with rates in UAH per unit. Weekends and holidays have rates; future (and
// very old) dates return `[]`, so a date without a full set of rates steps
// back one day, at most NBU_MAX_LOOKBACK_DAYS dates in total.
//
// Only the date leaves the device: the request carries no credentials and no
// referrer. Each request is retried on 429 / 5xx / network errors with
// exponential backoff, and at most NBU_MAX_CONCURRENT requests run at once
// per provider. There is no cache here; callers keep one per run.

import { CURRENCIES } from '../domain'
import { RateUnavailableError } from './types'
import type { Currency } from '../domain'
import type { RateProvider, RateTable } from './types'

export const NBU_DEFAULT_BASE_URL = 'https://bank.gov.ua'
/** Dates requested at most: the date itself and the 6 days before it. */
export const NBU_MAX_LOOKBACK_DAYS = 7
export const NBU_MAX_CONCURRENT = 3
export const NBU_MAX_TRIES = 3

const DEFAULT_RETRY_DELAY_MS = 500
const BASE: Currency = 'UAH'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
  }
}

export interface NbuProviderOptions {
  fetchJson?: (url: string) => Promise<unknown>
  baseUrl?: string
  /** Delay before the 2nd try; doubles for each further try. Default 500. */
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

// 'YYYY-MM-DD' -> '{baseUrl}/NBUStatService/...&date=YYYYMMDD'
export function nbuRequestUrl(baseUrl: string, date: string): string {
  const compact = date.replace(/-/g, '')
  return `${baseUrl}/NBUStatService/v1/statdirectory/exchange?json&date=${compact}`
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!res.ok) throw new HttpError(res.status)
  return res.json()
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Date-only arithmetic in UTC so the device timezone can't shift the date.
function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const prev = new Date(Date.UTC(y, m - 1, d - 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`
}

// 'DD.MM.YYYY' -> 'YYYY-MM-DD'; null for anything else.
function parseExchangeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim())
  if (!match) return null
  return `${match[3]}-${match[2]}-${match[1]}`
}

function isUsableRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// A table only when the response has a usable rate for every currency in
// CURRENCIES (other than the base); otherwise null (step back).
function parseResponse(body: unknown, requested: string): RateTable | null {
  if (!Array.isArray(body)) return null
  const perBase: Partial<Record<Currency, number>> = { [BASE]: 1 }
  let effectiveDate: string | null = null
  for (const row of body as Array<unknown>) {
    if (!row || typeof row !== 'object') continue
    const { cc, rate, exchangedate } = row as Record<string, unknown>
    const code = CURRENCIES.find((c) => c === cc)
    if (!code || code === BASE) continue
    if (!isUsableRate(rate)) continue
    perBase[code] = rate
    effectiveDate ??= parseExchangeDate(exchangedate)
  }
  for (const code of CURRENCIES) {
    if (!isUsableRate(perBase[code])) return null
  }
  return { base: BASE, effectiveDate: effectiveDate ?? requested, perBase }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500
  return true
}

// Limits how many calls run at once; waiters are served in FIFO order.
function createSemaphore(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else {
      active++
    }
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      // The slot passes straight to the next waiter.
      if (next) next()
      else active--
    }
  }
}

export function createNbuProvider(options: NbuProviderOptions = {}): RateProvider {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const baseUrl = options.baseUrl ?? NBU_DEFAULT_BASE_URL
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = options.sleep ?? defaultSleep
  const limit = createSemaphore(NBU_MAX_CONCURRENT)

  async function request(date: string): Promise<unknown> {
    const url = nbuRequestUrl(baseUrl, date)
    for (let attempt = 1; ; attempt++) {
      try {
        return await limit(() => fetchJson(url))
      } catch (err) {
        if (!isRetryable(err) || attempt >= NBU_MAX_TRIES) {
          throw new RateUnavailableError(
            `NBU rates unavailable for ${date}: ${err instanceof Error ? err.message : String(err)}`,
            date,
          )
        }
        await sleep(retryDelayMs * 2 ** (attempt - 1))
      }
    }
  }

  return {
    id: 'nbu',
    async getRates(date: string): Promise<RateTable> {
      let current = date
      for (let i = 0; i < NBU_MAX_LOOKBACK_DAYS; i++) {
        const table = parseResponse(await request(current), current)
        if (table) return table
        current = previousDate(current)
      }
      throw new RateUnavailableError(
        `No NBU rates within ${NBU_MAX_LOOKBACK_DAYS} days of ${date}`,
        date,
      )
    },
  }
}
