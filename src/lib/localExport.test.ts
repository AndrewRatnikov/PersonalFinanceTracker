// No CONTRACT_GAPs: buildCsvFiles, buildCsvZip, csvZipFileName and
// exportAllLocalData (zip, local dates, multi-line round trip) are fully
// specified in the Interface Contract (module: localExport).

import dayjs from 'dayjs'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCsvFiles,
  buildCsvZip,
  csvZipFileName,
  exportAllLocalData,
} from '@/lib/localExport'
import { saveFile } from '@/lib/fileDownload'
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
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))

const originalTZ = process.env.TZ
process.env.TZ = 'Europe/Kyiv'
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

const FOOD = { id: 'c1', name: 'Food', icon: null }

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function seed(
  expenseDates: Array<string>,
  incomeDates: Array<string>,
  expenseDescription: string | null = null,
) {
  vi.mocked(getAllExpenses).mockResolvedValue(
    expenseDates.map((createdAt, i) => ({
      id: `e${i}`,
      amount: 10,
      currency: 'UAH' as const,
      categoryId: 'c1',
      description: expenseDescription,
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
}

// After exporting, the "device" the CSV is imported into starts empty.
function emptyTargetDevice() {
  vi.mocked(getAllExpenses).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllCategories).mockResolvedValue([FOOD])
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(saveFile).mockResolvedValue('saved')
})

describe('buildCsvFiles', () => {
  it('returns exactly the four CSV files', async () => {
    seed(['2024-03-10T10:00:00.000Z'], ['2024-03-11T10:00:00.000Z'])

    const files = await buildCsvFiles()

    expect(Object.keys(files).sort()).toEqual([
      'budgets.csv',
      'categories.csv',
      'expenses.csv',
      'income.csv',
    ])
  })

  it('keeps the current headers and quotes every field', async () => {
    seed(['2024-03-10T10:00:00.000Z'], ['2024-03-11T10:00:00.000Z'])
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

    expect(files['expenses.csv'].split('\n')).toEqual([
      '"date","amount","currency","category","description"',
      '"2024-03-10","10","UAH","Food",""',
    ])
    expect(files['income.csv'].split('\n')).toEqual([
      '"date","source","amount","currency","description"',
      '"2024-03-11","Job","500","UAH",""',
    ])
    expect(files['categories.csv'].split('\n')).toEqual([
      '"name","icon"',
      '"Food",""',
    ])
    expect(files['budgets.csv'].split('\n')).toEqual([
      '"category","monthly_limit","currency"',
      '"Food","300","UAH"',
    ])
  })

  it('writes only the header line for empty collections', async () => {
    seed([], [])

    const files = await buildCsvFiles()

    expect(files['expenses.csv']).toBe(
      '"date","amount","currency","category","description"',
    )
    expect(files['budgets.csv']).toBe('"category","monthly_limit","currency"')
  })

  it('keeps a multi-line description inside one quoted field', async () => {
    seed(['2024-03-10T10:00:00.000Z'], [], 'line one\nline "two"')

    const files = await buildCsvFiles()

    expect(files['expenses.csv']).toContain('"line one\nline ""two"""')
  })
})

describe('exportAllLocalData writes local calendar dates (#3)', () => {
  it('exports the Kyiv date for an expense at 01:30 local (23:30Z the day before)', async () => {
    seed(['2024-01-14T23:30:00.000Z'], [])

    const { 'expenses.csv': csv } = await buildCsvFiles()

    expect(csv).toContain('"2024-01-15"')
    expect(csv).not.toContain('"2024-01-14"')
  })

  it('exports the Kyiv date for an income entry at 01:30 local (23:30Z the day before)', async () => {
    seed([], ['2024-01-14T23:30:00.000Z'])

    const { 'income.csv': csv } = await buildCsvFiles()

    expect(csv).toContain('"2024-01-15"')
    expect(csv).not.toContain('"2024-01-14"')
  })

  it('uses the summer offset too (21:30Z is the next local day in June)', async () => {
    seed(['2024-06-10T21:30:00.000Z'], [])

    const { 'expenses.csv': csv } = await buildCsvFiles()

    expect(csv).toContain('"2024-06-11"')
  })

  it('round trip: exported expenses re-import to the same local date', async () => {
    seed(['2024-01-14T23:30:00.000Z'], [])
    const { 'expenses.csv': csv } = await buildCsvFiles()
    emptyTargetDevice()

    const result = await importExpensesFromCSV(csv)

    expect(result.inserted).toBe(1)
    const imported = vi.mocked(addExpense).mock.calls[0][0]
    expect(dayjs(imported.createdAt).format('YYYY-MM-DD')).toBe('2024-01-15')
  })

  it('round trip: exported income re-imports to the same local date', async () => {
    seed([], ['2024-01-14T23:30:00.000Z'])
    const { 'income.csv': csv } = await buildCsvFiles()
    emptyTargetDevice()

    const result = await importIncomeFromCSV(csv)

    expect(result.inserted).toBe(1)
    const imported = vi.mocked(addIncome).mock.calls[0][0]
    expect(dayjs(imported.createdAt).format('YYYY-MM-DD')).toBe('2024-01-15')
  })
})

describe('multi-line description round trip (#18)', () => {
  it.each([
    'first line\nsecond line',
    'a, b; c\n"quoted" text\r\nthird',
    '\nleading newline and trailing\n',
  ])('survives export then import unchanged: %j', async (description) => {
    seed(['2024-03-10T10:00:00.000Z'], [], description)
    const { 'expenses.csv': csv } = await buildCsvFiles()
    emptyTargetDevice()

    const result = await importExpensesFromCSV(csv)

    expect(result.errors).toEqual([])
    expect(result.inserted).toBe(1)
    expect(vi.mocked(addExpense).mock.calls[0][0].description).toBe(description)
  })

  it('keeps several multi-line rows apart', async () => {
    vi.mocked(getAllExpenses).mockResolvedValue(
      ['one\ntwo', 'three\nfour'].map((description, i) => ({
        id: `e${i}`,
        amount: 10 + i,
        currency: 'UAH' as const,
        categoryId: 'c1',
        description,
        createdAt: '2024-03-10T10:00:00.000Z',
        category: FOOD,
      })),
    )
    vi.mocked(getAllIncome).mockResolvedValue([])
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllBudgets).mockResolvedValue([])
    const { 'expenses.csv': csv } = await buildCsvFiles()
    emptyTargetDevice()

    const result = await importExpensesFromCSV(csv)

    expect(result.inserted).toBe(2)
    const calls = vi.mocked(addExpense).mock.calls.map((c) => c[0])
    expect(calls.map((c) => c.description)).toEqual(['one\ntwo', 'three\nfour'])
    expect(calls.map((c) => c.amount)).toEqual([10, 11])
  })
})

describe('buildCsvZip', () => {
  it('zips the four CSV files with the same contents as buildCsvFiles', async () => {
    seed(['2024-03-10T10:00:00.000Z'], ['2024-03-11T10:00:00.000Z'], 'a\nb')

    const files = await buildCsvFiles()
    const zip = await buildCsvZip()
    const entries = unzipSync(zip)

    expect(zip).toBeInstanceOf(Uint8Array)
    expect(Object.keys(entries).sort()).toEqual([
      'budgets.csv',
      'categories.csv',
      'expenses.csv',
      'income.csv',
    ])
    for (const name of Object.keys(files)) {
      expect(strFromU8(entries[name])).toBe(files[name])
    }
  })

  it('reflects the data it was built from', async () => {
    seed(['2024-03-10T10:00:00.000Z'], [])
    const first = strFromU8(unzipSync(await buildCsvZip())['expenses.csv'])
    seed(['2024-03-10T10:00:00.000Z', '2024-04-10T10:00:00.000Z'], [])
    const second = strFromU8(unzipSync(await buildCsvZip())['expenses.csv'])

    expect(first.split('\n')).toHaveLength(2)
    expect(second.split('\n')).toHaveLength(3)
  })
})

describe('csvZipFileName', () => {
  it('is minima-csv-YYYY-MM-DD.zip for the local date', () => {
    expect(csvZipFileName(new Date(2024, 0, 5, 12))).toBe(
      'minima-csv-2024-01-05.zip',
    )
    expect(csvZipFileName(new Date(2025, 10, 30, 12))).toBe(
      'minima-csv-2025-11-30.zip',
    )
  })

  it('defaults to today', () => {
    expect(csvZipFileName()).toBe(
      `minima-csv-${dayjs().format('YYYY-MM-DD')}.zip`,
    )
  })
})

describe('exportAllLocalData', () => {
  it('saves one zip, once, without sharing', async () => {
    seed(['2024-03-10T10:00:00.000Z'], ['2024-03-11T10:00:00.000Z'])

    await exportAllLocalData()

    expect(saveFile).toHaveBeenCalledTimes(1)
    const [blob, filename, options] = vi.mocked(saveFile).mock.calls[0]
    expect(filename).toMatch(/^minima-csv-\d{4}-\d{2}-\d{2}\.zip$/)
    expect(blob.type).toBe('application/zip')
    expect(options?.share).toBeFalsy()

    const entries = unzipSync(new Uint8Array(await readBlob(blob)))
    expect(Object.keys(entries).sort()).toEqual([
      'budgets.csv',
      'categories.csv',
      'expenses.csv',
      'income.csv',
    ])
    expect(strFromU8(entries['expenses.csv'])).toContain('"2024-03-10"')
  })

  it('exports whatever is stored at the time of the call', async () => {
    seed(['2024-03-10T10:00:00.000Z'], [])
    await exportAllLocalData()
    seed(['2024-07-21T10:00:00.000Z'], [])
    await exportAllLocalData()

    const [first, second] = vi.mocked(saveFile).mock.calls.map((c) => c[0])
    const a = unzipSync(new Uint8Array(await readBlob(first)))
    const b = unzipSync(new Uint8Array(await readBlob(second)))
    expect(strFromU8(a['expenses.csv'])).toContain('"2024-03-10"')
    expect(strFromU8(b['expenses.csv'])).toContain('"2024-07-21"')
  })

  it('propagates a save failure', async () => {
    seed([], [])
    vi.mocked(saveFile).mockRejectedValue(new Error('disk full'))

    await expect(exportAllLocalData()).rejects.toThrow('disk full')
  })
})
