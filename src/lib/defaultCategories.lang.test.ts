// No CONTRACT_GAPs: defaultExpenseCategories / defaultIncomeCategories, the
// lang option of convertIncomeSources and the lang parameter of
// provisionDefaultCategories / ensureIncomeCategories / prepareUnlockedVault are
// specified in plan section 11. localDb runs over a Map-backed idb-keyval mock,
// as in localDb.incomeCategories.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IncomeEntry } from '@/lib/domain'
import { setLang } from '@/i18n/core'
import {
  defaultExpenseCategories,
  defaultIncomeCategories,
} from '@/lib/defaultCategories'
import { DEFAULT_INCOME_CATEGORIES, convertIncomeSources } from '@/lib/incomeCategories'
import {
  ensureIncomeCategories,
  getAllCategories,
  getAllIncomeCategories,
  prepareUnlockedVault,
  provisionDefaultCategories,
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

const EN_EXPENSE: Array<[string, string]> = [
  ['Food', '🍔'],
  ['Transport', '🚌'],
  ['Rent', '🏠'],
  ['Coffee', '☕'],
  ['Entertainment', '🎬'],
  ['Server Costs', '🖥️'],
]
const UK_EXPENSE: Array<[string, string]> = [
  ['Їжа', '🍔'],
  ['Транспорт', '🚌'],
  ['Оренда', '🏠'],
  ['Кава', '☕'],
  ['Розваги', '🎬'],
  ['Сервери', '🖥️'],
]
const EN_INCOME: Array<[string, string]> = [
  ['Salary', '💼'],
  ['Freelance', '💻'],
  ['Gifts', '🎁'],
  ['Investments', '📈'],
  ['Refunds', '↩️'],
  ['Other', '🪙'],
]
const UK_INCOME: Array<[string, string]> = [
  ['Зарплата', '💼'],
  ['Фриланс', '💻'],
  ['Подарунки', '🎁'],
  ['Інвестиції', '📈'],
  ['Повернення', '↩️'],
  ['Інше', '🪙'],
]

const pairs = (list: ReadonlyArray<{ name: string; icon?: string | null }>) =>
  list.map((c): [string, string | null | undefined] => [c.name, c.icon])

beforeEach(async () => {
  mockStore.clear()
  setLang('en', { persist: false })
  unlockLocalDb(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  )
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('defaultExpenseCategories', () => {
  it('English is today\'s list', () => {
    expect(pairs(defaultExpenseCategories('en'))).toEqual(EN_EXPENSE)
  })

  it('Ukrainian has the Ukrainian names and the same icons', () => {
    expect(pairs(defaultExpenseCategories('uk'))).toEqual(UK_EXPENSE)
  })
})

describe('defaultIncomeCategories', () => {
  it('English is today\'s list', () => {
    expect(pairs(defaultIncomeCategories('en'))).toEqual(EN_INCOME)
  })

  it('Ukrainian has the Ukrainian names and the same icons, with Інше last', () => {
    const list = defaultIncomeCategories('uk')

    expect(pairs(list)).toEqual(UK_INCOME)
    expect(list[list.length - 1].name).toBe('Інше')
    expect(list[list.length - 1].icon).toBe('🪙')
  })

  it('DEFAULT_INCOME_CATEGORIES stays the English list', () => {
    expect(pairs(DEFAULT_INCOME_CATEGORIES)).toEqual(EN_INCOME)
    expect(DEFAULT_INCOME_CATEGORIES).toEqual(defaultIncomeCategories('en'))
  })
})

describe('convertIncomeSources lang option', () => {
  const legacy = (id: string, source?: string): IncomeEntry => ({
    id,
    categoryId: '',
    amount: 5,
    currency: 'UAH',
    createdAt: '2026-03-10T12:00:00.000Z',
    ...(source === undefined ? {} : { source }),
  })

  it('adds the Ukrainian defaults when asked', () => {
    const result = convertIncomeSources([], [], { addDefaults: true, lang: 'uk' })

    expect(pairs(result.incomeCategories)).toEqual(UK_INCOME)
    expect(result.created).toBe(6)
  })

  it('defaults to English without a lang', () => {
    const result = convertIncomeSources([], [], { addDefaults: true })

    expect(pairs(result.incomeCategories)).toEqual(EN_INCOME)
  })

  it('files a legacy entry without a source under the language\'s "Other"', () => {
    const uk = convertIncomeSources([legacy('l1')], [], { lang: 'uk' })
    const en = convertIncomeSources([legacy('l1')], [], { lang: 'en' })

    expect(pairs(uk.incomeCategories)).toEqual([['Інше', '🪙']])
    expect(pairs(en.incomeCategories)).toEqual([['Other', '🪙']])
    expect(uk.income[0].categoryId).toBe(uk.incomeCategories[0].id)
  })

  it('keeps a free-text source as its own category whatever the language', () => {
    const result = convertIncomeSources([legacy('l1', 'Upwork')], [], { lang: 'uk' })

    expect(result.incomeCategories.map((c) => c.name)).toEqual(['Upwork'])
  })
})

describe('provisionDefaultCategories and ensureIncomeCategories', () => {
  it('create the Ukrainian defaults for lang "uk"', async () => {
    await provisionDefaultCategories('uk')
    await ensureIncomeCategories('uk')

    expect(pairs(await getAllCategories())).toEqual(UK_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(UK_INCOME)
  })

  it('create the English defaults without a lang', async () => {
    await provisionDefaultCategories()
    await ensureIncomeCategories()

    expect(pairs(await getAllCategories())).toEqual(EN_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(EN_INCOME)
  })

  it('never rename existing categories, whatever the language asked for', async () => {
    await provisionDefaultCategories('en')
    await ensureIncomeCategories('en')
    const categoriesBlob = mockStore.get('categories')
    const incomeBlob = mockStore.get('incomeCategories')

    await provisionDefaultCategories('uk')
    const wrote = await ensureIncomeCategories('uk')

    expect(wrote).toBe(false)
    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(mockStore.get('incomeCategories')).toBe(incomeBlob)
    expect(pairs(await getAllCategories())).toEqual(EN_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(EN_INCOME)
  })
})

describe('prepareUnlockedVault lang', () => {
  it('a new vault in Ukrainian gets the Ukrainian expense and income defaults', async () => {
    await prepareUnlockedVault({ isNewVault: true, lang: 'uk' })

    expect(pairs(await getAllCategories())).toEqual(UK_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(UK_INCOME)
  })

  it('a new vault in English, or without a lang, gets today\'s defaults', async () => {
    await prepareUnlockedVault({ isNewVault: true, lang: 'en' })
    expect(pairs(await getAllCategories())).toEqual(EN_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(EN_INCOME)

    mockStore.clear()
    await prepareUnlockedVault({ isNewVault: true })
    expect(pairs(await getAllCategories())).toEqual(EN_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(EN_INCOME)
  })

  it('an existing vault only gets the income defaults, in the given language', async () => {
    await prepareUnlockedVault({ isNewVault: false, lang: 'uk' })

    expect(await getAllCategories()).toEqual([])
    expect(pairs(await getAllIncomeCategories())).toEqual(UK_INCOME)
  })

  it('switching the UI language later renames nothing', async () => {
    await prepareUnlockedVault({ isNewVault: true, lang: 'en' })
    const categoriesBlob = mockStore.get('categories')
    const incomeBlob = mockStore.get('incomeCategories')

    setLang('uk', { persist: false })
    await prepareUnlockedVault({ isNewVault: false, lang: 'uk' })
    await prepareUnlockedVault({ isNewVault: true, lang: 'uk' })

    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(mockStore.get('incomeCategories')).toBe(incomeBlob)
    expect(pairs(await getAllCategories())).toEqual(EN_EXPENSE)
    expect(pairs(await getAllIncomeCategories())).toEqual(EN_INCOME)
  })
})
