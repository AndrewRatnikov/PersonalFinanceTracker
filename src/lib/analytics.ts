import { createServerFn } from '@tanstack/react-start'

import type {
  AnalyticsRangeSummary,
  AnalyticsTimelinePoint,
  CategoryBreakdownItem,
  MonthlyExpenseSummary,
} from './domain'
import { getAuthenticatedClient } from './serverClient'

export const getMonthlyExpenses = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MonthlyExpenseSummary[]> => {
    const { supabase, user } = await getAuthenticatedClient()

    // Date math: First day of 11 months ago, so we have 12 full months including current.
    const date = new Date()
    date.setMonth(date.getMonth() - 11)
    date.setDate(1)
    date.setHours(0, 0, 0, 0)

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
      const d = new Date()
      d.setMonth(d.getMonth() - i)
      // Format as "Jan", "Feb", etc.
      const monthLabel = d.toLocaleString('en-US', { month: 'short' })
      const key = `${d.getFullYear()}-${monthLabel}`
      monthlyMap[key] = 0
    }

    // Add amounts to their respective month bucket
    if (data) {
      data.forEach((exp: any) => {
        const expDate = new Date(exp.created_at)
        const monthLabel = expDate.toLocaleString('en-US', { month: 'short' })
        const key = `${expDate.getFullYear()}-${monthLabel}`
        if (monthlyMap[key] !== undefined) {
          monthlyMap[key] += Number(exp.amount)
        } else {
          monthlyMap[key] = Number(exp.amount)
        }
      })
    }

    // Format for Recharts
    const chartData: MonthlyExpenseSummary[] = Object.entries(monthlyMap).map(
      ([key, value]) => {
        const [year, month] = key.split('-')
        return {
          month, // e.g. 'Jan'
          year, // e.g. '2023'
          name: month, // Label to show on X axis
          total: value, // Total amount for that month
        }
      },
    )

    return chartData
  },
)

type RangeInput = {
  from?: string
  to?: string
}

function getDefaultRange(): { from: string; to: string } {
  const now = new Date()
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)

  const from = new Date(now)
  from.setDate(from.getDate() - 29)
  from.setHours(0, 0, 0, 0)

  return {
    from: from.toISOString(),
    to: to.toISOString(),
  }
}

function normalizeRange(input: RangeInput): { from: string; to: string } {
  const fallback = getDefaultRange()

  if (!input.from && !input.to) {
    return fallback
  }

  let fromDate = input.from ? new Date(input.from) : new Date(fallback.from)
  let toDate = input.to ? new Date(input.to) : new Date(fallback.to)

  if (Number.isNaN(fromDate.getTime())) {
    fromDate = new Date(fallback.from)
  }
  if (Number.isNaN(toDate.getTime())) {
    toDate = new Date(fallback.to)
  }

  if (fromDate > toDate) {
    const tmp = fromDate
    fromDate = toDate
    toDate = tmp
  }

  fromDate.setHours(0, 0, 0, 0)
  toDate.setHours(23, 59, 59, 999)

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  }
}

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
    const range = normalizeRange(data ?? {})

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

    if (rows) {
      for (const row of rows as any[]) {
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

        const dateObj = new Date(row.created_at)
        if (Number.isNaN(dateObj.getTime())) continue
        const y = dateObj.getUTCFullYear()
        const m = dateObj.getUTCMonth() + 1
        const d = dateObj.getUTCDate()
        const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(
          2,
          '0',
        )}`

        const prevTotal = timelineMap.get(key) ?? 0
        timelineMap.set(key, prevTotal + amount)
      }
    }

    const categoryBreakdown = Array.from(categoryMap.values()).sort(
      (a, b) => b.total - a.total,
    )

    const timelineKeys = Array.from(timelineMap.keys()).sort()
    const timeline: AnalyticsTimelinePoint[] = timelineKeys.map((key) => {
      const [year, month, day] = key.split('-').map(Number)
      const dateObj = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1))
      const label = dateObj.toLocaleDateString('en-US', {
        day: '2-digit',
        month: 'short',
      })
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

