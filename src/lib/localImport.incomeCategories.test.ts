// No CONTRACT_GAPs: the income.csv export/import behaviour with categories
// (source column = category name, auto-created categories, createdCategories,
// duplicate fingerprint by name) is fully specified in the Interface Contract
// (module: CSV).
//
// Real round trip: real localDb over the Map-backed idb-keyval mock, real
// localImport and localExport.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildCsvFiles } from '@/lib/localExport'
import {
  importIncomeFromCSV,
  importLocalDataFile,
} from '@/lib/localImport'
import { encryptValue } from '@/lib/crypto'
import {
  addIncome,
  addIncomeCategory,
  getAllIncome,
  getAllIncomeCategories,
  unlockLocalDb,
} from '@/lib/localDb'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
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
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

const HEADER = 'date,source,amount,currency,description'

let dek: CryptoKey

function localNoon(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d, 12, 0, 0).toISOString()
}

function file(name: string, content: string): File {
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

async function names(): Promise<Array<string>> {
  return (await getAllIncomeCategories()).map((c) => c.name)
}

async function categoryNameByRow(): Promise<Array<string | undefined>> {
  return (await getAllIncome())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((i) => i.category?.name)
}

beforeEach(async () => {
  mockStore.clear()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

describe('export: income.csv source column holds the category name', () => {
  it('keeps the header and writes the name of each entry category', async () => {
    const salary = await addIncomeCategory({ name: 'Salary', icon: '💼' })
    const gifts = await addIncomeCategory({ name: 'Gifts' })
    await addIncome({
      categoryId: salary.id,
      amount: 1000,
      currency: 'UAH',
      createdAt: localNoon(2024, 3, 10),
    })
    await addIncome({
      categoryId: gifts.id,
      amount: 20,
      currency: 'USD',
      description: 'birthday',
      createdAt: localNoon(2024, 3, 11),
    })

    const { 'income.csv': csv } = await buildCsvFiles()

    expect(csv.split('\n')).toEqual([
      '"date","source","amount","currency","description"',
      '"2024-03-10","Salary","1000","UAH",""',
      '"2024-03-11","Gifts","20","USD","birthday"',
    ])
  })

  it('falls back to the legacy source when the category is missing', async () => {
    mockStore.set(
      'income',
      await encryptValue(dek, [
        {
          id: 'old',
          source: 'Old gig',
          amount: 5,
          currency: 'UAH',
          createdAt: localNoon(2024, 3, 12),
        },
        {
          id: 'orphan',
          categoryId: 'gone',
          source: 'Kept text',
          amount: 6,
          currency: 'UAH',
          createdAt: localNoon(2024, 3, 13),
        },
      ]),
    )

    const { 'income.csv': csv } = await buildCsvFiles()

    const lines = csv.split('\n')
    expect(lines[1]).toBe('"2024-03-12","Old gig","5","UAH",""')
    expect(lines[2]).toBe('"2024-03-13","Kept text","6","UAH",""')
  })

  it('categories.csv stays expense-only', async () => {
    await addIncomeCategory({ name: 'Salary' })

    const { 'categories.csv': csv } = await buildCsvFiles()

    expect(csv).toBe('"name","icon"')
  })
})

describe('import: an unknown source creates the income category and reports it', () => {
  const csv = [
    HEADER,
    '2024-03-10,Salary,1000,UAH,march',
    '2024-03-11,Upwork,75,USD,',
    '2024-03-12,salary,500,UAH,bonus',
  ].join('\n')

  it('creates each distinct name once (ignoring case) and counts them', async () => {
    const result = await importIncomeFromCSV(csv)

    expect(result.errors).toEqual([])
    expect(result.inserted).toBe(3)
    expect(result.createdCategories).toBe(2)
    expect((await names()).sort()).toEqual(['Salary', 'Upwork'])
    expect(await categoryNameByRow()).toEqual(['Salary', 'Upwork', 'Salary'])
  })

  it('stores categoryId on the records and no source', async () => {
    await importIncomeFromCSV(csv)

    const income = await getAllIncome()
    expect(income).toHaveLength(3)
    const salary = (await getAllIncomeCategories()).find((c) => c.name === 'Salary')
    expect(income.filter((i) => i.categoryId === salary?.id)).toHaveLength(2)
    for (const entry of income) expect(entry.source).toBeUndefined()
  })

  it('reports a different count for a different file', async () => {
    const result = await importIncomeFromCSV(
      [
        HEADER,
        '2024-03-10,Alpha,1,UAH,',
        '2024-03-11,Beta,2,UAH,',
        '2024-03-12,Gamma,3,UAH,',
        '2024-03-13,Alpha,4,UAH,',
      ].join('\n'),
    )

    expect(result.createdCategories).toBe(3)
    expect(result.inserted).toBe(4)
  })

  it('trims the name and keeps the first spelling', async () => {
    await importIncomeFromCSV(
      [HEADER, '2024-03-10,"  Side hustle ",1,UAH,', '2024-03-11,SIDE HUSTLE,2,UAH,'].join(
        '\n',
      ),
    )

    expect(await names()).toEqual(['Side hustle'])
  })

  it('an existing category is matched ignoring case: nothing is created and nothing is reported', async () => {
    const gifts = await addIncomeCategory({ name: 'Gifts', icon: '🎁' })

    const result = await importIncomeFromCSV(
      [HEADER, '2024-03-10, GIFTS ,20,UAH,'].join('\n'),
    )

    expect(result.inserted).toBe(1)
    expect(result.createdCategories).toBeUndefined()
    expect(await getAllIncomeCategories()).toEqual([gifts])
    expect((await getAllIncome())[0].categoryId).toBe(gifts.id)
  })

  it('counts only the new names when some exist', async () => {
    await addIncomeCategory({ name: 'Salary' })

    const result = await importIncomeFromCSV(csv)

    expect(result.createdCategories).toBe(1)
    expect((await names()).sort()).toEqual(['Salary', 'Upwork'])
  })

  it('an invalid row never creates its category', async () => {
    const result = await importIncomeFromCSV(
      [
        HEADER,
        '2024-03-10,Ghost,abc,UAH,',
        '2024-03-11,Phantom,5,GBP,',
        '2024-13-45,Spectre,5,UAH,',
        '2024-03-12,Real,5,UAH,',
      ].join('\n'),
    )

    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(3)
    expect(result.createdCategories).toBe(1)
    expect(await names()).toEqual(['Real'])
  })

  it('a missing source is still reported and creates nothing', async () => {
    const result = await importIncomeFromCSV(
      [HEADER, '2024-03-10,,5,UAH,'].join('\n'),
    )

    expect(result.errors).toEqual(['Row 2: missing source'])
    expect(result.inserted).toBe(0)
    expect(await getAllIncomeCategories()).toEqual([])
  })

  it('a duplicate row never creates a category', async () => {
    mockStore.set(
      'income',
      await encryptValue(dek, [
        {
          id: 'old',
          source: 'Legacy',
          amount: 5,
          currency: 'UAH',
          description: 'x',
          createdAt: localNoon(2024, 3, 10),
        },
      ]),
    )

    const result = await importIncomeFromCSV(
      [HEADER, '2024-03-10,Legacy,5,UAH,x'].join('\n'),
    )

    expect(result.duplicates).toBe(1)
    expect(result.duplicateRows).toEqual([2])
    expect(result.inserted).toBe(0)
    expect(result.createdCategories).toBeUndefined()
    expect(await getAllIncomeCategories()).toEqual([])
  })

  it('works through importLocalDataFile for an income.csv and for a header-sniffed file', async () => {
    const byName = await importLocalDataFile(file('income.csv', csv))
    expect(byName.type).toBe('income')
    expect(byName.result.createdCategories).toBe(2)

    mockStore.clear()
    unlockLocalDb(dek)
    const sniffed = await importLocalDataFile(file('export.csv', csv))
    expect(sniffed.type).toBe('income')
    expect(sniffed.result.createdCategories).toBe(2)
  })
})

describe('re-importing the same file', () => {
  it('adds 0 rows, reports them as duplicates and creates no category', async () => {
    const csv = [
      HEADER,
      '2024-03-10,Salary,1000,UAH,march',
      '2024-03-11,Upwork,75,USD,',
      '2024-03-12,Salary,500,UAH,bonus',
    ].join('\n')
    const first = await importIncomeFromCSV(csv)
    expect(first.inserted).toBe(3)
    const categoriesBefore = await getAllIncomeCategories()

    const second = await importIncomeFromCSV(csv)

    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(3)
    expect(second.duplicateRows).toEqual([2, 3, 4])
    expect(second.createdCategories).toBeUndefined()
    expect(await getAllIncome()).toHaveLength(3)
    expect(await getAllIncomeCategories()).toEqual(categoriesBefore)
  })

  it('treats a differently cased source as the same record', async () => {
    await importIncomeFromCSV([HEADER, '2024-03-10,Salary,1000,UAH,march'].join('\n'))

    const again = await importIncomeFromCSV(
      [HEADER, '2024-03-10,SALARY,1000,UAH,march'].join('\n'),
    )

    expect(again.duplicates).toBe(1)
    expect(again.inserted).toBe(0)
  })

  it('a different amount or category is not a duplicate', async () => {
    await importIncomeFromCSV([HEADER, '2024-03-10,Salary,1000,UAH,march'].join('\n'))

    const again = await importIncomeFromCSV(
      [
        HEADER,
        '2024-03-10,Salary,1001,UAH,march',
        '2024-03-10,Gifts,1000,UAH,march',
      ].join('\n'),
    )

    expect(again.duplicates).toBe(0)
    expect(again.inserted).toBe(2)
    expect(again.createdCategories).toBe(1)
  })

  it('Import them anyway inserts the duplicates with the existing category', async () => {
    const csv = [HEADER, '2024-03-10,Salary,1000,UAH,march'].join('\n')
    await importIncomeFromCSV(csv)

    const again = await importIncomeFromCSV(csv, {
      allowDuplicates: true,
      rows: [2],
    })

    expect(again.inserted).toBe(1)
    expect(again.createdCategories).toBeUndefined()
    expect(await getAllIncome()).toHaveLength(2)
    expect(await getAllIncomeCategories()).toHaveLength(1)
  })
})

describe('export then import round trip', () => {
  it('a new device gets the categories from the exported names, and a second import is all duplicates', async () => {
    const salary = await addIncomeCategory({ name: 'Salary', icon: '💼' })
    const gifts = await addIncomeCategory({ name: 'Gifts', icon: '🎁' })
    await addIncome({
      categoryId: salary.id,
      amount: 1000,
      currency: 'UAH',
      createdAt: localNoon(2024, 3, 10),
    })
    await addIncome({
      categoryId: gifts.id,
      amount: 20,
      currency: 'USD',
      description: 'birthday',
      createdAt: localNoon(2024, 3, 11),
    })
    const { 'income.csv': csv } = await buildCsvFiles()

    // The same file into the same device: everything is a duplicate.
    const same = await importIncomeFromCSV(csv)
    expect(same.inserted).toBe(0)
    expect(same.duplicates).toBe(2)

    // A fresh device: the categories are created from the names.
    mockStore.clear()
    unlockLocalDb(dek)
    const fresh = await importIncomeFromCSV(csv)
    expect(fresh.inserted).toBe(2)
    expect(fresh.createdCategories).toBe(2)
    expect((await names()).sort()).toEqual(['Gifts', 'Salary'])
    expect(await categoryNameByRow()).toEqual(['Salary', 'Gifts'])

    const again = await importIncomeFromCSV(csv)
    expect(again.inserted).toBe(0)
    expect(again.duplicates).toBe(2)
    expect(again.createdCategories).toBeUndefined()
    const reexported = (await buildCsvFiles())['income.csv']
    expect(reexported).toBe(csv)
  })
})
