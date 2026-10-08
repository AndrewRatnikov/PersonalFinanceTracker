import dayjs from 'dayjs'

import {
  addCategory,
  addExpense,
  addIncome,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  upsertBudget,
} from './localDb'
import { CURRENCIES } from './domain'
import type { Currency } from './domain'

export interface ImportResult {
  inserted: number
  skipped: number
  errors: Array<string>
  // Rows not inserted because they matched an existing record (spec §8).
  duplicates: number
  // Their row numbers, numbered like the "Row N" errors (record index + 2).
  duplicateRows: Array<number>
}

export interface ImportOptions {
  // "Import them anyway": skip the duplicate check.
  allowDuplicates?: boolean
  // When set, only these row numbers are processed.
  rows?: Array<number>
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

const BOM = '\uFEFF'

// ',' or ';' (Excel in the uk-UA locale saves with ';'). Counts the unquoted
// delimiters in the header record; ';' only wins when it outnumbers ','.
export function detectDelimiter(text: string): ',' | ';' {
  let commas = 0
  let semicolons = 0
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++
        else inQuotes = false
      }
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') commas++
    else if (ch === ';') semicolons++
    else if (ch === '\n' || ch === '\r') break
  }
  return semicolons > commas ? ';' : ','
}

// A quote-aware state machine: quoted fields may contain the delimiter,
// newlines (LF or CRLF, kept verbatim) and "" for a literal quote. Records end
// at an unquoted LF or CRLF. Unquoted fields are trimmed, quoted fields are
// kept verbatim. Blank lines are skipped. The first record is the header;
// missing trailing columns become ''. An unterminated quote takes the rest of
// the text as its value.
function parseRecords(text: string, delimiter: string): Array<Array<string>> {
  const records: Array<Array<string>> = []
  let fields: Array<string> = []
  let field = ''
  let quoted = false // the current field started with a quote
  let inQuotes = false
  let firstFieldQuoted = false

  const endField = () => {
    if (fields.length === 0) firstFieldQuoted = quoted
    fields.push(quoted ? field : field.trim())
    field = ''
    quoted = false
  }
  const endRecord = () => {
    endField()
    const blank = fields.length === 1 && fields[0] === '' && !firstFieldQuoted
    if (!blank) records.push(fields)
    fields = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && !quoted && field.trim() === '') {
      inQuotes = true
      quoted = true
      field = ''
    } else if (ch === delimiter) {
      endField()
    } else if (ch === '\n') {
      endRecord()
    } else if (ch === '\r' && text[i + 1] === '\n') {
      endRecord()
      i++
    } else if (quoted) {
      // Text after a closing quote: keep anything but whitespace.
      if (ch.trim() !== '') field += ch
    } else {
      field += ch
    }
  }
  if (field !== '' || quoted || fields.length > 0) endRecord()
  return records
}

export function parseCSV(text: string): Array<Record<string, string>> {
  const source = text.startsWith(BOM) ? text.slice(1) : text
  const records = parseRecords(source, detectDelimiter(source))
  if (records.length < 2) return []
  const headers = records[0].map((h) => h.trim())
  return records.slice(1).map((cols) => {
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? ''
    })
    return row
  })
}

// Accepts a decimal comma ("12,50") and spaces / NBSP as thousands
// separators ("1 234,50"). Anything ambiguous ("1,234,567") is NaN.
export function parseAmount(raw: string): number {
  const compact = raw.trim().replace(/[\s\u00a0\u202f]/g, '')
  if (compact === '') return NaN
  const normalized = /^-?\d+,\d+$/.test(compact)
    ? compact.replace(',', '.')
    : compact
  return Number(normalized)
}

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null
  const trimmed = dateStr.trim()
  const target = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? trimmed + 'T00:00:00'
    : trimmed
  const d = new Date(target)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Duplicate fingerprints (§8) ───────────────────────────────────────────────

function fingerprint(
  createdAt: string,
  amount: number,
  currency: string,
  name: string,
  description: string | null | undefined,
): string {
  const date = dayjs(createdAt).format('YYYY-MM-DD')
  const desc = (description ?? '').replace(/\r\n/g, '\n').trim()
  return `${date}|${String(amount)}|${currency}|${name.trim().toLowerCase()}|${desc}`
}

// date|amount|currency|category|description, with the local calendar date
// (the one export writes).
export function expenseFingerprint(e: {
  createdAt: string
  amount: number
  currency: string
  categoryName: string
  description?: string | null
}): string {
  return fingerprint(
    e.createdAt,
    e.amount,
    e.currency,
    e.categoryName,
    e.description,
  )
}

// date|amount|currency|source|description.
export function incomeFingerprint(i: {
  createdAt: string
  amount: number
  currency: string
  source: string
  description?: string | null
}): string {
  return fingerprint(i.createdAt, i.amount, i.currency, i.source, i.description)
}

function emptyResult(): ImportResult {
  return { inserted: 0, skipped: 0, errors: [], duplicates: 0, duplicateRows: [] }
}

function wantsRow(options: ImportOptions, rowNumber: number): boolean {
  return options.rows === undefined || options.rows.includes(rowNumber)
}

// ── Importers ─────────────────────────────────────────────────────────────────

export async function importCategoriesFromCSV(
  csv: string,
): Promise<ImportResult> {
  const rows = parseCSV(csv)
  const existing = await getAllCategories()
  const existingNames = new Set(
    existing.map((c) => c.name.trim().toLowerCase()),
  )

  const result = emptyResult()

  for (let i = 0; i < rows.length; i++) {
    const { icon } = rows[i]
    const name = (rows[i].name || '').trim()
    if (!name) {
      result.errors.push(`Row ${i + 2}: missing name`)
      result.skipped++
      continue
    }
    if (existingNames.has(name.toLowerCase())) {
      result.skipped++
      continue
    }
    await addCategory({ name, icon: icon || null })
    existingNames.add(name.toLowerCase())
    result.inserted++
  }

  return result
}

export async function importExpensesFromCSV(
  csv: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const categories = await getAllCategories()
  if (categories.length === 0) {
    throw new Error(
      'Import categories.csv first so expense/budget rows can be matched to categories.',
    )
  }
  const categoryMap = new Map(
    categories.map((c) => [c.name.trim().toLowerCase(), c]),
  )

  // Snapshot taken before the import: rows inside one file are not checked
  // against each other.
  const existing = new Set<string>()
  if (!options.allowDuplicates) {
    const nameById = new Map(categories.map((c) => [c.id, c.name]))
    for (const e of await getAllExpenses()) {
      existing.add(
        expenseFingerprint({
          createdAt: e.createdAt,
          amount: e.amount,
          currency: e.currency,
          categoryName: e.category?.name ?? nameById.get(e.categoryId) ?? '',
          description: e.description,
        }),
      )
    }
  }

  const rows = parseCSV(csv)
  const result = emptyResult()

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2
    if (!wantsRow(options, rowNumber)) continue
    const {
      date,
      amount: amountStr,
      currency,
      category: categoryName,
      description,
    } = rows[i]

    const amount = parseAmount(amountStr || '')
    if (!Number.isFinite(amount) || amount <= 0) {
      result.errors.push(`Row ${rowNumber}: invalid amount "${amountStr}"`)
      result.skipped++
      continue
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      result.errors.push(`Row ${rowNumber}: invalid currency "${currency}"`)
      result.skipped++
      continue
    }

    const category = categoryMap.get((categoryName || '').trim().toLowerCase())
    if (!category) {
      result.errors.push(
        `Row ${rowNumber}: unknown category "${categoryName}"`,
      )
      result.skipped++
      continue
    }

    const createdAt = parseDate(date)
    if (!createdAt) {
      result.errors.push(`Row ${rowNumber}: invalid date "${date}"`)
      result.skipped++
      continue
    }

    if (
      !options.allowDuplicates &&
      existing.has(
        expenseFingerprint({
          createdAt,
          amount,
          currency,
          categoryName: category.name,
          description,
        }),
      )
    ) {
      result.duplicates++
      result.duplicateRows.push(rowNumber)
      continue
    }

    await addExpense({
      amount,
      currency: currency as Currency,
      categoryId: category.id,
      description: description || undefined,
      createdAt,
    })
    result.inserted++
  }

  return result
}

export async function importIncomeFromCSV(
  csv: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const existing = new Set<string>()
  if (!options.allowDuplicates) {
    for (const i of await getAllIncome()) {
      existing.add(incomeFingerprint(i))
    }
  }

  const rows = parseCSV(csv)
  const result = emptyResult()

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2
    if (!wantsRow(options, rowNumber)) continue
    const { date, source, amount: amountStr, currency, description } = rows[i]

    if (!source) {
      result.errors.push(`Row ${rowNumber}: missing source`)
      result.skipped++
      continue
    }

    const amount = parseAmount(amountStr || '')
    if (!Number.isFinite(amount) || amount <= 0) {
      result.errors.push(`Row ${rowNumber}: invalid amount "${amountStr}"`)
      result.skipped++
      continue
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      result.errors.push(`Row ${rowNumber}: invalid currency "${currency}"`)
      result.skipped++
      continue
    }

    const createdAt = parseDate(date)
    if (!createdAt) {
      result.errors.push(`Row ${rowNumber}: invalid date "${date}"`)
      result.skipped++
      continue
    }

    if (
      !options.allowDuplicates &&
      existing.has(
        incomeFingerprint({ createdAt, amount, currency, source, description }),
      )
    ) {
      result.duplicates++
      result.duplicateRows.push(rowNumber)
      continue
    }

    await addIncome({
      source,
      amount,
      currency: currency as Currency,
      description: description || undefined,
      createdAt,
    })
    result.inserted++
  }

  return result
}

export async function importBudgetsFromCSV(csv: string): Promise<ImportResult> {
  const categories = await getAllCategories()
  if (categories.length === 0) {
    throw new Error(
      'Import categories.csv first so expense/budget rows can be matched to categories.',
    )
  }
  const categoryMap = new Map(
    categories.map((c) => [c.name.trim().toLowerCase(), c.id]),
  )

  const rows = parseCSV(csv)
  const result = emptyResult()

  for (let i = 0; i < rows.length; i++) {
    const {
      category: categoryName,
      monthly_limit: limitStr,
      currency,
    } = rows[i]

    const categoryId = categoryMap.get((categoryName || '').trim().toLowerCase())
    if (!categoryId) {
      result.errors.push(`Row ${i + 2}: unknown category "${categoryName}"`)
      result.skipped++
      continue
    }

    const monthlyLimit = parseAmount(limitStr || '')
    if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
      result.errors.push(`Row ${i + 2}: invalid monthly_limit "${limitStr}"`)
      result.skipped++
      continue
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      result.errors.push(`Row ${i + 2}: invalid currency "${currency}"`)
      result.skipped++
      continue
    }

    await upsertBudget({
      categoryId,
      monthlyLimit,
      currency: currency as Currency,
    })
    result.inserted++
  }

  return result
}

export async function importLocalDataFile(
  file: File,
  options: ImportOptions = {},
): Promise<{ type: string; result: ImportResult }> {
  const text = await file.text()
  const filename = file.name.toLowerCase()

  if (filename.includes('categories')) {
    return { type: 'categories', result: await importCategoriesFromCSV(text) }
  }
  if (filename.includes('expenses')) {
    return {
      type: 'expenses',
      result: await importExpensesFromCSV(text, options),
    }
  }
  if (filename.includes('income')) {
    return { type: 'income', result: await importIncomeFromCSV(text, options) }
  }
  if (filename.includes('budgets')) {
    return { type: 'budgets', result: await importBudgetsFromCSV(text) }
  }

  // Header-sniff fallback
  const rows = parseCSV(text)
  if (rows.length === 0) {
    throw new Error(
      `Cannot detect file type for "${file.name}": file is empty or has no data rows`,
    )
  }
  const headers = Object.keys(rows[0])

  if (headers.includes('source')) {
    return { type: 'income', result: await importIncomeFromCSV(text, options) }
  }
  if (headers.includes('monthly_limit')) {
    return { type: 'budgets', result: await importBudgetsFromCSV(text) }
  }
  if (headers.includes('category')) {
    return {
      type: 'expenses',
      result: await importExpensesFromCSV(text, options),
    }
  }
  if (headers.includes('name') && headers.includes('icon')) {
    return { type: 'categories', result: await importCategoriesFromCSV(text) }
  }

  throw new Error(
    `Cannot detect file type for "${file.name}": unrecognised columns [${headers.join(', ')}]`,
  )
}
