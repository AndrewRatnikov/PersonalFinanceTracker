import dayjs from 'dayjs'

import { getAllBudgets, getAllIncome, getExpensesForRange } from './localDb'
import { normalizeRange } from './analyticsUtils'
import type { RangeInput } from './analyticsUtils'
import type { ExcludedCurrencyTotal } from './dashboardSummary'
import type {
  AnalyticsRangeSummary,
  AnalyticsTimelinePoint,
  BudgetVarianceItem,
  CategoryBreakdownItem,
  Currency,
} from './domain'

export interface RangeAnalytics extends AnalyticsRangeSummary {
  excluded: Array<ExcludedCurrencyTotal>
}

// B1: a monthly budget limit scaled to an arbitrary [from, to] range, in local
// dates. Each calendar month the range touches contributes
// monthlyLimit × (days of the range inside that month / days in that month).
// A range covering exactly one calendar month gives monthlyLimit.
export function scaleMonthlyLimitToRange(
  monthlyLimit: number,
  from: string,
  to: string,
): number {
  const start = dayjs(from).startOf('day')
  const end = dayjs(to).startOf('day')
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) return 0

  let sum = 0
  let month = start.startOf('month')
  const lastMonth = end.startOf('month')
  while (!month.isAfter(lastMonth)) {
    const monthEnd = month.endOf('month').startOf('day')
    const first = start.isAfter(month) ? start : month
    const last = end.isBefore(monthEnd) ? end : monthEnd
    // Date-of-month arithmetic, so DST changes cannot skew the day count.
    const daysIn = last.date() - first.date() + 1
    sum += (monthlyLimit * daysIn) / month.daysInMonth()
    month = month.add(1, 'month')
  }
  return Math.round(sum * 100) / 100
}

export async function computeRangeAnalytics(
  input: RangeInput = {},
  currency: Currency = 'UAH',
): Promise<RangeAnalytics> {
  const range = normalizeRange(input)

  const [expenses, income, budgets] = await Promise.all([
    getExpensesForRange(range.from, range.to),
    getAllIncome(),
    getAllBudgets(),
  ])

  const categoryMap = new Map<string, CategoryBreakdownItem>()
  const timelineMap = new Map<string, number>()

  const excludedMap = new Map<Currency, ExcludedCurrencyTotal>()
  const getExcluded = (c: Currency) => {
    let entry = excludedMap.get(c)
    if (!entry) {
      entry = { currency: c, expenses: 0, income: 0 }
      excludedMap.set(c, entry)
    }
    return entry
  }

  for (const e of expenses) {
    const amount = Number(e.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue

    if (e.currency !== currency) {
      getExcluded(e.currency).expenses += amount
      continue
    }

    const cat = e.category
    if (!cat) continue

    const existing = categoryMap.get(e.categoryId)
    if (existing) {
      existing.total += amount
    } else {
      categoryMap.set(e.categoryId, {
        categoryId: e.categoryId,
        name: cat.name,
        icon: cat.icon ?? null,
        total: amount,
      })
    }

    const dateObj = dayjs(e.createdAt)
    if (!dateObj.isValid()) continue
    const key = dateObj.format('YYYY-MM-DD')
    timelineMap.set(key, (timelineMap.get(key) ?? 0) + amount)
  }

  const categoryBreakdown = Array.from(categoryMap.values()).sort(
    (a, b) => b.total - a.total,
  )

  const timeline: Array<AnalyticsTimelinePoint> = Array.from(timelineMap.keys())
    .sort()
    .map((key) => ({
      date: key,
      label: dayjs(key).format('MMM DD'),
      total: timelineMap.get(key) ?? 0,
    }))

  const rangeIncome = income.filter(
    (e) => e.createdAt >= range.from && e.createdAt <= range.to,
  )
  const totalIncome = rangeIncome
    .filter((e) => e.currency === currency)
    .reduce((sum, e) => sum + Number(e.amount), 0)
  for (const i of rangeIncome) {
    if (i.currency !== currency) {
      getExcluded(i.currency).income += Number(i.amount)
    }
  }

  const excluded = [...excludedMap.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  )

  const budgetVariance: Array<BudgetVarianceItem> = budgets
    .filter((b) => b.currency === currency)
    .map((b) => {
      const actual = categoryMap.get(b.categoryId)?.total ?? 0
      const budget = scaleMonthlyLimitToRange(
        Number(b.monthlyLimit),
        range.from,
        range.to,
      )
      return {
        categoryId: b.categoryId,
        name: b.categoryName,
        icon: b.categoryIcon,
        budget,
        actual,
        overBudget: actual > budget,
      }
    })

  return {
    from: range.from,
    to: range.to,
    categoryBreakdown,
    timeline,
    totalIncome,
    budgetVariance,
    excluded,
  }
}
