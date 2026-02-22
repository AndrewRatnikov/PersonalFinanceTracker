import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import { createServerSupabaseClient } from './supabase'

/**
 * Helper to get the authenticated Supabase client in a Server Function.
 */
const getAuthenticatedClient = async () => {
  const req = getRequest()
  if (!req) throw new Error('No request context found')

  const supabase = createServerSupabaseClient(
    req.headers.get('cookie') ?? '',
    (name, value, options) => {
      setCookie(name, value, options as any)
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  return { supabase, user }
}

export const getUserCategories = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { supabase, user } = await getAuthenticatedClient()
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) throw error
    return data || []
  },
)

export const getRecentExpenses = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { supabase, user } = await getAuthenticatedClient()
    const { data, error } = await supabase
      .from('expenses')
      .select('*, categories (name, icon)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) throw error
    return data || []
  },
)

export const getMonthlyExpenses = createServerFn({ method: 'GET' }).handler(
  async () => {
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

    if (error) throw error

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
    const chartData = Object.entries(monthlyMap).map(([key, value]) => {
      const [year, month] = key.split('-')
      return {
        month, // e.g. 'Jan'
        year, // e.g. '2023'
        name: month, // Label to show on X axis
        target: value, // Total amount for that month
      }
    })

    return chartData
  },
)

export const createExpense = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: { amount: number; currency: string; category_id: string }) => data,
  )
  .handler(async (ctx) => {
    const { supabase, user } = await getAuthenticatedClient()
    const { amount, currency, category_id } = ctx.data

    const { data, error } = await supabase
      .from('expenses')
      .insert({
        user_id: user.id,
        amount,
        currency,
        category_id,
        // Wait, 'is_recurring' is boolean. Set default to false
        is_recurring: false,
      })
      .select()
      .single()

    if (error) throw error
    return data
  })
