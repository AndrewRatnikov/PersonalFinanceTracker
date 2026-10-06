// No CONTRACT_GAPs: exportAllLocalData and the import round trip (#3) are
// fully specified in the Interface Contract.

import dayjs from 'dayjs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportAllLocalData } from '@/lib/localExport'
import { importExpensesFromCSV, importIncomeFromCSV } from '@/lib/localImport'
import {
  addExpense,
  addIncome,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getAllExpenses: vi.fn(),
  getAllCategories: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  addExpense: vi.fn(),
  addIncome: vi.fn(),
  addCategory: vi.fn(),
  upsertBudget: vi.fn(),
}))

const originalTZ = process.env.TZ
process.env.TZ = 'Europe/Kyiv'
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

const FOOD = { id: 'c1', name: 'Food', icon: null }

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const createObjectURL = vi.fn((_blob: Blob) => 'blob:x')

async function runExport(
  expenseDates: Array<string>,
  incomeDates: Array<string>,
) {
  vi.mocked(getAllExpenses).mockResolvedValue(
    expenseDates.map((createdAt, i) => ({
      id: `e${i}`,
      amount: 10,
      currency: 'UAH' as const,
      categoryId: 'c1',
      description: null,
      createdAt,
      category: FOOD,
    })),
  )
  vi.mocked(getAllIncome).mockResolvedValue(
    incomeDates.map((createdAt, i) => ({
      id: `i${i}`,
      source: 'Job',
      amount: 500,
      currency: 'UAH' as const,
      description: null,
      createdAt,
    })),
  )
  vi.mocked(getAllCategories).mockResolvedValue([FOOD])
  vi.mocked(getAllBudgets).mockResolvedValue([])

  await exportAllLocalData()

  const expensesBlob = createObjectURL.mock.calls[0][0]
  const incomeBlob = createObjectURL.mock.calls[1][0]
  return {
    expensesCsv: await readBlob(expensesBlob),
    incomeCsv: await readBlob(incomeBlob),
  }
}

describe('exportAllLocalData writes local calendar dates (#3)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    createObjectURL.mockClear()
    createObjectURL.mockImplementation(() => 'blob:x')
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('exports the Kyiv date for an expense at 01:30 local (23:30Z the day before)', async () => {
    const { expensesCsv } = await runExport(['2024-01-14T23:30:00.000Z'], [])

    expect(expensesCsv).toContain('"2024-01-15"')
    expect(expensesCsv).not.toContain('"2024-01-14"')
  })

  it('exports the Kyiv date for an income entry at 01:30 local (23:30Z the day before)', async () => {
    const { incomeCsv } = await runExport([], ['2024-01-14T23:30:00.000Z'])

    expect(incomeCsv).toContain('"2024-01-15"')
    expect(incomeCsv).not.toContain('"2024-01-14"')
  })

  it('uses the summer offset too (21:30Z is the next local day in June)', async () => {
    const { expensesCsv } = await runExport(['2024-06-10T21:30:00.000Z'], [])

    expect(expensesCsv).toContain('"2024-06-11"')
  })

  it('round trip: exported expenses re-import to the same local date', async () => {
    const { expensesCsv } = await runExport(['2024-01-14T23:30:00.000Z'], [])
    vi.mocked(addExpense).mockReset()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])

    const result = await importExpensesFromCSV(expensesCsv)

    expect(result.inserted).toBe(1)
    const imported = vi.mocked(addExpense).mock.calls[0][0]
    expect(dayjs(imported.createdAt).format('YYYY-MM-DD')).toBe('2024-01-15')
  })

  it('round trip: exported income re-imports to the same local date', async () => {
    const { incomeCsv } = await runExport([], ['2024-01-14T23:30:00.000Z'])
    vi.mocked(addIncome).mockReset()

    const result = await importIncomeFromCSV(incomeCsv)

    expect(result.inserted).toBe(1)
    const imported = vi.mocked(addIncome).mock.calls[0][0]
    expect(dayjs(imported.createdAt).format('YYYY-MM-DD')).toBe('2024-01-15')
  })
})
