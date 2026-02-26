import { createServerFn } from '@tanstack/react-start'

import type { CreateExpenseInput, Currency, Expense } from './domain'
import { getAuthenticatedClient } from './serverClient'

export const getRecentExpenses = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Expense[]> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data, error } = await supabase
      .from('expenses')
      .select('id, amount, currency, category_id, created_at, categories (id, name, icon)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      throw error
    }

    return (data ?? []).map((row: any) => ({
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency,
      categoryId: row.category_id,
      createdAt: row.created_at,
      category: row.categories
        ? {
            id: row.categories.id,
            name: row.categories.name,
            icon: row.categories.icon ?? null,
          }
        : undefined,
    }))
  },
)

const VALID_CURRENCIES: Currency[] = ['UAH', 'USD', 'EUR']

export const createExpense = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): CreateExpenseInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid expense payload')
    }

    const { amount, currency, categoryId } = input as {
      amount?: unknown
      currency?: unknown
      categoryId?: unknown
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number')
    }

    if (typeof currency !== 'string' || !VALID_CURRENCIES.includes(currency as Currency)) {
      throw new Error('Unsupported currency')
    }

    if (typeof categoryId !== 'string' || !categoryId) {
      throw new Error('categoryId is required')
    }

    return {
      amount,
      currency: currency as Currency,
      categoryId,
    }
  })
  .handler(async ({ data }): Promise<Expense> => {
    const { supabase, user } = await getAuthenticatedClient()
    const { amount, currency, categoryId } = data

    const { data: inserted, error } = await supabase
      .from('expenses')
      .insert({
        user_id: user.id,
        amount,
        currency,
        category_id: categoryId,
        is_recurring: false,
      })
      .select('id, amount, currency, category_id, created_at')
      .single()

    if (error) {
      throw error
    }

    return {
      id: inserted.id,
      amount: Number(inserted.amount),
      currency: inserted.currency,
      categoryId: inserted.category_id,
      createdAt: inserted.created_at,
      category: undefined,
    }
  })

