import { createServerFn } from '@tanstack/react-start'

import { getAuthenticatedClient } from './serverClient'
import { CURRENCIES } from './domain'
import type { BudgetEntry, Currency, UpsertBudgetInput } from './domain'

export type BudgetEntryWithCategory = BudgetEntry & {
  categoryName: string
  categoryIcon: string | null
}

export const getBudgets = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<BudgetEntryWithCategory>> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data: rows, error } = await supabase
      .from('budgets')
      .select('id, category_id, monthly_limit, currency, categories (id, name, icon)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    return (rows as Array<any>).map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      monthlyLimit: Number(row.monthly_limit),
      currency: row.currency as Currency,
      categoryName: row.categories?.name ?? '',
      categoryIcon: row.categories?.icon ?? null,
    }))
  },
)

export const upsertBudget = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): UpsertBudgetInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid budget payload')
    }

    const { categoryId, monthlyLimit, currency } = input as {
      categoryId?: unknown
      monthlyLimit?: unknown
      currency?: unknown
    }

    if (typeof categoryId !== 'string' || !categoryId.trim()) {
      throw new Error('Category is required')
    }

    if (typeof monthlyLimit !== 'number' || !Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
      throw new Error('Monthly limit must be a positive number')
    }

    if (typeof currency !== 'string' || !CURRENCIES.includes(currency as Currency)) {
      throw new Error('Unsupported currency')
    }

    return {
      categoryId: categoryId.trim(),
      monthlyLimit,
      currency: currency as Currency,
    }
  })
  .handler(async ({ data }): Promise<BudgetEntry> => {
    const { supabase, user } = await getAuthenticatedClient()
    const { categoryId, monthlyLimit, currency } = data

    const { data: row, error } = await supabase
      .from('budgets')
      .upsert(
        {
          user_id: user.id,
          category_id: categoryId,
          monthly_limit: monthlyLimit,
          currency,
        },
        { onConflict: 'user_id,category_id' },
      )
      .select('id, category_id, monthly_limit, currency')
      .single()

    if (error) throw error

    return {
      id: row.id,
      categoryId: row.category_id,
      monthlyLimit: Number(row.monthly_limit),
      currency: row.currency as Currency,
    }
  })

export const deleteBudget = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): string => {
    if (typeof input !== 'string' || !input) {
      throw new Error('Budget ID is required')
    }
    return input
  })
  .handler(async ({ data }): Promise<void> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { error } = await supabase
      .from('budgets')
      .delete()
      .eq('id', data)
      .eq('user_id', user.id)

    if (error) throw error
  })
