// CONTRACT_GAP: the slug rule for the Family file name is tested on the cases
//   the plan states (lowercase, runs of other characters become "-", trimmed,
//   at most 40 characters, "family" when empty, Cyrillic letters kept); other
//   corner cases (digits-only names, mixed scripts) are not asserted.
// CONTRACT_GAP: CSV export/import act on the space passed in the options
//   (`{ spaceId }`); the UI passes the active space, which is not tested here.
//
// Real localDb over a Map-backed idb-keyval; saveFile is mocked (no
// filesystem). Dates are local calendar dates, so the clock is set at noon.

import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCsvFiles,
  buildCsvZip,
  csvZipFileName,
  exportAllLocalData,
} from '@/lib/localExport'
import { saveFile } from '@/lib/fileDownload'
import {
  importBudgetsFromCSV,
  importCategoriesFromCSV,
  importExpensesFromCSV,
  importLocalDataFile,
} from '@/lib/localImport'
import {
  addCategory,
  addExpense,
  applyIncomingRecords,
  createLocalSpace,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  spaceDb,
  unlockLocalDb,
  upsertBudget,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  getMany: (list: Array<string>) => Promise.resolve(list.map((k) => mockStore.get(k))),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    mockStore.delete(key)
    return Promise.resolve()
  },
  delMany: (list: Array<string>) => {
    for (const key of list) mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue(null),
}))

const MAY = new Date(2026, 4, 15, 12, 0, 0)
const MAY_ISO = MAY.toISOString()
const EXPENSE_HEADER =
  '"date","amount","currency","category","description","main_amount","main_currency"'

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function csvFile(name: string, csv: string): File {
  const file = new File([csv], name, { type: 'text/csv' })
  file.text = () => Promise.resolve(csv)
  return file
}

async function setup() {
  unlockLocalDb(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  )
  const personalCategory = await addCategory({ name: 'Personal food' })
  await addExpense({
    amount: 11,
    currency: 'UAH',
    categoryId: personalCategory.id,
    description: 'personal lunch',
    createdAt: MAY_ISO,
  })
  const space = await createLocalSpace({ name: 'Our Home', lang: 'en' })
  const fam = spaceDb(space.id)
  const familyCategory = await fam.addCategory({ name: 'Family groceries' })
  await fam.addExpense({
    amount: 222,
    currency: 'UAH',
    categoryId: familyCategory.id,
    description: 'family dinner',
    createdAt: MAY_ISO,
  })
  return { space, fam, familyCategory, personalCategory }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  vi.mocked(saveFile).mockReset()
  setSyncChannel(null)
  clearKeyring()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(MAY)
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('csvZipFileName', () => {
  it('personal stays minima-csv-YYYY-MM-DD.zip', () => {
    expect(csvZipFileName(MAY)).toBe('minima-csv-2026-05-15.zip')
    expect(csvZipFileName(new Date(2026, 11, 1, 12))).toBe('minima-csv-2026-12-01.zip')
  })

  it('a Family space name goes between the prefix and the date, as a slug', () => {
    expect(csvZipFileName(MAY, 'Our Home')).toBe('minima-csv-our-home-2026-05-15.zip')
    expect(csvZipFileName(MAY, 'The Smiths & Co.')).toBe('minima-csv-the-smiths-co-2026-05-15.zip')
  })

  it('trims dashes and collapses runs of other characters', () => {
    expect(csvZipFileName(MAY, '  --Home!!  sweet__home--  ')).toBe(
      'minima-csv-home-sweet-home-2026-05-15.zip',
    )
  })

  it('falls back to "family" when nothing is left', () => {
    expect(csvZipFileName(MAY, '!!!')).toBe('minima-csv-family-2026-05-15.zip')
  })

  it('keeps Cyrillic letters', () => {
    expect(csvZipFileName(MAY, 'Наша сім')).toBe('minima-csv-наша-сім-2026-05-15.zip')
  })

  it('cuts the slug to 40 characters', () => {
    const name = csvZipFileName(MAY, 'a'.repeat(100))

    const slug = /^minima-csv-(.*)-2026-05-15\.zip$/.exec(name)?.[1] ?? ''
    expect(slug).toBe('a'.repeat(40))
  })

  it('different names give different file names', () => {
    expect(csvZipFileName(MAY, 'Alpha')).not.toBe(csvZipFileName(MAY, 'Beta'))
  })
})

describe('buildCsvFiles', () => {
  it('without options it exports the personal space only', async () => {
    await setup()

    const files = await buildCsvFiles()

    expect(files['expenses.csv']).toContain('personal lunch')
    expect(files['expenses.csv']).not.toContain('family dinner')
    expect(files['categories.csv']).toContain('Personal food')
    expect(files['categories.csv']).not.toContain('Family groceries')
  })

  it('with a spaceId it exports that Family space only', async () => {
    const { space } = await setup()

    const files = await buildCsvFiles({ spaceId: space.id })

    expect(files['expenses.csv']).toContain('family dinner')
    expect(files['expenses.csv']).toContain('Family groceries')
    expect(files['expenses.csv']).not.toContain('personal lunch')
    expect(files['categories.csv']).toContain('Family groceries')
    expect(files['categories.csv']).not.toContain('Personal food')
    expect(files['expenses.csv'].split('\n')[0]).toBe(EXPENSE_HEADER)
  })

  it('an explicit personal spaceId equals the default', async () => {
    await setup()

    expect(await buildCsvFiles({ spaceId: 'personal' })).toEqual(await buildCsvFiles())
  })

  it('exports the Family budgets, not the personal ones', async () => {
    const { space, fam, familyCategory, personalCategory } = await setup()
    await fam.upsertBudget({ categoryId: familyCategory.id, monthlyLimit: 777, currency: 'UAH' })
    await upsertBudget({ categoryId: personalCategory.id, monthlyLimit: 111, currency: 'UAH' })

    const family = await buildCsvFiles({ spaceId: space.id })
    const personal = await buildCsvFiles()

    expect(family['budgets.csv']).toContain('777')
    expect(family['budgets.csv']).not.toContain('111')
    expect(personal['budgets.csv']).toContain('111')
    expect(personal['budgets.csv']).not.toContain('777')
  })

  it('does not include deleted Family records', async () => {
    const { space, fam } = await setup()
    const [dinner] = await fam.getAllExpenses()
    await fam.deleteExpense(dinner.id, dinner.createdAt)

    const files = await buildCsvFiles({ spaceId: space.id })

    expect(files['expenses.csv']).not.toContain('family dinner')
  })
})

describe('buildCsvZip', () => {
  it('zips the four files of the chosen space', async () => {
    const { space } = await setup()

    const family = unzipSync(await buildCsvZip({ spaceId: space.id }))
    const personal = unzipSync(await buildCsvZip())

    expect(Object.keys(family).sort()).toEqual([
      'budgets.csv',
      'categories.csv',
      'expenses.csv',
      'income.csv',
    ])
    expect(strFromU8(family['expenses.csv'])).toContain('family dinner')
    expect(strFromU8(personal['expenses.csv'])).toContain('personal lunch')
    expect(strFromU8(personal['expenses.csv'])).not.toContain('family dinner')
  })
})

describe('exportAllLocalData', () => {
  it('a Family export saves a zip named after the space and holding its data', async () => {
    const { space } = await setup()

    await exportAllLocalData({ spaceId: space.id })

    expect(saveFile).toHaveBeenCalledTimes(1)
    const [blob, filename] = vi.mocked(saveFile).mock.calls[0]
    expect(filename).toBe('minima-csv-our-home-2026-05-15.zip')
    const files = unzipSync(new Uint8Array(await readBlob(blob)))
    expect(strFromU8(files['expenses.csv'])).toContain('family dinner')
    expect(strFromU8(files['expenses.csv'])).not.toContain('personal lunch')
  })

  it('a personal export keeps the old name and the personal data', async () => {
    await setup()

    await exportAllLocalData()

    const [blob, filename] = vi.mocked(saveFile).mock.calls[0]
    expect(filename).toBe('minima-csv-2026-05-15.zip')
    const files = unzipSync(new Uint8Array(await readBlob(blob)))
    expect(strFromU8(files['expenses.csv'])).toContain('personal lunch')
    expect(strFromU8(files['expenses.csv'])).not.toContain('family dinner')
  })

  it('uses the current space name', async () => {
    const { space } = await setup()
    // Rename through an incoming spaceInfo record, as another member would.
    await applyIncomingRecords(space.id, [
      {
        type: 'spaceInfo',
        id: 'space',
        updatedAt: '2026-05-16T10:00:00.000Z',
        data: {
          id: 'space',
          name: 'Beach House',
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-16T10:00:00.000Z',
        },
      },
    ])

    await exportAllLocalData({ spaceId: space.id })

    expect(vi.mocked(saveFile).mock.calls[0][1]).toBe('minima-csv-beach-house-2026-05-15.zip')
  })
})

describe('import into a space', () => {
  it('categories go to the chosen space only', async () => {
    const { space, fam } = await setup()

    const result = await importCategoriesFromCSV('"name","icon"\nPets,\n', { spaceId: space.id })

    expect(result.inserted).toBe(1)
    expect((await fam.getAllCategories()).map((c) => c.name)).toContain('Pets')
    expect((await getAllCategories()).map((c) => c.name)).not.toContain('Pets')
  })

  it('without options the import still goes to personal', async () => {
    const { fam } = await setup()

    await importCategoriesFromCSV('"name","icon"\nCars,\n')

    expect((await getAllCategories()).map((c) => c.name)).toContain('Cars')
    expect((await fam.getAllCategories()).map((c) => c.name)).not.toContain('Cars')
  })

  it('expenses are matched against the Family categories and written to the Family space', async () => {
    const { space, fam } = await setup()
    const csv = [
      '"date","amount","currency","category","description"',
      '2026-05-16,55,UAH,Family groceries,imported dinner',
    ].join('\n')

    const result = await importExpensesFromCSV(csv, { spaceId: space.id })

    expect(result.inserted).toBe(1)
    expect((await fam.getAllExpenses()).map((e) => e.description)).toContain('imported dinner')
    expect((await getAllExpenses()).map((e) => e.description)).not.toContain('imported dinner')
  })

  it('a Family category name is unknown to the personal import', async () => {
    await setup()
    const csv = [
      '"date","amount","currency","category","description"',
      '2026-05-16,55,UAH,Family groceries,wrong space',
    ].join('\n')

    const result = await importExpensesFromCSV(csv)

    expect(result.inserted).toBe(0)
    expect(result.rowErrors.map((e) => e.code)).toEqual(['unknown-category'])
  })

  it('the duplicate check looks at the chosen space only', async () => {
    const { space } = await setup()
    const row = '2026-05-15,222,UAH,Family groceries,family dinner'
    const csv = ['"date","amount","currency","category","description"', row].join('\n')

    const again = await importExpensesFromCSV(csv, { spaceId: space.id })

    expect(again.inserted).toBe(0)
    expect(again.duplicates).toBe(1)
    const forced = await importExpensesFromCSV(csv, { spaceId: space.id, allowDuplicates: true })
    expect(forced.inserted).toBe(1)
  })

  it('budgets are written to the chosen space', async () => {
    const { space, fam } = await setup()
    const csv = ['"category","monthly_limit","currency"', 'Family groceries,500,UAH'].join('\n')

    const result = await importBudgetsFromCSV(csv, { spaceId: space.id })

    expect(result.inserted).toBe(1)
    expect((await fam.getAllBudgets()).map((b) => b.monthlyLimit)).toEqual([500])
    expect(await getAllBudgets()).toEqual([])
  })

  it('importLocalDataFile passes the space through to the right importer', async () => {
    const { space, fam } = await setup()
    const csv = [
      '"date","amount","currency","category","description"',
      '2026-05-17,66,UAH,Family groceries,from a file',
    ].join('\n')

    const outcome = await importLocalDataFile(csvFile('expenses.csv', csv), {
      spaceId: space.id,
    })

    expect(outcome.type).toBe('expenses')
    expect(outcome.result.inserted).toBe(1)
    expect((await fam.getAllExpenses()).map((e) => e.description)).toContain('from a file')
    expect((await getAllExpenses()).map((e) => e.description)).not.toContain('from a file')
  })

  it('export then import round-trips within a space', async () => {
    const { space, fam } = await setup()
    const files = await buildCsvFiles({ spaceId: space.id })

    const result = await importExpensesFromCSV(files['expenses.csv'], {
      spaceId: space.id,
      allowDuplicates: true,
    })

    expect(result.inserted).toBe(1)
    expect((await fam.getAllExpenses()).map((e) => e.amount)).toEqual([222, 222])
  })
})
