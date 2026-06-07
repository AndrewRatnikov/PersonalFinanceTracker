import { createServerFn } from '@tanstack/react-start'
import dayjs from 'dayjs'

import { getAuthenticatedClient } from './serverClient'
import { normalizeRange } from './analyticsUtils'
import type { RangeInput } from './analyticsUtils'
import type {
  AnalyticsRangeSummary,
  AnalyticsTimelinePoint,
  BudgetVarianceItem,
  CategoryBreakdownItem,
  MonthlyExpenseSummary,
} from './domain'

export const getMonthlyExpenses = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MonthlyExpenseSummary>> => {
    const { supabase, user } = await getAuthenticatedClient()

    // Date math: First day of 11 months ago, so we have 12 full months including current.
    const date = dayjs().subtract(11, 'month').startOf('month')

    // We fetch everything from that date forward
    const { data, error } = await supabase
      .from('expenses')
      .select('amount, created_at')
      .eq('user_id', user.id)
      .gte('created_at', date.toISOString())

    if (error) {
      throw error
    }

    // Grouping logic in JavaScript for the bar chart
    const monthlyMap: Record<string, number> = {}

    // Initialize the last 12 months with 0
    for (let i = 11; i >= 0; i--) {
      const d = dayjs().subtract(i, 'month')
      // Format as "Jan", "Feb", etc.
      const monthLabel = d.format('MMM')
      const key = `${d.year()}-${monthLabel}`
      monthlyMap[key] = 0
    }

    // Add amounts to their respective month bucket
    data.forEach((exp: any) => {
      const expDate = dayjs(exp.created_at)
      const monthLabel = expDate.format('MMM')
      const key = `${expDate.year()}-${monthLabel}`
      if (key in monthlyMap) {
        monthlyMap[key] += Number(exp.amount)
      } else {
        monthlyMap[key] = Number(exp.amount)
      }
    })

    // Format for Recharts
    const chartData: Array<MonthlyExpenseSummary> = Object.entries(
      monthlyMap,
    ).map(([key, value]) => {
      const [year, month] = key.split('-')
      return {
        month, // e.g. 'Jan'
        year, // e.g. '2023'
        name: month, // Label to show on X axis
        total: value, // Total amount for that month
      }
    })

    return chartData
  },
)


export const getRangeAnalytics = createServerFn({ method: 'GET' })
  .inputValidator((input: RangeInput | undefined): RangeInput => {
    if (!input || typeof input !== 'object') return {}
    const { from, to } = input
    return {
      from: typeof from === 'string' && from ? from : undefined,
      to: typeof to === 'string' && to ? to : undefined,
    }
  })
  .handler(async ({ data }): Promise<AnalyticsRangeSummary> => {
    const { supabase, user } = await getAuthenticatedClient()
    const range = normalizeRange(data)

    const [
      { data: rows, error },
      { data: incomeRows, error: incomeError },
      { data: budgetRows, error: budgetError },
    ] = await Promise.all([
      supabase
        .from('expenses')
        .select('id, amount, currency, category_id, created_at, categories (id, name, icon)')
        .eq('user_id', user.id)
        .gte('created_at', range.from)
        .lte('created_at', range.to),
      supabase
        .from('income')
        .select('amount')
        .eq('user_id', user.id)
        .gte('created_at', range.from)
        .lte('created_at', range.to),
      supabase
        .from('budgets')
        .select('category_id, monthly_limit, currency, categories (id, name, icon)')
        .eq('user_id', user.id),
    ])

    if (error) throw error
    if (incomeError) throw incomeError
    if (budgetError) throw budgetError

    const totalIncome = (incomeRows ?? []).reduce(
      (sum: number, row: any) => sum + Number(row.amount),
      0,
    )

    const categoryMap = new Map<string, CategoryBreakdownItem>()
    const timelineMap = new Map<string, number>()

    for (const row of rows as Array<any>) {
      const amount = Number(row.amount)
      if (!Number.isFinite(amount) || amount <= 0) continue
      if (!row.category_id || !row.categories) continue

      const categoryId = row.category_id as string
      const existing = categoryMap.get(categoryId)
      const name = row.categories.name as string
      const icon = (row.categories.icon ?? null) as string | null

      if (existing) {
        existing.total += amount
      } else {
        categoryMap.set(categoryId, {
          categoryId,
          name,
          icon,
          total: amount,
        })
      }

      const dateObj = dayjs(row.created_at)
      if (!dateObj.isValid()) continue
      const key = dateObj.toISOString().split('T')[0]

      const prevTotal = timelineMap.get(key) ?? 0
      timelineMap.set(key, prevTotal + amount)
    }

    const categoryBreakdown = Array.from(categoryMap.values()).sort(
      (a, b) => b.total - a.total,
    )

    const timelineKeys = Array.from(timelineMap.keys()).sort()
    const timeline: Array<AnalyticsTimelinePoint> = timelineKeys.map((key) => {
      const dateObj = dayjs(key)
      const label = dateObj.format('MMM DD')
      return {
        date: key,
        label,
        total: timelineMap.get(key) ?? 0,
      }
    })

    const budgetVariance: Array<BudgetVarianceItem> = (budgetRows ?? []).map((b: any) => {
      const actual = categoryMap.get(b.category_id)?.total ?? 0
      const budget = Number(b.monthly_limit)
      return {
        categoryId: b.category_id,
        name: b.categories?.name ?? '',
        icon: b.categories?.icon ?? null,
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
  })
