import { createServerFn } from '@tanstack/react-start'

import { getAuthenticatedClient } from './serverClient'
import { CURRENCIES } from './domain'
import type { CreateIncomeInput, Currency, IncomeEntry } from './domain'

export interface GetIncomePaginatedInput {
  pageIndex?: number
  pageSize?: number
}

export interface GetIncomePaginatedOutput {
  income: Array<IncomeEntry>
  totalCount: number
}

export const getIncomePaginated = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown): GetIncomePaginatedInput => {
    const payload = (input as GetIncomePaginatedInput) || {}
    return {
      pageIndex: typeof payload.pageIndex === 'number' ? payload.pageIndex : 0,
      pageSize: typeof payload.pageSize === 'number' ? payload.pageSize : 10,
    }
  })
  .handler(async ({ data }): Promise<GetIncomePaginatedOutput> => {
    const { supabase, user } = await getAuthenticatedClient()
    const { pageIndex = 0, pageSize = 10 } = data

    const from = pageIndex * pageSize
    const to = from + pageSize - 1

    const { data: results, count, error } = await supabase
      .from('income')
      .select('id, source, amount, currency, description, created_at', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const income = results.map((row: any) => ({
      id: row.id,
      source: row.source,
      amount: Number(row.amount),
      currency: row.currency,
      description: row.description ?? null,
      createdAt: row.created_at,
    }))

    return { income, totalCount: count || 0 }
  })

export const createIncome = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): CreateIncomeInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid income payload')
    }

    const { source, amount, currency, description } = input as {
      source?: unknown
      amount?: unknown
      currency?: unknown
      description?: unknown
    }

    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('Source is required')
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number')
    }

    if (typeof currency !== 'string' || !CURRENCIES.includes(currency as Currency)) {
      throw new Error('Unsupported currency')
    }

    const trimmedDescription =
      typeof description === 'string' && description.trim() ? description.trim() : undefined

    return {
      source: source.trim(),
      amount,
      currency: currency as Currency,
      description: trimmedDescription,
    }
  })
  .handler(async ({ data }): Promise<IncomeEntry> => {
    const { supabase, user } = await getAuthenticatedClient()
    const { source, amount, currency, description } = data

    const { data: inserted, error } = await supabase
      .from('income')
      .insert({
        user_id: user.id,
        source,
        amount,
        currency,
        description: description ?? null,
      })
      .select('id, source, amount, currency, description, created_at')
      .single()

    if (error) throw error

    return {
      id: inserted.id,
      source: inserted.source,
      amount: Number(inserted.amount),
      currency: inserted.currency,
      description: inserted.description ?? null,
      createdAt: inserted.created_at,
    }
  })

export const deleteIncome = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): string => {
    if (typeof input !== 'string' || !input) {
      throw new Error('Income ID is required')
    }
    return input
  })
  .handler(async ({ data }): Promise<void> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { error } = await supabase
      .from('income')
      .delete()
      .eq('id', data)
      .eq('user_id', user.id)

    if (error) throw error
  })

export interface GetIncomeTotalForRangeInput {
  from: string
  to: string
}

export const getIncomeTotalForRange = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown): GetIncomeTotalForRangeInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid range payload')
    }
    const { from, to } = input as { from?: unknown; to?: unknown }
    if (typeof from !== 'string' || !from) throw new Error('from is required')
    if (typeof to !== 'string' || !to) throw new Error('to is required')
    return { from, to }
  })
  .handler(async ({ data }): Promise<number> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data: rows, error } = await supabase
      .from('income')
      .select('amount')
      .eq('user_id', user.id)
      .gte('created_at', data.from)
      .lte('created_at', data.to)

    if (error) throw error

    return rows.reduce((sum: number, row: any) => sum + Number(row.amount), 0)
  })
