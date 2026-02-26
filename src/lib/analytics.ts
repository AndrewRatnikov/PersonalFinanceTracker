import { createServerFn } from '@tanstack/react-start'

import type { MonthlyExpenseSummary } from './domain'
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

