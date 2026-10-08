import dayjs from 'dayjs'
import { strToU8, zipSync } from 'fflate'

import { saveFile } from './fileDownload'
import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
} from './localDb'

// CSV is for spreadsheets, not a backup (spec §8): not encrypted, and it
// drops IDs and the time of day. Every field is quoted, so commas, quotes and
// newlines inside a value survive a round trip through localImport.

function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? '')
  return `"${str.replace(/"/g, '""')}"`
}

function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(',')
}

// The four CSV files, keyed by file name. Dates are the local calendar date.
export async function buildCsvFiles(): Promise<Record<string, string>> {
  const [expenses, categories, income, budgets] = await Promise.all([
    getAllExpenses(),
    getAllCategories(),
    getAllIncome(),
    getAllBudgets(),
  ])

  // expenses.csv — date, amount, currency, category, description
  const expenseRows = expenses.map((e) =>
    csvRow([
      dayjs(e.createdAt).format('YYYY-MM-DD'),
      e.amount,
      e.currency,
      e.category?.name ?? '',
      e.description ?? '',
    ]),
  )

  // income.csv — date, source, amount, currency, description
  const incomeRows = income.map((i) =>
    csvRow([
      dayjs(i.createdAt).format('YYYY-MM-DD'),
      i.source,
      i.amount,
      i.currency,
      i.description ?? '',
    ]),
  )

  // categories.csv — name, icon
  const categoryRows = categories.map((c) => csvRow([c.name, c.icon ?? '']))

  // budgets.csv — category, monthly_limit, currency
  const budgetRows = budgets.map((b) =>
    csvRow([b.categoryName, b.monthlyLimit, b.currency]),
  )

  return {
    'expenses.csv': [
      '"date","amount","currency","category","description"',
      ...expenseRows,
    ].join('\n'),
    'income.csv': [
      '"date","source","amount","currency","description"',
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
