export type Currency = 'UAH' | 'USD' | 'EUR'

export const CURRENCIES = [
  'UAH',
  'USD',
  'EUR',
] as const satisfies ReadonlyArray<Currency>

/** The main currency until the user picks another one in Settings → General. */
export const DEFAULT_MAIN_CURRENCY: Currency = 'UAH'

export function isCurrency(value: unknown): value is Currency {
  return CURRENCIES.some((c) => c === value)
}

/**
 * An entry's amount converted into the main currency, stored unrounded.
 * The entry counts as converted only while `mainCurrency` equals the current
 * main currency.
 */
export interface EntryConversion {
  mainCurrency: Currency
  /** 1 unit of the entry's currency in the main currency. */
  rate: number
  /** amount × rate, unrounded. */
  mainAmount: number
  /** YYYY-MM-DD of the rate actually used. */
  rateDate: string
  /** Provider id (e.g. 'nbu'), 'manual' or 'identity'. */
  source: string
}

/** A user-entered rate for one main currency; ignored for any other. */
export interface ManualRate {
  mainCurrency: Currency
  rate: number
}

export interface Category {
  id: string
  name: string
  icon?: string | null
  /** ISO timestamp of the last create/update. */
  updatedAt?: string
  /** Preselected currency when this category is chosen; absent = main currency. */
  defaultCurrency?: Currency
  /** ISO time of the soft delete; a record with it is a tombstone (see isLive). */
  deletedAt?: string
  /** Local change sequence number (meta:sync); never leaves the device. */
  rev?: number
}

export interface Expense {
  id: string
  amount: number
  currency: Currency
  categoryId: string
  description?: string | null
  createdAt: string
  /** ISO timestamp of the last create/update. */
  updatedAt?: string
  /** Id of the recurring item that generated this record. */
  recurringId?: string
  /** Local calendar date (YYYY-MM-DD) of the occurrence it was generated for. */
  occurrenceDate?: string
  /** Stored conversion into the main currency; absent = pending. */
  conversion?: EntryConversion
  manualRate?: ManualRate
  /** ISO time of the soft delete; a record with it is a tombstone (see isLive). */
  deletedAt?: string
  /** Local change sequence number (meta:sync); never leaves the device. */
  rev?: number
  category?: Category
}

export interface MonthlyExpenseSummary {
  month: string
  year: string
  /**
   * Label to show on the chart X axis (e.g. 'Jan').
   */
  name: string
  /**
   * Total amount spent for the given month.
   */
  total: number
}

export interface CategoryBreakdownItem {
  categoryId: string
  name: string
  icon?: string | null
  /**
   * Total amount spent in this category for the selected range.
   */
  total: number
}

export interface AnalyticsTimelinePoint {
  /**
   * ISO date string (YYYY-MM-DD) representing the day bucket.
   */
  date: string
  /**
   * Human-friendly label for charts, e.g. `03 Feb`.
   */
  label: string
  total: number
}

export interface BudgetEntry {
  id: string
  categoryId: string
  monthlyLimit: number
  currency: Currency
  /** ISO timestamp of the last create/update. */
  updatedAt?: string
  /** ISO time of the soft delete; a record with it is a tombstone (see isLive). */
  deletedAt?: string
  /** Local change sequence number (meta:sync); never leaves the device. */
  rev?: number
}

export interface UpsertBudgetInput {
  categoryId: string
  monthlyLimit: number
  currency: Currency
}

export interface BudgetVarianceItem {
  categoryId: string
  name: string
  icon?: string | null
  budget: number
  actual: number
  overBudget: boolean
}

export interface AnalyticsRangeSummary {
  /**
   * ISO datetime string for the inclusive range start.
   */
  from: string
  /**
   * ISO datetime string for the inclusive range end.
   */
  to: string
  categoryBreakdown: Array<CategoryBreakdownItem>
  timeline: Array<AnalyticsTimelinePoint>
  totalIncome: number
  budgetVariance: Array<BudgetVarianceItem>
  /** Income in the main currency grouped by income category, total desc. */
  incomeBreakdown: Array<CategoryBreakdownItem>
}

export interface CreateExpenseInput {
  amount: number
  currency: Currency
  categoryId: string
  description?: string
  createdAt?: string
}

export interface IncomeEntry {
  id: string
  /** Id of an income category (storage key `incomeCategories`). */
  categoryId: string
  /**
   * Legacy free text. Read only for conversion and as a display fallback;
   * never written by new or updated records.
   */
  source?: string
  amount: number
  currency: Currency
  description?: string | null
  createdAt: string
  /** ISO timestamp of the last create/update. */
  updatedAt?: string
  /** Id of the recurring item that generated this record. */
  recurringId?: string
  /** Local calendar date (YYYY-MM-DD) of the occurrence it was generated for. */
  occurrenceDate?: string
  /** Stored conversion into the main currency; absent = pending. */
  conversion?: EntryConversion
  manualRate?: ManualRate
  /** ISO time of the soft delete; a record with it is a tombstone (see isLive). */
  deletedAt?: string
  /** Local change sequence number (meta:sync); never leaves the device. */
  rev?: number
  /** Joined at read time by getAllIncome()/addIncome(); never stored. */
  category?: Category
}

export interface CreateIncomeInput {
  categoryId: string
  amount: number
  currency: Currency
  description?: string
  createdAt?: string
}

export interface CreateCategoryInput {
  name: string
  icon?: string | null
}

export interface UpdateCategoryInput {
  id: string
  name: string
  icon?: string | null
  /** undefined = keep, null = remove, Currency = set. */
  defaultCurrency?: Currency | null
}

export interface UpdateExpenseInput {
  amount?: number
  currency?: Currency
  categoryId?: string
  description?: string
  createdAt?: string
}

// ── Recurring items (storage key `recurring`) ────────────────────────────────

export type RecurringKind = 'expense' | 'income'

export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'

export interface RecurringFrequency {
  unit: RecurrenceUnit
  /** >= 1 */
  interval: number
}

export type RecurringEnd =
  | { type: 'never' }
  | { type: 'onDate'; date: string }
  | { type: 'afterCount'; count: number }

/** auto = create when due; ask = show as "Due" until confirmed or skipped. */
export type RecurringMode = 'auto' | 'ask'

export interface RecurringItem {
  id: string
  kind: RecurringKind
  amount: number
  currency: Currency
  /** Expense category or income category, by kind. */
  categoryId: string
  description: string | null
  frequency: RecurringFrequency
  /** Local calendar date, YYYY-MM-DD. */
  startDate: string
  end: RecurringEnd
  mode: RecurringMode
  paused: boolean
  /** Last occurrence date that is fully handled (created, confirmed or skipped). */
  handledThrough: string | null
  /**
   * Ask mode: occurrences after handledThrough already handled out of order;
   * pruned as handledThrough advances.
   */
  handledAhead: Array<string>
  /** Occurrences handled so far. */
  occurrenceCount: number
  createdAt: string
  updatedAt: string
  /** ISO time of the soft delete; a record with it is a tombstone (see isLive). */
  deletedAt?: string
  /** Local change sequence number (meta:sync); never leaves the device. */
  rev?: number
}

export interface CreateRecurringInput {
  kind: RecurringKind
  amount: number
  currency: Currency
  categoryId: string
  description?: string | null
  frequency: RecurringFrequency
  startDate: string
  end: RecurringEnd
  mode: RecurringMode
}

export type UpdateRecurringInput = Partial<CreateRecurringInput>

export interface RecurringOccurrence {
  item: RecurringItem
  occurrenceDate: string
}

export type QuickRepeat = 'none' | 'week' | 'month' | 'year'

// ── Synced settings (storage key `syncedSettings`) ───────────────────────────

/**
 * The settings that follow the user between devices: one encrypted record.
 * Per-device settings stay in the plaintext `meta:settings`.
 */
export interface SyncedSettingsRecord {
  id: 'settings'
  mainCurrency: Currency
  fetchExchangeRates: boolean
  updatedAt: string
  /** Local change sequence number (meta:sync); never leaves the device. */
  rev?: number
}
