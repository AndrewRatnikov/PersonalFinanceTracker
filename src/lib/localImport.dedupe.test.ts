// No CONTRACT_GAPs: fingerprints, ImportOptions and the duplicate counters are
// fully specified in the Interface Contract (module: localImport).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  expenseFingerprint,
  importBudgetsFromCSV,
  importCategoriesFromCSV,
  importExpensesFromCSV,
  importIncomeFromCSV,
  importLocalDataFile,
  incomeFingerprint,
} from '@/lib/localImport'
import {
  addCategory,
  addExpense,
  addIncome,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  upsertBudget,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  addCategory: vi.fn(),
  addExpense: vi.fn(),
  addIncome: vi.fn(),
  getAllCategories: vi.fn(),
  getAllExpenses: vi.fn(),
  getAllIncome: vi.fn(),
  upsertBudget: vi.fn(),
}))

const FOOD = { id: 'c1', name: 'Food', icon: null }
const TAXI = { id: 'c2', name: 'Taxi', icon: null }

// Local midday, so the local calendar date is the same in every time zone.
function localNoon(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d, 12, 0, 0).toISOString()
}

function existingExpense(
  id: string,
  createdAt: string,
  amount: number,
  description: string | null,
  withJoinedCategory = true,
) {
  return {
    id,
    amount,
    currency: 'UAH' as const,
    categoryId: FOOD.id,
    description,
    createdAt,
    updatedAt: createdAt,
    ...(withJoinedCategory ? { category: FOOD } : {}),
  }
}

const EXPENSE_HEADER = 'date,amount,currency,category,description'
const INCOME_HEADER = 'date,source,amount,currency,description'

function file(name: string, content: string): File {
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAllCategories).mockResolvedValue([FOOD, TAXI])
  vi.mocked(getAllExpenses).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
})

describe('expenseFingerprint', () => {
  const base = {
    createdAt: localNoon(2024, 1, 15),
    amount: 10,
    currency: 'UAH',
    categoryName: 'Food',
    description: 'lunch',
  }

  it('is date|amount|currency|category|description', () => {
    expect(expenseFingerprint(base)).toBe('2024-01-15|10|UAH|food|lunch')
  })

  it('uses the local calendar date, not the time of day', () => {
    const morning = new Date(2024, 0, 15, 0, 5).toISOString()
    const evening = new Date(2024, 0, 15, 23, 55).toISOString()

    expect(expenseFingerprint({ ...base, createdAt: morning })).toBe(
      expenseFingerprint({ ...base, createdAt: evening }),
    )
    expect(
      expenseFingerprint({ ...base, createdAt: localNoon(2024, 1, 16) }),
    ).not.toBe(expenseFingerprint(base))
  })

  it('lowercases and trims the category name', () => {
    expect(expenseFingerprint({ ...base, categoryName: '  FOOD ' })).toBe(
      expenseFingerprint(base),
    )
  })

  it('normalises CRLF in the description and trims it', () => {
    const lf = expenseFingerprint({ ...base, description: 'a\nb' })

    expect(expenseFingerprint({ ...base, description: ' a\r\nb ' })).toBe(lf)
  })

  it('treats null, undefined and empty descriptions alike', () => {
    const empty = expenseFingerprint({ ...base, description: '' })

    expect(expenseFingerprint({ ...base, description: null })).toBe(empty)
    expect(expenseFingerprint({ ...base, description: undefined })).toBe(empty)
    expect(empty.endsWith('|')).toBe(true)
  })

  it('differs when amount, currency or description differ', () => {
    const fp = expenseFingerprint(base)

    expect(expenseFingerprint({ ...base, amount: 11 })).not.toBe(fp)
    expect(expenseFingerprint({ ...base, currency: 'USD' })).not.toBe(fp)
    expect(expenseFingerprint({ ...base, description: 'dinner' })).not.toBe(fp)
    expect(expenseFingerprint({ ...base, categoryName: 'Taxi' })).not.toBe(fp)
  })
})

describe('incomeFingerprint', () => {
  const base = {
    createdAt: localNoon(2024, 2, 1),
    amount: 1500.5,
    currency: 'USD',
    source: ' Job ',
    description: null,
  }

  it('is date|amount|currency|source|description', () => {
    expect(incomeFingerprint(base)).toBe('2024-02-01|1500.5|USD|job|')
  })

  it('differs when the source or amount differ', () => {
    const fp = incomeFingerprint(base)

    expect(incomeFingerprint({ ...base, source: 'Gig' })).not.toBe(fp)
    expect(incomeFingerprint({ ...base, amount: 1500 })).not.toBe(fp)
    expect(incomeFingerprint({ ...base, source: 'JOB' })).toBe(fp)
  })
})

describe('expenses: duplicates against existing records', () => {
  it('skips a row that matches an existing expense and reports it', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch'),
    ])

    const result = await importExpensesFromCSV(
      [EXPENSE_HEADER, '2024-01-15,10,UAH,Food,lunch'].join('\n'),
    )

    expect(result.inserted).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.duplicateRows).toEqual([2])
    expect(result.errors).toEqual([])
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('inserts a row whose date, amount or description differ', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch'),
    ])

    const result = await importExpensesFromCSV(
      [
        EXPENSE_HEADER,
        '2024-01-16,10,UAH,Food,lunch',
        '2024-01-15,11,UAH,Food,lunch',
        '2024-01-15,10,UAH,Food,dinner',
        '2024-01-15,10,USD,Food,lunch',
        '2024-01-15,10,UAH,Taxi,lunch',
      ].join('\n'),
    )

    expect(result.inserted).toBe(5)
    expect(result.duplicates).toBe(0)
    expect(result.duplicateRows).toEqual([])
  })

  it('numbers duplicate rows like the "Row N" errors (record index + 2)', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch'),
      existingExpense('e2', localNoon(2024, 1, 17), 30, null),
    ])

    const result = await importExpensesFromCSV(
      [
        EXPENSE_HEADER,
        '2024-01-15,10,UAH,Food,lunch',
        '2024-01-16,20,UAH,Food,new',
        '2024-01-17,30,UAH,Food,',
        '2024-01-18,abc,UAH,Food,bad',
      ].join('\n'),
    )

    expect(result.duplicates).toBe(2)
    expect(result.duplicateRows).toEqual([2, 4])
    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.errors).toEqual(['Row 5: invalid amount "abc"'])
    expect(vi.mocked(addExpense).mock.calls[0][0].amount).toBe(20)
  })

  it('compares the category name case-insensitively', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch'),
    ])

    const result = await importExpensesFromCSV(
      [EXPENSE_HEADER, '2024-01-15,10,UAH,FOOD,lunch'].join('\n'),
    )

    expect(result.duplicates).toBe(1)
  })

  it('looks the category up by id when the stored expense has no joined category', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch', false),
    ])

    const result = await importExpensesFromCSV(
      [EXPENSE_HEADER, '2024-01-15,10,UAH,Food,lunch'].join('\n'),
    )

    expect(result.duplicates).toBe(1)
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('matches a decimal-comma amount against the stored number', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 12.5, 'lunch'),
    ])

    const result = await importExpensesFromCSV(
      [
        'date;amount;currency;category;description',
        '2024-01-15;12,50;UAH;Food;lunch',
      ].join('\n'),
    )

    expect(result.duplicates).toBe(1)
  })

  it('matches a multi-line description exactly', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'a\nb'),
    ])

    const result = await importExpensesFromCSV(
      `${EXPENSE_HEADER}\n2024-01-15,10,UAH,Food,"a\nb"\n2024-01-15,10,UAH,Food,"a\nc"`,
    )

    expect(result.duplicates).toBe(1)
    expect(result.duplicateRows).toEqual([2])
    expect(result.inserted).toBe(1)
  })

  it('does not collapse duplicates inside the same file', async () => {
    const result = await importExpensesFromCSV(
      [
        EXPENSE_HEADER,
        '2024-01-15,10,UAH,Food,lunch',
        '2024-01-15,10,UAH,Food,lunch',
        '2024-01-15,10,UAH,Food,lunch',
      ].join('\n'),
    )

    expect(result.inserted).toBe(3)
    expect(result.duplicates).toBe(0)
    expect(addExpense).toHaveBeenCalledTimes(3)
  })

  it('importing the same file twice gives 0 inserted and N duplicates the second time', async () => {
    const csv = [
      EXPENSE_HEADER,
      '2024-01-15,10,UAH,Food,lunch',
      '2024-01-16,20,UAH,Taxi,ride',
      '2024-01-17,30,UAH,Food,',
    ].join('\n')
    const stored: Array<ReturnType<typeof existingExpense>> = []
    vi.mocked(getAllExpenses).mockImplementation(() =>
      Promise.resolve([...stored]),
    )
    vi.mocked(addExpense).mockImplementation((input) => {
      const cat = input.categoryId === FOOD.id ? FOOD : TAXI
      stored.push({
        ...existingExpense(
          `e${stored.length}`,
          input.createdAt ?? '',
          input.amount,
          input.description ?? null,
        ),
        categoryId: cat.id,
        category: cat,
      })
      return Promise.resolve(stored[stored.length - 1])
    })

    const first = await importExpensesFromCSV(csv)
    const second = await importExpensesFromCSV(csv)

    expect(first.inserted).toBe(3)
    expect(first.duplicates).toBe(0)
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(3)
    expect(second.duplicateRows).toEqual([2, 3, 4])
    expect(stored).toHaveLength(3)
  })
})

describe('expenses: Import them anyway', () => {
  const existing = [
    existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch'),
    existingExpense('e2', localNoon(2024, 1, 17), 30, 'taxi home'),
  ]
  const csv = [
    EXPENSE_HEADER,
    '2024-01-15,10,UAH,Food,lunch',
    '2024-01-16,20,UAH,Food,brand new',
    '2024-01-17,30,UAH,Food,taxi home',
  ].join('\n')

  it('allowDuplicates inserts the rows that would be duplicates', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue(existing)

    const result = await importExpensesFromCSV(csv, { allowDuplicates: true })

    expect(result.inserted).toBe(3)
    expect(result.duplicates).toBe(0)
    expect(result.duplicateRows).toEqual([])
  })

  it('rows limits processing to the listed row numbers', async () => {
    const result = await importExpensesFromCSV(csv, { rows: [3] })

    expect(result.inserted).toBe(1)
    expect(addExpense).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addExpense).mock.calls[0][0].amount).toBe(20)
  })

  it('re-imports only the duplicate rows, so first-pass inserts are not doubled', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue(existing)
    const first = await importExpensesFromCSV(csv)
    expect(first.inserted).toBe(1)
    expect(first.duplicateRows).toEqual([2, 4])
    vi.mocked(addExpense).mockClear()

    const second = await importExpensesFromCSV(csv, {
      allowDuplicates: true,
      rows: first.duplicateRows,
    })

    expect(second.inserted).toBe(2)
    expect(second.duplicates).toBe(0)
    const amounts = vi.mocked(addExpense).mock.calls.map((c) => c[0].amount)
    expect(amounts).toEqual([10, 30])
  })

  it('still validates the rows it was asked to import', async () => {
    const result = await importExpensesFromCSV(
      [EXPENSE_HEADER, '2024-01-15,-1,UAH,Food,x', '2024-01-15,5,UAH,Food,y'].join(
        '\n',
      ),
      { allowDuplicates: true, rows: [2] },
    )

    expect(result.inserted).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.errors).toEqual(['Row 2: invalid amount "-1"'])
  })

  it('without a categories vault it still throws', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([])

    await expect(importExpensesFromCSV(csv)).rejects.toThrow(
      'Import categories.csv first',
    )
  })
})

describe('income: duplicates and Import them anyway', () => {
  const existingIncome = [
    {
      id: 'i1',
      source: 'Job',
      amount: 1000,
      currency: 'USD' as const,
      description: 'salary',
      createdAt: localNoon(2024, 2, 1),
    },
  ]
  const csv = [
    INCOME_HEADER,
    '2024-02-01,Job,1000,USD,salary',
    '2024-02-01,Job,1000,USD,bonus',
    '2024-02-01,Gig,1000,USD,salary',
  ].join('\n')

  it('skips the matching row and reports it', async () => {
    vi.mocked(getAllIncome).mockResolvedValue(existingIncome)

    const result = await importIncomeFromCSV(csv)

    expect(result.duplicates).toBe(1)
    expect(result.duplicateRows).toEqual([2])
    expect(result.inserted).toBe(2)
    expect(result.skipped).toBe(0)
    const sources = vi.mocked(addIncome).mock.calls.map((c) => c[0].source)
    expect(sources).toEqual(['Job', 'Gig'])
  })

  it('does not collapse identical rows inside one file', async () => {
    const result = await importIncomeFromCSV(
      [INCOME_HEADER, '2024-02-01,Job,5,USD,x', '2024-02-01,Job,5,USD,x'].join(
        '\n',
      ),
    )

    expect(result.inserted).toBe(2)
    expect(result.duplicates).toBe(0)
  })

  it('Import them anyway inserts exactly the duplicate rows', async () => {
    vi.mocked(getAllIncome).mockResolvedValue(existingIncome)
    const first = await importIncomeFromCSV(csv)
    vi.mocked(addIncome).mockClear()

    const second = await importIncomeFromCSV(csv, {
      allowDuplicates: true,
      rows: first.duplicateRows,
    })

    expect(second.inserted).toBe(1)
    expect(second.duplicates).toBe(0)
    expect(vi.mocked(addIncome).mock.calls[0][0].description).toBe('salary')
  })

  it('keeps validation errors ahead of the duplicate check', async () => {
    vi.mocked(getAllIncome).mockResolvedValue(existingIncome)

    const result = await importIncomeFromCSV(
      [INCOME_HEADER, '2024-02-01,,1000,USD,salary'].join('\n'),
    )

    expect(result.skipped).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.errors).toEqual(['Row 2: missing source'])
  })
})

describe('importLocalDataFile passes the options through', () => {
  const csv = [EXPENSE_HEADER, '2024-01-15,10,UAH,Food,lunch'].join('\n')

  beforeEach(() => {
    vi.mocked(getAllExpenses).mockResolvedValue([
      existingExpense('e1', localNoon(2024, 1, 15), 10, 'lunch'),
    ])
  })

  it('reports the duplicate by default', async () => {
    const { type, result } = await importLocalDataFile(
      file('expenses.csv', csv),
    )

    expect(type).toBe('expenses')
    expect(result.duplicates).toBe(1)
    expect(result.duplicateRows).toEqual([2])
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('inserts it with allowDuplicates and rows', async () => {
    const { result } = await importLocalDataFile(file('expenses.csv', csv), {
      allowDuplicates: true,
      rows: [2],
    })

    expect(result.inserted).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(addExpense).toHaveBeenCalledTimes(1)
  })

  it('applies to income files too', async () => {
    vi.mocked(getAllIncome).mockResolvedValue([
      {
        id: 'i1',
        source: 'Job',
        amount: 5,
        currency: 'UAH',
        description: null,
        createdAt: localNoon(2024, 1, 15),
      },
    ])
    const incomeCsv = [INCOME_HEADER, '2024-01-15,Job,5,UAH,'].join('\n')

    const first = await importLocalDataFile(file('income.csv', incomeCsv))
    const second = await importLocalDataFile(file('income.csv', incomeCsv), {
      allowDuplicates: true,
    })

    expect(first.result.duplicates).toBe(1)
    expect(second.result.inserted).toBe(1)
  })
})

describe('categories and budgets report no duplicates', () => {
  it('importCategoriesFromCSV returns duplicates: 0 and duplicateRows: []', async () => {
    const result = await importCategoriesFromCSV('name,icon\nCafe,')

    expect(result.inserted).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.duplicateRows).toEqual([])
    expect(addCategory).toHaveBeenCalledTimes(1)
  })

  it('importBudgetsFromCSV returns duplicates: 0 and duplicateRows: []', async () => {
    const result = await importBudgetsFromCSV(
      'category,monthly_limit,currency\nFood,100,UAH',
    )

    expect(result.inserted).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.duplicateRows).toEqual([])
    expect(upsertBudget).toHaveBeenCalledTimes(1)
  })
})
