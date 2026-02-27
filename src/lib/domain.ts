export type Currency = 'UAH' | 'USD' | 'EUR'

export interface Category {
  id: string
  name: string
  icon?: string | null
}

export interface Expense {
  id: string
  amount: number
  currency: Currency
  categoryId: string
  createdAt: string
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

export interface AnalyticsRangeSummary {
  /**
   * ISO datetime string for the inclusive range start.
   */
  from: string
  /**
   * ISO datetime string for the inclusive range end.
   */
  to: string
  categoryBreakdown: CategoryBreakdownItem[]
  timeline: AnalyticsTimelinePoint[]
}

export interface CreateExpenseInput {
  amount: number
  currency: Currency
  categoryId: string
}

export interface CreateCategoryInput {
  name: string
  icon?: string | null
}

export interface UpdateCategoryInput {
  id: string
  name: string
  icon?: string | null
}
