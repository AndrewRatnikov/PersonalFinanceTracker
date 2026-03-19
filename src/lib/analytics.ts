import { createServerFn } from '@tanstack/react-start'
import dayjs from 'dayjs'

import { getAuthenticatedClient } from './serverClient'
import { normalizeRange } from './analyticsUtils'
import type { RangeInput } from './analyticsUtils'
import type {
  AnalyticsRangeSummary,
  AnalyticsTimelinePoint,
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

    const { data: rows, error } = await supabase
      .from('expenses')
      .select(
        'id, amount, currency, category_id, created_at, categories (id, name, icon)',
      )
      .eq('user_id', user.id)
      .gte('created_at', range.from)
      .lte('created_at', range.to)

    if (error) {
      throw error
    }

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

    return {
      from: range.from,
      to: range.to,
      categoryBreakdown,
      timeline,
    }
  })
