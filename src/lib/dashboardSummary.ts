import dayjs from 'dayjs'

import type {
  BudgetEntry,
  Category,
  Currency,
  Expense,
  IncomeEntry,
} from '@/lib/domain'
import { t } from '@/i18n/core'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { mainAmountOf } from '@/lib/money'
import { isLive } from '@/lib/syncRecords'

export type BudgetStatus = 'ok' | 'warning' | 'over'

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
  (Expense & { kind: 'expense' }) | (IncomeEntry & { kind: 'income' })

export interface DashboardSummaryInput {
  expenses: Array<Expense>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  categories: Array<Category>
  now: Date
  /** Defaults to DEFAULT_MAIN_CURRENCY. */
  mainCurrency?: Currency
}

// Every total sums mainAmountOf(): entries still waiting for a rate are left
// out and counted in pendingCount; budgets in another currency are left out
// and counted in budgetsExcluded. Currencies are never mixed.
export interface DashboardSummary {
  mainCurrency: Currency
  monthIncome: number
  monthExpenses: number
  net: number
  /** This month's expenses and income without a main-currency amount. */
  pendingCount: number
  /** Budgets not in the main currency (skipped in left-to-spend and watch). */
  budgetsExcluded: number
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
  const { categories, now, mainCurrency = DEFAULT_MAIN_CURRENCY } = input
  // Deleted records (tombstones) never count.
  const expenses = input.expenses.filter(isLive)
  const income = input.income.filter(isLive)
  const budgets = input.budgets.filter(isLive)

  const n = dayjs(now)
  const isThisMonth = (createdAt: string) => {
    const d = dayjs(createdAt)
    return d.year() === n.year() && d.month() === n.month()
  }

  const monthExpenseEntries = expenses.filter((e) => isThisMonth(e.createdAt))
  const monthIncomeEntries = income.filter((i) => isThisMonth(i.createdAt))

  let pendingCount = 0
  // Entries with their main-currency amount; pending ones are counted, not summed.
  const withMain = <T extends Expense | IncomeEntry>(
    entries: Array<T>,
  ): Array<{ entry: T; main: number }> => {
    const result: Array<{ entry: T; main: number }> = []
    for (const entry of entries) {
      const main = mainAmountOf(entry, mainCurrency)
      if (main === null) pendingCount++
      else result.push({ entry, main })
    }
    return result
  }

  const monthExpenseMain = withMain(monthExpenseEntries)
  const monthIncomeMain = withMain(monthIncomeEntries)

  const monthExpenses = monthExpenseMain.reduce((sum, e) => sum + e.main, 0)
  const monthIncome = monthIncomeMain.reduce((sum, i) => sum + i.main, 0)

  // ---- spend per category (main currency, this month) ----
  const spentByCategory = new Map<string, number>()
  for (const { entry, main } of monthExpenseMain) {
    spentByCategory.set(
      entry.categoryId,
      (spentByCategory.get(entry.categoryId) ?? 0) + main,
    )
  }

  // ---- budgets (main currency only; limits summed per category) ----
  const limitByCategory = new Map<string, number>()
  let budgetsExcluded = 0
  for (const b of budgets) {
    if (b.currency !== mainCurrency) {
      budgetsExcluded++
      continue
    }
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
          categories.find((c) => c.id === categoryId)?.name ??
          t('common.uncategorized')
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
      const d = dayjs(e.createdAt)
      return (
        d.year() === p.year() && d.month() === p.month() && d.date() <= cutoff
      )
    })
    .reduce((sum, e) => sum + (mainAmountOf(e, mainCurrency) ?? 0), 0)
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
    mainCurrency,
    monthIncome,
    monthExpenses,
    net: monthIncome - monthExpenses,
    pendingCount,
    budgetsExcluded,
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
