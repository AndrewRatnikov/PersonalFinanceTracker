import { createServerFn } from '@tanstack/react-start'
import dayjs from 'dayjs'

import { getAuthenticatedClient } from './serverClient'
import type { Currency } from './domain'

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Returns all of the current user's expenses as a CSV string.
 * Columns: date, amount, currency, category, description
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

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportResult {
  inserted: number
  skipped: number
  errors: Array<string>
}

const VALID_CURRENCIES: Array<Currency> = ['UAH', 'USD', 'EUR']

/**
 * Parses a CSV string (same format as the export) and bulk-inserts valid rows.
 * Category is matched case-insensitively against existing user categories.
 */
export const importExpensesCSV = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): string => {
    if (typeof input !== 'string') throw new Error('Expected a CSV string')
    return input
  })
  .handler(async ({ data: csv }): Promise<ImportResult> => {
    const { supabase, user } = await getAuthenticatedClient()

    // Load user categories for name → id lookup
    const { data: catRows, error: catError } = await supabase
      .from('categories')
      .select('id, name')
      .eq('user_id', user.id)

    if (catError) throw catError

    const categoryMap = new Map<string, string>()
    for (const cat of catRows) {
      categoryMap.set(cat.name.toLowerCase(), cat.id)
    }

    const lines = csv
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    // Skip header row if it starts with non-numeric (date/label check)
    const dataLines = lines[0]?.toLowerCase().startsWith('"date"')
      ? lines.slice(1)
      : lines

    const toInsert: Array<object> = []
    const errors: Array<string> = []
    let skipped = 0

    for (let i = 0; i < dataLines.length; i++) {
      const line = dataLines[i]
      // Simple CSV parse: split on commas not inside quotes
      const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) =>
        c
          .replace(/(^,)|(,$)/g, '')
          .replace(/^"|"$/g, '')
          .replace(/""/g, '"'),
      )

      if (!cols || cols.length < 4) {
        errors.push(
          `Row ${i + 2}: expected at least 4 columns, got ${cols?.length ?? 0}`,
        )
        skipped++
        continue
      }

      const [dateStr, amountStr, currency, categoryName, description = ''] =
        cols

      const amount = Number(amountStr)
      if (!Number.isFinite(amount) || amount <= 0) {
        errors.push(`Row ${i + 2}: invalid amount "${amountStr}"`)
        skipped++
        continue
      }

      if (!VALID_CURRENCIES.includes(currency as Currency)) {
        errors.push(`Row ${i + 2}: invalid currency "${currency}"`)
        skipped++
        continue
      }

      const categoryId = categoryMap.get(categoryName.toLowerCase())
      if (!categoryId) {
        errors.push(`Row ${i + 2}: unknown category "${categoryName}"`)
        skipped++
        continue
      }

      const createdAt = dateStr
        ? dayjs(dateStr).toISOString()
        : dayjs().toISOString()

      toInsert.push({
        user_id: user.id,
        amount,
        currency,
        category_id: categoryId,
        description: description || null,
        is_recurring: false,
        created_at: createdAt,
      })
    }

    if (toInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('expenses')
        .insert(toInsert)
      if (insertError) throw insertError
    }

    return { inserted: toInsert.length, skipped, errors }
  })
