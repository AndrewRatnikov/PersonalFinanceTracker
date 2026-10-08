// No CONTRACT_GAPs: import behaviour for #11 and #10 (import trim) is fully
// specified in the Interface Contract. Phase 4: the mock now includes
// getAllExpenses and getAllIncome (snapshot reads for duplicate detection).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  importCategoriesFromCSV,
  importExpensesFromCSV,
  importIncomeFromCSV,
} from '@/lib/localImport'
import {
  addCategory,
  addExpense,
  addIncome,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
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

describe('import: invalid dates are skipped (#11)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([
      { id: 'c1', name: 'Food', icon: null },
    ])
    vi.mocked(getAllExpenses).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
  })

  it('expenses: skips an impossible date and an empty date, imports the valid row', async () => {
    const csv = [
      'date,amount,currency,category,description',
      '2024-01-15,10,UAH,Food,',
      '2024-13-45,20,UAH,Food,',
      ',5,UAH,Food,',
    ].join('\n')

    const result = await importExpensesFromCSV(csv)

    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.errors).toContain('Row 3: invalid date "2024-13-45"')
    expect(result.errors).toContain('Row 4: invalid date ""')
    expect(addExpense).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addExpense).mock.calls[0][0].amount).toBe(10)
  })

  it('expenses: a valid date is still imported as that day', async () => {
    const result = await importExpensesFromCSV(
      ['date,amount,currency,category,description', '2024-02-20,7,USD,Food,'].join(
        '\n',
      ),
    )

    expect(result.inserted).toBe(1)
    expect(result.errors).toEqual([])
    const createdAt = vi.mocked(addExpense).mock.calls[0][0].createdAt
    expect(new Date(createdAt ?? '').getFullYear()).toBe(2024)
    expect(new Date(createdAt ?? '').getMonth()).toBe(1)
    expect(new Date(createdAt ?? '').getDate()).toBe(20)
  })

  it('income: skips an impossible date and an empty date, imports the valid row', async () => {
    const csv = [
      'date,source,amount,currency,description',
      '2024-01-15,Job,100,UAH,',
      '2024-13-45,Job,200,UAH,',
      ',Job,50,UAH,',
    ].join('\n')

    const result = await importIncomeFromCSV(csv)

    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.errors).toContain('Row 3: invalid date "2024-13-45"')
    expect(result.errors).toContain('Row 4: invalid date ""')
    expect(addIncome).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addIncome).mock.calls[0][0].amount).toBe(100)
  })
})

describe('import: category names are compared trimmed (#10)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([
      { id: 'c1', name: 'Food', icon: null },
    ])
    vi.mocked(getAllExpenses).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
  })

  it('skips a padded duplicate of an existing category without calling addCategory', async () => {
    const result = await importCategoriesFromCSV('name,icon\n" food ",')

    expect(result.inserted).toBe(0)
    expect(result.skipped).toBe(1)
    expect(addCategory).not.toHaveBeenCalled()
  })

  it('inserts a new padded name trimmed', async () => {
    const result = await importCategoriesFromCSV('name,icon\n"  Cafe  ",')

    expect(result.inserted).toBe(1)
    expect(vi.mocked(addCategory).mock.calls[0][0].name).toBe('Cafe')
  })
})

describe('import: existing behaviour is preserved (Phase 4, #20)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([
      { id: 'c1', name: 'Food', icon: null },
    ])
    vi.mocked(getAllExpenses).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
  })

  it('expenses: reports each invalid row once, with the original texts and numbering', async () => {
    const csv = [
      'date,amount,currency,category,description',
      '2024-01-15,abc,UAH,Food,',
      '2024-01-15,5,GBP,Food,',
      '2024-01-15,5,UAH,Unknown,',
      '2024-01-15,5,UAH,Food,ok',
    ].join('\n')

    const result = await importExpensesFromCSV(csv)

    expect(result.errors).toEqual([
      'Row 2: invalid amount "abc"',
      'Row 3: invalid currency "GBP"',
      'Row 4: unknown category "Unknown"',
    ])
    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(3)
    expect(result.duplicates).toBe(0)
    expect(result.duplicateRows).toEqual([])
  })

  it('expenses: throws when the vault has no categories', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([])

    await expect(
      importExpensesFromCSV(
        'date,amount,currency,category,description\n2024-01-15,5,UAH,Food,',
      ),
    ).rejects.toThrow('Import categories.csv first')
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('expenses: a zero or negative amount is rejected', async () => {
    const result = await importExpensesFromCSV(
      [
        'date,amount,currency,category,description',
        '2024-01-15,0,UAH,Food,',
        '2024-01-15,-3,UAH,Food,',
      ].join('\n'),
    )

    expect(result.inserted).toBe(0)
    expect(result.errors).toEqual([
      'Row 2: invalid amount "0"',
      'Row 3: invalid amount "-3"',
    ])
  })

  it('expenses: never defaults a missing date to now', async () => {
    const result = await importExpensesFromCSV(
      'date,amount,currency,category,description\n,5,UAH,Food,',
    )

    expect(result.inserted).toBe(0)
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('income: a missing source is reported', async () => {
    const result = await importIncomeFromCSV(
      'date,source,amount,currency,description\n2024-01-15,,5,UAH,',
    )

    expect(result.errors).toEqual(['Row 2: missing source'])
    expect(result.skipped).toBe(1)
    expect(addIncome).not.toHaveBeenCalled()
  })

  it('categories: a row without a name is reported', async () => {
    const result = await importCategoriesFromCSV('name,icon\n,x\nCafe,')

    expect(result.errors).toEqual(['Row 2: missing name'])
    expect(result.skipped).toBe(1)
    expect(result.inserted).toBe(1)
  })
})
