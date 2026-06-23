import {
  getAllCategories,
  addCategory,
  addExpense,
  addIncome,
  upsertBudget,
} from './localDb'
import { CURRENCIES } from './domain'
import type { Currency } from './domain'

export interface ImportResult {
  inserted: number
  skipped: number
  errors: Array<string>
}

function parseLine(line: string): Array<string> {
  const cols: Array<string> = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      i++
      let val = ''
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          val += '"'
          i += 2
        } else if (line[i] === '"') {
          i++
          break
        } else {
          val += line[i++]
        }
      }
      cols.push(val)
      if (line[i] === ',') i++
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) {
        cols.push(line.slice(i))
        break
      }
      cols.push(line.slice(i, end))
      i = end + 1
    }
  }
  return cols
}

function parseCSV(text: string): Array<Record<string, string>> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const headers = parseLine(lines[0])
  return lines.slice(1).map((line, idx) => {
    const cols = parseLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? ''
    })
    return row
  })
}

function parseDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString()
  const trimmed = dateStr.trim()
  const target = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + 'T00:00:00' : trimmed
  const d = new Date(target)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

export async function importCategoriesFromCSV(csv: string): Promise<ImportResult> {
  const rows = parseCSV(csv)
  const existing = await getAllCategories()
  const existingNames = new Set(existing.map((c) => c.name.toLowerCase()))

  let inserted = 0
  let skipped = 0
  const errors: Array<string> = []

  for (let i = 0; i < rows.length; i++) {
    const { name, icon } = rows[i]
    if (!name) {
      errors.push(`Row ${i + 2}: missing name`)
      skipped++
      continue
    }
    if (existingNames.has(name.toLowerCase())) {
      skipped++
      continue
    }
    await addCategory({ name, icon: icon || null })
    existingNames.add(name.toLowerCase())
    inserted++
  }

  return { inserted, skipped, errors }
}

export async function importExpensesFromCSV(csv: string): Promise<ImportResult> {
  const categories = await getAllCategories()
  if (categories.length === 0) {
    throw new Error(
      'Import categories.csv first so expense/budget rows can be matched to categories.',
    )
  }
  const categoryMap = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]))

  const rows = parseCSV(csv)
  let inserted = 0
  let skipped = 0
  const errors: Array<string> = []

  for (let i = 0; i < rows.length; i++) {
    const { date, amount: amountStr, currency, category: categoryName, description } = rows[i]

    const amount = Number(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${i + 2}: invalid amount "${amountStr}"`)
      skipped++
      continue
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      errors.push(`Row ${i + 2}: invalid currency "${currency}"`)
      skipped++
      continue
    }

    const categoryId = categoryMap.get(categoryName?.toLowerCase() ?? '')
    if (!categoryId) {
      errors.push(`Row ${i + 2}: unknown category "${categoryName}"`)
      skipped++
      continue
    }

    await addExpense({
      amount,
      currency: currency as Currency,
      categoryId,
      description: description || undefined,
      createdAt: parseDate(date),
    })
    inserted++
  }

  return { inserted, skipped, errors }
}

export async function importIncomeFromCSV(csv: string): Promise<ImportResult> {
  const rows = parseCSV(csv)
  let inserted = 0
  let skipped = 0
  const errors: Array<string> = []

  for (let i = 0; i < rows.length; i++) {
    const { date, source, amount: amountStr, currency, description } = rows[i]

    if (!source) {
      errors.push(`Row ${i + 2}: missing source`)
      skipped++
      continue
    }

    const amount = Number(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${i + 2}: invalid amount "${amountStr}"`)
      skipped++
      continue
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      errors.push(`Row ${i + 2}: invalid currency "${currency}"`)
      skipped++
      continue
    }

    await addIncome({
      source,
      amount,
      currency: currency as Currency,
      description: description || undefined,
      createdAt: parseDate(date),
    })
    inserted++
  }

  return { inserted, skipped, errors }
}

export async function importBudgetsFromCSV(csv: string): Promise<ImportResult> {
  const categories = await getAllCategories()
  if (categories.length === 0) {
    throw new Error(
      'Import categories.csv first so expense/budget rows can be matched to categories.',
    )
  }
  const categoryMap = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]))

  const rows = parseCSV(csv)
  let inserted = 0
  let skipped = 0
  const errors: Array<string> = []

  for (let i = 0; i < rows.length; i++) {
    const { category: categoryName, monthly_limit: limitStr, currency } = rows[i]

    const categoryId = categoryMap.get(categoryName?.toLowerCase() ?? '')
    if (!categoryId) {
      errors.push(`Row ${i + 2}: unknown category "${categoryName}"`)
      skipped++
      continue
    }

    const monthlyLimit = Number(limitStr)
    if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
      errors.push(`Row ${i + 2}: invalid monthly_limit "${limitStr}"`)
      skipped++
      continue
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      errors.push(`Row ${i + 2}: invalid currency "${currency}"`)
      skipped++
      continue
    }

    await upsertBudget({ categoryId, monthlyLimit, currency: currency as Currency })
    inserted++
  }

  return { inserted, skipped, errors }
}

export async function importLocalDataFile(
  file: File,
): Promise<{ type: string; result: ImportResult }> {
  const text = await file.text()
  const filename = file.name.toLowerCase()

  if (filename.includes('categories')) {
    return { type: 'categories', result: await importCategoriesFromCSV(text) }
  }
  if (filename.includes('expenses')) {
    return { type: 'expenses', result: await importExpensesFromCSV(text) }
  }
  if (filename.includes('income')) {
    return { type: 'income', result: await importIncomeFromCSV(text) }
  }
  if (filename.includes('budgets')) {
    return { type: 'budgets', result: await importBudgetsFromCSV(text) }
  }

  // Header-sniff fallback
  const rows = parseCSV(text)
  if (rows.length === 0) {
    throw new Error(`Cannot detect file type for "${file.name}": file is empty or has no data rows`)
  }
  const headers = Object.keys(rows[0])

  if (headers.includes('source')) {
    return { type: 'income', result: await importIncomeFromCSV(text) }
  }
  if (headers.includes('monthly_limit')) {
    return { type: 'budgets', result: await importBudgetsFromCSV(text) }
  }
  if (headers.includes('category')) {
    return { type: 'expenses', result: await importExpensesFromCSV(text) }
  }
  if (headers.includes('name') && headers.includes('icon')) {
    return { type: 'categories', result: await importCategoriesFromCSV(text) }
  }

  throw new Error(
    `Cannot detect file type for "${file.name}": unrecognised columns [${headers.join(', ')}]`,
  )
}
