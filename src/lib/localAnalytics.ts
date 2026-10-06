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
      const budget = Number(b.monthlyLimit)
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
