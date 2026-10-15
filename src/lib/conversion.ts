// Background conversion of entries into the main currency (spec §15).
//
// convertPending() reads every stored entry, converts the pending ones
// (identity and manual rates need no network; the rest use the rate provider
// for the entry's local date, each date fetched once per run) and writes back
// only the `conversion` field, chunk by chunk, under the write lock
// (localDb.applyEntryConversions). It never throws for missing rates: such
// entries simply stay pending. A DecryptError propagates.
//
// Runs are coalesced per tab: requestConversion() starts a run, or schedules
// exactly one follow-up while one is running. startAutoConversion() (mounted
// by ConversionRunner) requests a run whenever localDb commits an entry write
// and when the browser comes back online.

import { getCurrencySettings } from './appSettings'
import { isDecryptError } from './dataErrors'
import { reportDataProblem } from './dataProblem'
import {
  applyEntryConversions,
  convertBudgets,
  getAllBudgets,
  getLocalDbKey,
  onConversionNeeded,
  readEntriesForConversion,
} from './localDb'
import { identityConversion, isConverted, mainAmountOf } from './money'
import { crossRate, rateProvider } from './rates'
import { toLocalDateString } from './recurrence'
import type { Currency, EntryConversion, Expense, IncomeEntry } from './domain'
import type { EntryConversionUpdate } from './localDb'
import type { RateProvider, RateTable } from './rates'

export const CONVERSION_STATUS_QUERY_KEY = ['conversion-status'] as const

export interface ConvertProgress {
  done: number
  total: number
}

export interface ConvertResult {
  converted: number
  stillPending: number
}

export interface ConvertOptions {
  signal?: AbortSignal
  onProgress?: (progress: ConvertProgress) => void
  /** Defaults to the app's rateProvider. */
  provider?: RateProvider
  /** Local date (YYYY-MM-DD) used for today's rates; defaults to now. */
  today?: string
}

export interface ConversionStatus {
  mainCurrency: Currency
  fetchExchangeRates: boolean
  totalEntries: number
  /** Entries without a usable main-currency amount. */
  pendingEntries: number
  /** Budgets not in the main currency. */
  pendingBudgets: number
}

export interface ChangeMainCurrencyResult {
  converted: number
  stillPending: number
  budgetsConverted: number
  rateDate: string | null
}

export type MainCurrencyChangeErrorCode =
  | 'offline'
  | 'rates-off'
  | 'rates-unavailable'

const CHANGE_ERROR_MESSAGES: Record<MainCurrencyChangeErrorCode, string> = {
  offline: "You're offline. Connect to the internet to change the main currency.",
  'rates-off':
    'Turn on exchange rates from the National Bank of Ukraine to change the main currency.',
  'rates-unavailable':
    "Couldn't get today's exchange rates from the National Bank of Ukraine. Try again later.",
}

export class MainCurrencyChangeError extends Error {
  readonly code: MainCurrencyChangeErrorCode
  constructor(code: MainCurrencyChangeErrorCode) {
    super(CHANGE_ERROR_MESSAGES[code])
    this.name = 'MainCurrencyChangeError'
    this.code = code
  }
}

type Entry = Expense | IncomeEntry

// ── Subscribers ───────────────────────────────────────────────────────────────

const subscribers = new Set<() => void>()

// Called after each committed batch, after a committed main-currency change
// and at the end of every run.
export function subscribeConversion(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

function notify(): void {
  for (const listener of Array.from(subscribers)) {
    try {
      listener()
    } catch (err) {
      console.error('Conversion subscriber failed:', err)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function localDateOf(iso: string): string {
  return toLocalDateString(new Date(iso))
}

// Rates fetched in this run only: each date is requested once.
type RunRates = Map<string, Promise<RateTable>>

function ratesFor(
  cache: RunRates,
  provider: RateProvider,
  date: string,
): Promise<RateTable> {
  let pending = cache.get(date)
  if (!pending) {
    pending = provider.getRates(date)
    // Failures are handled by whoever awaits; never an unhandled rejection.
    pending.catch(() => undefined)
    cache.set(date, pending)
  }
  return pending
}

function updateFor(entry: Entry, conversion: EntryConversion): EntryConversionUpdate {
  return {
    id: entry.id,
    amount: entry.amount,
    currency: entry.currency,
    createdAt: entry.createdAt,
    conversion,
  }
}

// The conversions of one group that need no network: identity and a manual
// rate for the current main currency.
function offlineConversion(entry: Entry, main: Currency): EntryConversion | null {
  if (entry.currency === main) return identityConversion(entry, main)
  if (
    entry.manualRate?.mainCurrency === main &&
    Number.isFinite(entry.manualRate.rate) &&
    entry.manualRate.rate > 0
  ) {
    const rate = entry.manualRate.rate
    return {
      mainCurrency: main,
      rate,
      mainAmount: entry.amount * rate,
      rateDate: localDateOf(entry.createdAt),
      source: 'manual',
    }
  }
  return null
}

// ── convertPending ────────────────────────────────────────────────────────────

export async function convertPending(
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const { signal, onProgress } = options
  const provider = options.provider ?? rateProvider
  const today = options.today ?? toLocalDateString()
  if (!getLocalDbKey()) return { converted: 0, stillPending: 0 }

  const settings = await getCurrencySettings()
  const main = settings.mainCurrency
  const canFetch = settings.fetchExchangeRates && !isOffline()

  const groups = await readEntriesForConversion()
  const pendingGroups = groups
    .map((g) => ({
      storageKey: g.storageKey,
      records: g.records.filter((r) => !isConverted(r, main)),
    }))
    .filter((g) => g.records.length > 0)
  const total = pendingGroups.reduce((n, g) => n + g.records.length, 0)
  let done = 0
  let converted = 0
  let aborted = false
  onProgress?.({ done, total })

  const cache: RunRates = new Map()

  for (const group of pendingGroups) {
    if (signal?.aborted || !getLocalDbKey()) {
      aborted = true
      break
    }
    const updates: Array<EntryConversionUpdate> = []
    const needRates = new Map<string, Array<Entry>>()
    for (const record of group.records) {
      const offline = offlineConversion(record, main)
      if (offline) {
        updates.push(updateFor(record, offline))
        continue
      }
      if (!canFetch) continue
      const date = localDateOf(record.createdAt)
      const list = needRates.get(date) ?? []
      list.push(record)
      needRates.set(date, list)
    }

    const fetched = await Promise.all(
      Array.from(needRates.entries()).map(async ([date, records]) => {
        try {
          const rates = await ratesFor(cache, provider, date)
          const out: Array<EntryConversionUpdate> = []
          for (const record of records) {
            try {
              const rate = crossRate(rates, record.currency, main)
              out.push(
                updateFor(record, {
                  mainCurrency: main,
                  rate,
                  mainAmount: record.amount * rate,
                  rateDate: rates.effectiveDate,
                  source: provider.id,
                }),
              )
            } catch {
              // No usable rate for this currency: stays pending.
            }
          }
          return out
        } catch {
          // Rates unavailable for this date: its records stay pending.
          return []
        }
      }),
    )
    for (const list of fetched) updates.push(...list)

    if (signal?.aborted) {
      aborted = true
      break
    }
    if (updates.length > 0) {
      converted += await applyEntryConversions(group.storageKey, main, updates)
      notify()
    }
    done += group.records.length
    onProgress?.({ done, total })
  }

  // One-time fix: budgets saved in another currency are converted at today's
  // rate (only while the stored main currency is still `main`).
  if (!aborted && canFetch && !signal?.aborted && getLocalDbKey()) {
    const budgets = await getAllBudgets()
    if (budgets.some((b) => b.currency !== main)) {
      try {
        const rates = await ratesFor(cache, provider, today)
        const count = await convertBudgets(
          main,
          (from) => crossRate(rates, from, main),
          { setMainCurrency: false },
        )
        if (count > 0) notify()
      } catch (err) {
        if (isDecryptError(err)) throw err
        // Rates unavailable: the budgets stay as they are until a later run.
      }
    }
  }

  return { converted, stillPending: total - converted }
}

// ── Coalesced background runs ─────────────────────────────────────────────────

// The run in flight (never rejects) and the single queued follow-up.
let active: Promise<void> | null = null
let followUp: Promise<void> | null = null

// Starts `task` as the active run. Subscribers are notified at the end of
// every run, before the returned promise settles; the queue marker itself
// never rejects.
function startExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = (async () => {
    try {
      return await task()
    } finally {
      notify()
    }
  })()
  const marker: Promise<void> = run
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (active === marker) active = null
    })
  active = marker
  return run
}

async function backgroundRun(): Promise<void> {
  try {
    await convertPending()
  } catch (err) {
    if (isDecryptError(err)) reportDataProblem(err)
    else console.error('Converting entries to the main currency failed:', err)
  }
}

// Requests a background run. At most one run at a time per tab; requests made
// during a run share exactly one follow-up run. Never rejects.
export function requestConversion(): Promise<void> {
  if (followUp) return followUp
  if (active) {
    const after = active
    const next: Promise<void> = after.then(() => {
      if (followUp === next) followUp = null
      return startExclusive(backgroundRun)
    })
    followUp = next
    return next
  }
  return startExclusive(backgroundRun)
}

// Resolves once no run is active or queued.
export async function whenConversionIdle(): Promise<void> {
  while (active || followUp) {
    await (followUp ?? active)
  }
}

// Waits for the queue to drain, then runs `task` as the active run (requests
// made meanwhile queue behind it).
async function runExclusively<T>(task: () => Promise<T>): Promise<T> {
  await whenConversionIdle()
  return startExclusive(task)
}

// Converts on every committed entry write in this tab and when the browser
// comes back online. Returns the cleanup.
export function startAutoConversion(): () => void {
  const stopListening = onConversionNeeded(() => {
    void requestConversion()
  })
  const onOnline = () => {
    void requestConversion()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
  }
  return () => {
    stopListening()
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
    }
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function getConversionStatus(): Promise<ConversionStatus> {
  const settings = await getCurrencySettings()
  const main = settings.mainCurrency
  const groups = await readEntriesForConversion()
  let totalEntries = 0
  let pendingEntries = 0
  for (const group of groups) {
    for (const record of group.records) {
      totalEntries++
      if (mainAmountOf(record, main) === null) pendingEntries++
    }
  }
  const budgets = await getAllBudgets()
  return {
    mainCurrency: main,
    fetchExchangeRates: settings.fetchExchangeRates,
    totalEntries,
    pendingEntries,
    pendingBudgets: budgets.filter((b) => b.currency !== main).length,
  }
}

// ── Main-currency change ──────────────────────────────────────────────────────

// Converts the budgets at today's rate and stores `next` as the main currency
// in one locked step, then recalculates every entry. Refuses, before writing
// anything, when a rate is needed and can't be had.
export async function changeMainCurrency(
  next: Currency,
  options: ConvertOptions = {},
): Promise<ChangeMainCurrencyResult> {
  const settings = await getCurrencySettings()
  if (settings.mainCurrency === next) {
    return { converted: 0, stillPending: 0, budgetsConverted: 0, rateDate: null }
  }
  const provider = options.provider ?? rateProvider
  const today = options.today ?? toLocalDateString()

  const budgets = await getAllBudgets()
  const groups = await readEntriesForConversion()
  const needsRate =
    budgets.some((b) => b.currency !== next) ||
    groups.some((g) =>
      g.records.some(
        (r) => r.currency !== next && r.manualRate?.mainCurrency !== next,
      ),
    )

  let todayRates: RateTable | null = null
  if (needsRate) {
    if (isOffline()) throw new MainCurrencyChangeError('offline')
    if (!settings.fetchExchangeRates) {
      throw new MainCurrencyChangeError('rates-off')
    }
    try {
      todayRates = await provider.getRates(today)
      for (const b of budgets) crossRate(todayRates, b.currency, next)
    } catch {
      throw new MainCurrencyChangeError('rates-unavailable')
    }
  }

  const rates = todayRates
  const budgetsConverted = await convertBudgets(
    next,
    (from) => {
      if (!rates) throw new MainCurrencyChangeError('rates-unavailable')
      return crossRate(rates, from, next)
    },
    { setMainCurrency: true },
  )
  notify()

  const result = await runExclusively(() => convertPending({ ...options }))
  return {
    converted: result.converted,
    stillPending: result.stillPending,
    budgetsConverted,
    rateDate: todayRates?.effectiveDate ?? null,
  }
}
