import { createServerFn } from '@tanstack/react-start'
import dayjs from 'dayjs'

import { getAuthenticatedClient } from './serverClient'

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `exportAllLocalData` from `localExport.ts` instead.
 * This server function reads from Supabase; all data now lives in IDB.
 */
export const exportExpensesCSV = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data, error } = await supabase
      .from('expenses')
      .select('amount, currency, description, created_at, categories (name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    const rows = data.map((row: any) => {
      const date = dayjs(row.created_at).toISOString().split('T')[0]
      const category = row.categories?.name ?? ''
      const description = (row.description ?? '').replace(/"/g, '""')
      return `"${date}","${row.amount}","${row.currency}","${category}","${description}"`
    })

    const header = '"date","amount","currency","category","description"'
    return [header, ...rows].join('\n')
  },
)

