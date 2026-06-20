import dayjs from 'dayjs'

import { getExpensesForRange, getAllIncome, getAllBudgets } from './localDb'
import { normalizeRange } from './analyticsUtils'
import type { RangeInput } from './analyticsUtils'
import type {
  AnalyticsRangeSummary,
  AnalyticsTimelinePoint,
  BudgetVarianceItem,
  CategoryBreakdownItem,
} from './domain'

export async function computeRangeAnalytics(
  input: RangeInput = {},
): Promise<AnalyticsRangeSummary> {
  const range = normalizeRange(input)

  const [expenses, income, budgets] = await Promise.all([
    getExpensesForRange(range.from, range.to),
    getAllIncome(),
    getAllBudgets(),
  ])

  const categoryMap = new Map<string, CategoryBreakdownItem>()
  const timelineMap = new Map<string, number>()

  for (const e of expenses) {
    const amount = Number(e.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue

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
    const key = dateObj.toISOString().split('T')[0]
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

  const totalIncome = income
    .filter((e) => e.createdAt >= range.from && e.createdAt <= range.to)
    .reduce((sum, e) => sum + Number(e.amount), 0)

  const budgetVariance: Array<BudgetVarianceItem> = budgets.map((b) => {
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
  }
}
