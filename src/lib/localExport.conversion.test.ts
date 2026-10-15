// No CONTRACT_GAPs: the main_amount / main_currency columns of expenses.csv and
// income.csv and the unchanged budgets.csv are fully specified in the
// Interface Contract (module: localExport) and plan section 12. The main
// currency is read through getCurrencySettings (mocked here).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Currency, EntryConversion, Expense, IncomeEntry } from '@/lib/domain'
import { getCurrencySettings } from '@/lib/appSettings'
import { buildCsvFiles } from '@/lib/localExport'
import { importLocalDataFile } from '@/lib/localImport'
import {
  addExpense,
  addIncome,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getAllExpenses: vi.fn(),
  getAllCategories: vi.fn(),
  getAllIncome: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  getAllBudgets: vi.fn(),
  addExpense: vi.fn(),
  addIncome: vi.fn(),
  addCategory: vi.fn(),
  addIncomeCategory: vi.fn(),
  upsertBudget: vi.fn(),
}))
vi.mock('@/lib/appSettings', () => ({ getCurrencySettings: vi.fn() }))
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))

const originalTZ = process.env.TZ
process.env.TZ = 'Europe/Kyiv'
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

const FOOD = { id: 'c1', name: 'Food', icon: null }
const JOB = { id: 'ic1', name: 'Job', icon: null }
const EXPENSE_HEADER =
  '"date","amount","currency","category","description","main_amount","main_currency"'
const INCOME_HEADER =
  '"date","source","amount","currency","description","main_amount","main_currency"'

function conv(main: Currency, mainAmount: number, rate = 1): EntryConversion {
  return { mainCurrency: main, rate, mainAmount, rateDate: '2024-03-10', source: 'nbu' }
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    amount: 20,
    currency: 'USD',
    categoryId: 'c1',
    description: null,
    createdAt: '2024-03-10T10:00:00.000Z',
    category: FOOD,
    ...overrides,
  }
}

function income(overrides: Partial<IncomeEntry> = {}): IncomeEntry {
  return {
    id: 'i1',
    categoryId: 'ic1',
    category: JOB,
    amount: 500,
    currency: 'EUR',
    description: null,
    createdAt: '2024-03-11T10:00:00.000Z',
    ...overrides,
  }
}

function seed(
  expenses: Array<Expense>,
  incomes: Array<IncomeEntry> = [],
  main: Currency = 'UAH',
) {
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: main,
    fetchExchangeRates: true,
  })
  vi.mocked(getAllExpenses).mockResolvedValue(expenses)
  vi.mocked(getAllIncome).mockResolvedValue(incomes)
  vi.mocked(getAllCategories).mockResolvedValue([FOOD])
  vi.mocked(getAllIncomeCategories).mockResolvedValue([JOB])
  vi.mocked(getAllBudgets).mockResolvedValue([])
}

function csvFile(name: string, text: string): File {
  return Object.assign(new File([text], name), {
    text: () => Promise.resolve(text),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('expenses.csv', () => {
  it('has main_amount and main_currency as the last two columns', async () => {
    seed([])

    const files = await buildCsvFiles()

    expect(files['expenses.csv']).toBe(EXPENSE_HEADER)
  })

  it('writes the unrounded main amount and the main currency of a converted entry', async () => {
    seed([expense({ conversion: conv('UAH', 830.4, 41.52) })])

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')).toEqual([
      EXPENSE_HEADER,
      '"2024-03-10","20","USD","Food","","830.4","UAH"',
    ])
  })

  it('does not round the main amount', async () => {
    seed([expense({ amount: 1, conversion: conv('UAH', 33.333333333, 33.333333333) })])

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')[1]).toContain('"33.333333333","UAH"')
  })

  it('writes an entry in the main currency at its amount even before its conversion is stored', async () => {
    seed([expense({ currency: 'UAH', amount: 100 })])

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')[1]).toBe(
      '"2024-03-10","100","UAH","Food","","100","UAH"',
    )
  })

  it('leaves both columns empty for a pending entry', async () => {
    seed([expense()])

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')[1]).toBe(
      '"2024-03-10","20","USD","Food","","",""',
    )
  })

  it('treats a conversion made for another main currency as pending', async () => {
    seed([expense({ conversion: conv('UAH', 830.4, 41.52) })], [], 'EUR')

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')[1]).toBe(
      '"2024-03-10","20","USD","Food","","",""',
    )
  })

  it('follows the main currency: an EUR-converted entry exports EUR columns', async () => {
    seed([expense({ conversion: conv('EUR', 18.4, 0.92) })], [], 'EUR')

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')[1]).toBe(
      '"2024-03-10","20","USD","Food","","18.4","EUR"',
    )
  })

  it('keeps one row per entry with different main amounts', async () => {
    seed([
      expense({ id: 'a', conversion: conv('UAH', 830.4, 41.52) }),
      expense({ id: 'b', amount: 10, conversion: conv('UAH', 415.2, 41.52) }),
    ])

    const lines = (await buildCsvFiles())['expenses.csv'].split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('"830.4","UAH"')
    expect(lines[2]).toContain('"415.2","UAH"')
  })
})

describe('income.csv', () => {
  it('has main_amount and main_currency as the last two columns', async () => {
    seed([])

    const files = await buildCsvFiles()

    expect(files['income.csv']).toBe(INCOME_HEADER)
  })

  it('writes the main amount of a converted entry and leaves a pending one empty', async () => {
    seed(
      [],
      [
        income({ id: 'done', conversion: conv('UAH', 22550, 45.1) }),
        income({ id: 'wait', amount: 9 }),
        income({ id: 'own', currency: 'UAH', amount: 70 }),
      ],
    )

    const lines = (await buildCsvFiles())['income.csv'].split('\n')

    expect(lines).toEqual([
      INCOME_HEADER,
      '"2024-03-11","Job","500","EUR","","22550","UAH"',
      '"2024-03-11","Job","9","EUR","","",""',
      '"2024-03-11","Job","70","UAH","","70","UAH"',
    ])
  })
})

describe('the other files', () => {
  it('keeps budgets.csv and categories.csv as they were', async () => {
    seed([])
    vi.mocked(getAllBudgets).mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'c1',
        monthlyLimit: 300,
        currency: 'UAH',
        categoryName: 'Food',
        categoryIcon: null,
      },
    ])

    const files = await buildCsvFiles()

    expect(files['budgets.csv'].split('\n')).toEqual([
      '"category","monthly_limit","currency"',
      '"Food","300","UAH"',
    ])
    expect(files['categories.csv'].split('\n')).toEqual(['"name","icon"', '"Food",""'])
  })
})

describe('importing an exported file', () => {
  it('detects an exported expenses file by its headers and ignores the main_* columns', async () => {
    seed([expense({ conversion: conv('UAH', 830.4, 41.52) })])
    const { 'expenses.csv': csv } = await buildCsvFiles()
    vi.mocked(getAllExpenses).mockResolvedValue([])

    const { type, result } = await importLocalDataFile(csvFile('export.csv', csv))

    expect(type).toBe('expenses')
    expect(result.errors).toEqual([])
    expect(result.inserted).toBe(1)
    const input = vi.mocked(addExpense).mock.calls[0][0]
    expect(input.amount).toBe(20)
    expect(input.currency).toBe('USD')
    expect(input.categoryId).toBe('c1')
    expect(Object.keys(input).sort()).toEqual(
      ['amount', 'categoryId', 'createdAt', 'currency', 'description'].sort(),
    )
  })

  it('detects an exported income file by its source header and ignores the main_* columns', async () => {
    seed([], [income({ conversion: conv('UAH', 22550, 45.1) })])
    const { 'income.csv': csv } = await buildCsvFiles()
    vi.mocked(getAllIncome).mockResolvedValue([])

    const { type, result } = await importLocalDataFile(csvFile('export.csv', csv))

    expect(type).toBe('income')
    expect(result.errors).toEqual([])
    expect(result.inserted).toBe(1)
    const input = vi.mocked(addIncome).mock.calls[0][0]
    expect(input.amount).toBe(500)
    expect(input.currency).toBe('EUR')
    expect(Object.keys(input).sort()).toEqual(
      ['amount', 'categoryId', 'createdAt', 'currency', 'description'].sort(),
    )
  })

  it('imports rows with empty main columns (pending entries) the same way', async () => {
    seed([expense()])
    const { 'expenses.csv': csv } = await buildCsvFiles()
    vi.mocked(getAllExpenses).mockResolvedValue([])

    const { result } = await importLocalDataFile(csvFile('expenses.csv', csv))

    expect(result.inserted).toBe(1)
    expect(vi.mocked(addExpense).mock.calls[0][0].amount).toBe(20)
  })

  it('still detects a budgets file by monthly_limit', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])

    const { type } = await importLocalDataFile(
      csvFile('export.csv', '"category","monthly_limit","currency"\n"Food","300","UAH"'),
    )

    expect(type).toBe('budgets')
  })
})
