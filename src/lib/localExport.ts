import dayjs from 'dayjs'
import { strToU8, zipSync } from 'fflate'

import { getCurrencySettings } from './appSettings'
import { saveFile } from './fileDownload'
import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getSpaceInfo,
  listLocalSpaces,
} from './localDb'
import { mainAmountOf } from './money'
import { dbFor, spaceArgs } from './spaces/spaceDb'
import { PERSONAL_SPACE_ID } from './spaces/types'
import { isLive } from './syncRecords'
import type { Currency, EntryConversion } from './domain'
import type { SpaceOption } from './spaces/spaceDb'

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

// The four CSV files of one space (personal by default), keyed by file name.
// Dates are the local calendar date.
export async function buildCsvFiles(opts?: SpaceOption): Promise<Record<string, string>> {
  const spaceId = opts?.spaceId ?? PERSONAL_SPACE_ID
  const db = spaceId === PERSONAL_SPACE_ID ? null : dbFor(spaceId)
  const [allExpenses, allCategories, allIncome, allBudgets, settings] =
    await Promise.all([
      db ? db.getAllExpenses() : getAllExpenses(),
      db ? db.getAllCategories() : getAllCategories(),
      db ? db.getAllIncome() : getAllIncome(),
      db ? db.getAllBudgets() : getAllBudgets(),
      getCurrencySettings(...spaceArgs(spaceId)),
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

// One zip with the four CSV files of the space.
export async function buildCsvZip(opts?: SpaceOption): Promise<Uint8Array> {
  const spaceId = opts?.spaceId ?? PERSONAL_SPACE_ID
  const files = await buildCsvFiles(...spaceArgs(spaceId))
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, strToU8(content)]),
    ),
  )
}

const SLUG_MAX = 40

// The space name in a file name: lowercase, every run of characters other
// than a-z, 0-9 and Cyrillic letters becomes "-", trimmed of "-", at most 40
// characters, "family" when nothing is left.
function spaceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return slug || 'family'
}

// Personal: minima-csv-YYYY-MM-DD.zip. With a (Family) space name:
// minima-csv-<slug>-YYYY-MM-DD.zip.
export function csvZipFileName(now = new Date(), spaceName?: string): string {
  const date = dayjs(now).format('YYYY-MM-DD')
  if (spaceName === undefined) return `minima-csv-${date}.zip`
  return `minima-csv-${spaceSlug(spaceName)}-${date}.zip`
}

async function familySpaceName(spaceId: string): Promise<string> {
  try {
    const info = await getSpaceInfo(spaceId)
    if (info?.name) return info.name
  } catch {
    // Fall back to the name in the space keys.
  }
  const listed = (await listLocalSpaces()).find((s) => s.id === spaceId)
  return listed?.name ?? ''
}

// A single download of the space's zip (personal: minima-csv-YYYY-MM-DD.zip).
export async function exportAllLocalData(opts?: SpaceOption): Promise<void> {
  const spaceId = opts?.spaceId ?? PERSONAL_SPACE_ID
  const zip = await buildCsvZip(...spaceArgs(spaceId))
  const filename =
    spaceId === PERSONAL_SPACE_ID
      ? csvZipFileName()
      : csvZipFileName(new Date(), await familySpaceName(spaceId))
  await saveFile(new Blob([new Uint8Array(zip)], { type: 'application/zip' }), filename)
}
