import { createServerFn } from '@tanstack/react-start'
import { getAuthenticatedClient } from '../serverClient'
import type { Currency } from '../domain'

export interface UpdateExpenseInput {
  id: string
  amount?: number
  currency?: Currency
  categoryId?: string
  description?: string
}

export const updateExpense = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): UpdateExpenseInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid update payload')
    }
    const payload = input as UpdateExpenseInput
    if (typeof payload.id !== 'string' || !payload.id) {
      throw new Error('Expense ID is required')
    }
    return {
      id: payload.id,
      amount: typeof payload.amount === 'number' ? payload.amount : undefined,
      currency: typeof payload.currency === 'string' ? payload.currency as Currency : undefined,
      categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : undefined,
      description: typeof payload.description === 'string' ? payload.description : undefined,
    }
  })
  .handler(async ({ data }: { data: UpdateExpenseInput }): Promise<void> => {
    const { supabase, user } = await getAuthenticatedClient()
    const { id, amount, currency, categoryId, description } = data

    const updates: any = { updated_at: new Date().toISOString() }
    if (amount !== undefined) updates.amount = amount
    if (currency !== undefined) updates.currency = currency
    if (categoryId !== undefined) updates.category_id = categoryId
    if (description !== undefined) updates.description = description

    const { error } = await supabase
      .from('expenses')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) {
      throw error
    }
  })
