import dayjs from 'dayjs'
import { strToU8, zipSync } from 'fflate'

import { getCurrencySettings } from './appSettings'
import { saveFile } from './fileDownload'
import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
} from './localDb'
import { mainAmountOf } from './money'
import { isLive } from './syncRecords'
import type { Currency, EntryConversion } from './domain'

// CSV is for spreadsheets, not a backup (spec §8): not encrypted, and it
// drops IDs and the time of day. Every field is quoted, so commas, quotes and
// newlines inside a value survive a round trip through localImport.
// Deleted records (tombstones) are never exported, and `rev` has no column.

function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? '')
  return `"${str.replace(/"/g, '""')}"`
}

// main_amount (unrounded) and main_currency; both empty for a pending entry.
function mainColumns(
  entry: { amount: number; currency: Currency; conversion?: EntryConversion },
  main: Currency,
): [string, string] {
  const amount = mainAmountOf(entry, main)
  return amount === null ? ['', ''] : [String(amount), main]
}

function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(',')
}

// The four CSV files, keyed by file name. Dates are the local calendar date.
export async function buildCsvFiles(): Promise<Record<string, string>> {
  const [allExpenses, allCategories, allIncome, allBudgets, settings] =
    await Promise.all([
      getAllExpenses(),
      getAllCategories(),
      getAllIncome(),
      getAllBudgets(),
      getCurrencySettings(),
    ])
  const expenses = allExpenses.filter(isLive)
  const categories = allCategories.filter(isLive)
  const income = allIncome.filter(isLive)
  const budgets = allBudgets.filter(isLive)
  const main = settings.mainCurrency

  // expenses.csv — date, amount, currency, category, description,
  // main_amount, main_currency
  const expenseRows = expenses.map((e) =>
    csvRow([
      dayjs(e.createdAt).format('YYYY-MM-DD'),
      e.amount,
      e.currency,
      e.category?.name ?? '',
      e.description ?? '',
      ...mainColumns(e, main),
    ]),
  )

  // income.csv — date, source, amount, currency, description, main_amount,
  // main_currency. The `source` column holds the income category name
  // (legacy free text as a fallback), so old exports stay importable; import
  // ignores the main_* columns.
  const incomeRows = income.map((i) =>
    csvRow([
      dayjs(i.createdAt).format('YYYY-MM-DD'),
      i.category?.name ?? i.source ?? '',
      i.amount,
      i.currency,
      i.description ?? '',
      ...mainColumns(i, main),
    ]),
  )

  // categories.csv — name, icon (expense categories only)
  const categoryRows = categories.map((c) => csvRow([c.name, c.icon ?? '']))

  // budgets.csv — category, monthly_limit, currency
  const budgetRows = budgets.map((b) =>
    csvRow([b.categoryName, b.monthlyLimit, b.currency]),
  )

  return {
    'expenses.csv': [
      '"date","amount","currency","category","description","main_amount","main_currency"',
      ...expenseRows,
    ].join('\n'),
    'income.csv': [
      '"date","source","amount","currency","description","main_amount","main_currency"',
      ...incomeRows,
    ].join('\n'),
    'categories.csv': ['"name","icon"', ...categoryRows].join('\n'),
    'budgets.csv': [
      '"category","monthly_limit","currency"',
      ...budgetRows,
    ].join('\n'),
  }
}

// One zip with the four CSV files.
export async function buildCsvZip(): Promise<Uint8Array> {
  const files = await buildCsvFiles()
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, strToU8(content)]),
    ),
  )
}

export function csvZipFileName(now = new Date()): string {
  return `minima-csv-${dayjs(now).format('YYYY-MM-DD')}.zip`
}

// A single download of minima-csv-YYYY-MM-DD.zip.
export async function exportAllLocalData(): Promise<void> {
  const zip = await buildCsvZip()
  await saveFile(
    new Blob([new Uint8Array(zip)], { type: 'application/zip' }),
    csvZipFileName(),
  )
}
