import dayjs from 'dayjs'

import type {
  BudgetEntry,
  Category,
  Currency,
  Expense,
  IncomeEntry,
} from '@/lib/domain'

export type BudgetStatus = 'ok' | 'warning' | 'over'

export interface ExcludedCurrencyTotal {
  currency: Currency
  expenses: number
  income: number
}

export interface DashboardPace {
  spentSoFar: number
  lastMonthSameDay: number
  /** Raw percentage, e.g. -12.5; not rounded. */
  changePct: number | null
}

export interface BudgetWatchItem {
  categoryId: string
  name: string
  spent: number
  limit: number
  ratio: number
  status: BudgetStatus
}

export type RecentItem =
  | (Expense & { kind: 'expense' })
  | (IncomeEntry & { kind: 'income' })

export interface DashboardSummaryInput {
  expenses: Array<Expense>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  categories: Array<Category>
  now: Date
  /** Defaults to 'UAH'. */
  baseCurrency?: Currency
}

export interface DashboardSummary {
  baseCurrency: Currency
  monthIncome: number
  monthExpenses: number
  net: number
  /** Sorted by currency ascending. */
  excluded: Array<ExcludedCurrencyTotal>
  leftToSpend: number | null
  dailyAllowance: number | null
  pace: DashboardPace
  /** Max 5, ratio descending, ties by name ascending. */
  budgetWatch: Array<BudgetWatchItem>
  /** Max 5, createdAt descending. */
  recent: Array<RecentItem>
}

const RECENT_LIMIT = 5
const BUDGET_WATCH_LIMIT = 5

export function getBudgetStatus(ratio: number): BudgetStatus {
  if (ratio < 0.8) return 'ok'
  if (ratio <= 1) return 'warning'
  return 'over'
}

export function computeDashboardSummary(
  input: DashboardSummaryInput,
): DashboardSummary {
  const {
    expenses,
    income,
    budgets,
    categories,
    now,
    baseCurrency = 'UAH',
  } = input

  const n = dayjs(now)
  const isThisMonth = (createdAt: string) => {
    const d = dayjs(createdAt)
    return d.year() === n.year() && d.month() === n.month()
  }

  const monthExpenseEntries = expenses.filter((e) => isThisMonth(e.createdAt))
  const monthIncomeEntries = income.filter((i) => isThisMonth(i.createdAt))

  const baseMonthExpenses = monthExpenseEntries.filter(
    (e) => e.currency === baseCurrency,
  )

  const monthExpenses = baseMonthExpenses.reduce(
    (sum, e) => sum + Number(e.amount),
    0,
  )
  const monthIncome = monthIncomeEntries
    .filter((i) => i.currency === baseCurrency)
    .reduce((sum, i) => sum + Number(i.amount), 0)

  // ---- excluded (non-base currency, this month) ----
  const excludedMap = new Map<Currency, ExcludedCurrencyTotal>()
  const getExcluded = (currency: Currency) => {
    let entry = excludedMap.get(currency)
    if (!entry) {
      entry = { currency, expenses: 0, income: 0 }
      excludedMap.set(currency, entry)
    }
    return entry
  }
  for (const e of monthExpenseEntries) {
    if (e.currency !== baseCurrency) {
      getExcluded(e.currency).expenses += Number(e.amount)
    }
  }
  for (const i of monthIncomeEntries) {
    if (i.currency !== baseCurrency) {
      getExcluded(i.currency).income += Number(i.amount)
    }
  }
  const excluded = [...excludedMap.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  )

  // ---- spend per category (base currency, this month) ----
  const spentByCategory = new Map<string, number>()
  for (const e of baseMonthExpenses) {
    spentByCategory.set(
      e.categoryId,
      (spentByCategory.get(e.categoryId) ?? 0) + Number(e.amount),
    )
  }

  // ---- budgets (base currency only; limits summed per category) ----
  const limitByCategory = new Map<string, number>()
  for (const b of budgets) {
    if (b.currency !== baseCurrency) continue
    limitByCategory.set(
      b.categoryId,
      (limitByCategory.get(b.categoryId) ?? 0) + Number(b.monthlyLimit),
    )
  }

  let leftToSpend: number | null = null
  let dailyAllowance: number | null = null
  let budgetWatch: Array<BudgetWatchItem> = []

  if (limitByCategory.size > 0) {
    let totalLimit = 0
    let budgetedSpent = 0
    for (const [categoryId, limit] of limitByCategory) {
      totalLimit += limit
      budgetedSpent += spentByCategory.get(categoryId) ?? 0
    }
    leftToSpend = totalLimit - budgetedSpent

    const daysLeft = n.daysInMonth() - n.date() + 1
    dailyAllowance = Math.max(leftToSpend, 0) / daysLeft

    budgetWatch = [...limitByCategory.entries()]
      .map(([categoryId, limit]): BudgetWatchItem => {
        const spent = spentByCategory.get(categoryId) ?? 0
        const ratio = limit > 0 ? spent / limit : spent > 0 ? Infinity : 0
        const name =
          categories.find((c) => c.id === categoryId)?.name ?? 'Uncategorized'
        return {
          categoryId,
          name,
          spent,
          limit,
          ratio,
          status: getBudgetStatus(ratio),
        }
      })
      .sort((a, b) => {
        if (a.ratio !== b.ratio) return a.ratio > b.ratio ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, BUDGET_WATCH_LIMIT)
  }

  // ---- pace ----
  const p = n.subtract(1, 'month')
  const cutoff = Math.min(n.date(), p.daysInMonth())
  const lastMonthSameDay = expenses
    .filter((e) => {
      if (e.currency !== baseCurrency) return false
      const d = dayjs(e.createdAt)
      return (
        d.year() === p.year() && d.month() === p.month() && d.date() <= cutoff
      )
    })
    .reduce((sum, e) => sum + Number(e.amount), 0)
  const changePct =
    lastMonthSameDay === 0
      ? null
      : ((monthExpenses - lastMonthSameDay) / lastMonthSameDay) * 100

  // ---- recent ----
  const recent: Array<RecentItem> = [
    ...expenses.map((e): RecentItem => ({ ...e, kind: 'expense' })),
    ...income.map((i): RecentItem => ({ ...i, kind: 'income' })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_LIMIT)

  return {
    baseCurrency,
    monthIncome,
    monthExpenses,
    net: monthIncome - monthExpenses,
    excluded,
    leftToSpend,
    dailyAllowance,
    pace: {
      spentSoFar: monthExpenses,
      lastMonthSameDay,
      changePct,
    },
    budgetWatch,
    recent,
  }
}
