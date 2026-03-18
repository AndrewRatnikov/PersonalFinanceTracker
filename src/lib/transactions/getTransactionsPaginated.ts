import { createServerFn } from '@tanstack/react-start'
import { getAuthenticatedClient } from '../serverClient'
import type { Expense } from '../domain'

export interface GetTransactionsPaginatedInput {
  pageIndex?: number
  pageSize?: number
  categoryId?: string | null
  dateRange?: { from: string; to: string } | null
}

export interface GetTransactionsPaginatedOutput {
  transactions: Array<Expense & { description?: string; id: string }>
  totalCount: number
}

export const getTransactionsPaginated = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown): GetTransactionsPaginatedInput => {
    // Basic validation, since Zod is not yet fully installed/integrated across the board implicitly
    const payload = (input as GetTransactionsPaginatedInput) || {}
    return {
      pageIndex: typeof payload.pageIndex === 'number' ? payload.pageIndex : 0,
      pageSize: typeof payload.pageSize === 'number' ? payload.pageSize : 10,
      categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : null,
      dateRange: payload.dateRange && typeof payload.dateRange.from === 'string' && typeof payload.dateRange.to === 'string' ? payload.dateRange : null,
    }
  })
  .handler(
    async ({ data }: { data: GetTransactionsPaginatedInput }): Promise<GetTransactionsPaginatedOutput> => {
      const { supabase, user } = await getAuthenticatedClient()
      const { pageIndex = 0, pageSize = 10, categoryId, dateRange } = data

      let query = supabase
        .from('expenses')
        .select(
          'id, amount, currency, category_id, description, created_at, categories (id, name, icon)',
          { count: 'exact' },
        )
        .eq('user_id', user.id)

      if (categoryId) {
        query = query.eq('category_id', categoryId)
      }

      if (dateRange) {
        query = query.gte('created_at', dateRange.from).lte('created_at', dateRange.to)
      }

      const from = pageIndex * pageSize
      const to = from + pageSize - 1

      const { data: results, count, error } = await query
        .order('created_at', { ascending: false })
        .range(from, to)

      if (error) {
        throw error
      }

      const transactions = results.map((row: any) => ({
        id: row.id,
        amount: Number(row.amount),
        currency: row.currency,
        categoryId: row.category_id,
        description: row.description || undefined,
        createdAt: row.created_at,
        category: row.categories
          ? {
              id: row.categories.id,
              name: row.categories.name,
              icon: row.categories.icon ?? null,
            }
          : undefined,
      }))

      return {
        transactions,
        totalCount: count || 0,
      }
    },
  )
