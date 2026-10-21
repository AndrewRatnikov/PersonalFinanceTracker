import dayjs from 'dayjs'

import { formatDay } from '../i18n/format'
import { getAllBudgets, getAllIncome, getExpensesForRange } from './localDb'
import { normalizeRange } from './analyticsUtils'
import { DEFAULT_MAIN_CURRENCY } from './domain'
import { incomeSourceLabel } from './incomeCategories'
import { mainAmountOf } from './money'
import type { RangeInput } from './analyticsUtils'
import type {
  AnalyticsRangeSummary,
  AnalyticsTimelinePoint,
  BudgetVarianceItem,
  CategoryBreakdownItem,
  Currency,
} from './domain'

// Every total sums mainAmountOf() in the main currency. Entries still waiting
// for a rate are left out and counted in pendingCount; budgets in another
// currency are left out of the variance and counted in budgetsExcluded.
export type RangeAnalytics = AnalyticsRangeSummary & {
  mainCurrency: Currency
  pendingCount: number
  budgetsExcluded: number
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
  mainCurrency: Currency = DEFAULT_MAIN_CURRENCY,
): Promise<RangeAnalytics> {
  const range = normalizeRange(input)

  const [expenses, income, budgets] = await Promise.all([
    getExpensesForRange(range.from, range.to),
    getAllIncome(),
    getAllBudgets(),
  ])

  const categoryMap = new Map<string, CategoryBreakdownItem>()
  const timelineMap = new Map<string, number>()

  let pendingCount = 0

  for (const e of expenses) {
    const main = mainAmountOf(e, mainCurrency)
    if (main === null) {
      pendingCount++
      continue
    }
    const amount = Number(main)
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
      label: formatDay(key),
      total: timelineMap.get(key) ?? 0,
    }))

  const rangeIncome = income.filter(
    (e) => e.createdAt >= range.from && e.createdAt <= range.to,
  )
  let totalIncome = 0
  // Income in the main currency, grouped by income category.
  const incomeMap = new Map<string, CategoryBreakdownItem>()
  for (const i of rangeIncome) {
    const main = mainAmountOf(i, mainCurrency)
    if (main === null) {
      pendingCount++
      continue
    }
    totalIncome += Number(main)
    const amount = Number(main)
    if (!Number.isFinite(amount) || amount <= 0) continue
    // Legacy (unconverted) records have no categoryId.
    const categoryId = i.categoryId || ''
    const existing = incomeMap.get(categoryId)
    if (existing) {
      existing.total += amount
    } else {
      incomeMap.set(categoryId, {
        categoryId,
        name: incomeSourceLabel(i),
        icon: i.category?.icon ?? null,
        total: amount,
      })
    }
  }
  const incomeBreakdown = Array.from(incomeMap.values()).sort(
    (a, b) => b.total - a.total,
  )

  const budgetsExcluded = budgets.filter(
    (b) => b.currency !== mainCurrency,
  ).length

  const budgetVariance: Array<BudgetVarianceItem> = budgets
    .filter((b) => b.currency === mainCurrency)
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
    incomeBreakdown,
    mainCurrency,
    pendingCount,
    budgetsExcluded,
  }
}
