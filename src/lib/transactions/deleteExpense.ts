import { createServerFn } from '@tanstack/react-start'
import { getAuthenticatedClient } from '../serverClient'

export interface DeleteExpenseInput {
  id: string
}

export const deleteExpense = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): DeleteExpenseInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid delete payload')
    }
    const { id } = input as { id?: unknown }
    if (typeof id !== 'string' || !id) {
      throw new Error('Expense ID is required')
    }
    return { id }
  })
  .handler(async ({ data }: { data: DeleteExpenseInput }): Promise<void> => {
    const { supabase, user } = await getAuthenticatedClient()
    const { id } = data

    const { error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id) // Ensure users can only delete their own expenses

    if (error) {
      throw error
    }
  })
