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

export interface CreateExpenseInput {
  amount: number
  currency: Currency
  categoryId: string
}

