// No CONTRACT_GAPs: convertIncomeSources, DEFAULT_INCOME_CATEGORIES and
// incomeSourceLabel are fully specified in the Interface Contract (module:
// incomeCategories). Ids come from crypto.randomUUID, so the tests assert by
// name; `now` pins the timestamps.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Category, IncomeEntry } from '@/lib/domain'
import {
  DEFAULT_INCOME_CATEGORIES,
  convertIncomeSources,
  incomeSourceLabel,
} from '@/lib/incomeCategories'

const NOW = '2026-05-01T08:00:00.000Z'
const OLD = '2025-01-02T03:04:05.000Z'

// A legacy record: a free-text source and no categoryId.
function legacy(
  id: string,
  source: string | undefined,
  overrides: Partial<IncomeEntry> = {},
): IncomeEntry {
  const record: Record<string, unknown> = {
    id,
    amount: 100,
    currency: 'UAH',
    description: `desc ${id}`,
    createdAt: '2025-03-15T10:00:00.000Z',
    updatedAt: OLD,
    ...overrides,
  }
  if (source !== undefined) record.source = source
  // Legacy records have no categoryId at all.
  return record as unknown as IncomeEntry
}

function converted(
  result: ReturnType<typeof convertIncomeSources>,
  id: string,
): IncomeEntry {
  const found = result.income.find((i) => i.id === id)
  if (!found) throw new Error(`no income ${id} in the result`)
  return found
}

function nameOf(
  result: ReturnType<typeof convertIncomeSources>,
  id: string,
): string | undefined {
  const entry = converted(result, id)
  return result.incomeCategories.find((c) => c.id === entry.categoryId)?.name
}

function names(result: ReturnType<typeof convertIncomeSources>): Array<string> {
  return result.incomeCategories.map((c) => c.name)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DEFAULT_INCOME_CATEGORIES', () => {
  it('is exactly the six defaults, in order, with icons', () => {
    expect(DEFAULT_INCOME_CATEGORIES).toEqual([
      { name: 'Salary', icon: '💼' },
      { name: 'Freelance', icon: '💻' },
      { name: 'Gifts', icon: '🎁' },
      { name: 'Investments', icon: '📈' },
      { name: 'Refunds', icon: '↩️' },
      { name: 'Other', icon: '🪙' },
    ])
  })
})

describe('convertIncomeSources: the Salary / " salary " / Upwork / "" case', () => {
  const income = [
    legacy('i1', 'Salary', { amount: 1000, createdAt: '2025-03-01T09:00:00.000Z' }),
    legacy('i2', ' salary ', { amount: 250.5, createdAt: '2025-03-02T09:00:00.000Z' }),
    legacy('i3', 'Upwork', { amount: 75, currency: 'USD' }),
    legacy('i4', '', { amount: 5 }),
  ]

  it('creates Salary and Upwork once each, adds the missing defaults and maps the empty source to Other', () => {
    const result = convertIncomeSources(income, [], {
      now: NOW,
      addDefaults: true,
    })

    expect(names(result)).toEqual([
      'Salary',
      'Upwork',
      'Freelance',
      'Gifts',
      'Investments',
      'Refunds',
      'Other',
    ])
    expect(result.created).toBe(7)
    expect(nameOf(result, 'i1')).toBe('Salary')
    expect(nameOf(result, 'i2')).toBe('Salary')
    expect(converted(result, 'i1').categoryId).toBe(
      converted(result, 'i2').categoryId,
    )
    expect(nameOf(result, 'i3')).toBe('Upwork')
    expect(nameOf(result, 'i4')).toBe('Other')
  })

  it('gives source categories a null icon and the rest their default icon, stamped with now', () => {
    const result = convertIncomeSources(income, [], {
      now: NOW,
      addDefaults: true,
    })

    const byName = (n: string) => result.incomeCategories.find((c) => c.name === n)
    expect(byName('Salary')?.icon).toBeNull()
    expect(byName('Upwork')?.icon).toBeNull()
    expect(byName('Freelance')?.icon).toBe('💻')
    expect(byName('Other')?.icon).toBe('🪙')
    for (const c of result.incomeCategories) expect(c.updatedAt).toBe(NOW)
    expect(new Set(result.incomeCategories.map((c) => c.id)).size).toBe(7)
  })

  it('every converted entry has a valid categoryId, no source, a new updatedAt and unchanged data', () => {
    const result = convertIncomeSources(income, [], {
      now: NOW,
      addDefaults: true,
    })

    const ids = new Set(result.incomeCategories.map((c) => c.id))
    expect(result.income).toHaveLength(4)
    for (const original of income) {
      const out = converted(result, original.id)
      expect(ids.has(out.categoryId)).toBe(true)
      expect('source' in out).toBe(false)
      expect('category' in out).toBe(false)
      expect(out.updatedAt).toBe(NOW)
      expect(out.amount).toBe(original.amount)
      expect(out.currency).toBe(original.currency)
      expect(out.createdAt).toBe(original.createdAt)
      expect(out.description).toBe(original.description)
    }
  })

  it('without addDefaults only the source categories (and Other for the empty source) are created', () => {
    const result = convertIncomeSources(income, [], { now: NOW })

    expect(names(result)).toEqual(['Salary', 'Upwork', 'Other'])
    expect(result.created).toBe(3)
    expect(nameOf(result, 'i4')).toBe('Other')
    expect(result.incomeCategories.find((c) => c.name === 'Other')?.icon).toBe(
      '🪙',
    )
  })
})

describe('convertIncomeSources: names', () => {
  it('the first spelling wins, trimmed, ignoring case', () => {
    const result = convertIncomeSources(
      [legacy('a', '  upwork '), legacy('b', 'UPWORK'), legacy('c', 'Upwork')],
      [],
      { now: NOW },
    )

    expect(names(result)).toEqual(['upwork'])
    expect(new Set(result.income.map((i) => i.categoryId)).size).toBe(1)
  })

  it('a different first spelling gives a different name', () => {
    const result = convertIncomeSources(
      [legacy('a', 'UPWORK'), legacy('b', 'upwork')],
      [],
      { now: NOW },
    )

    expect(names(result)).toEqual(['UPWORK'])
  })

  it('creates one category per distinct source, in input order', () => {
    const result = convertIncomeSources(
      [legacy('a', 'Zeta'), legacy('b', 'Alpha'), legacy('c', 'zeta')],
      [],
      { now: NOW },
    )

    expect(names(result)).toEqual(['Zeta', 'Alpha'])
  })

  it('a whitespace-only and a missing source both map to Other', () => {
    const result = convertIncomeSources(
      [legacy('a', '   '), legacy('b', undefined)],
      [],
      { now: NOW },
    )

    expect(names(result)).toEqual(['Other'])
    expect(nameOf(result, 'a')).toBe('Other')
    expect(nameOf(result, 'b')).toBe('Other')
  })
})

describe('convertIncomeSources: existing categories', () => {
  const existing: Array<Category> = [
    { id: 'ic-sal', name: 'salary', icon: '💼', updatedAt: OLD },
    { id: 'ic-oth', name: 'OTHER', icon: null, updatedAt: OLD },
  ]

  it('matches a source to an existing category ignoring case and creates nothing', () => {
    const result = convertIncomeSources(
      [legacy('a', ' Salary '), legacy('b', '')],
      existing,
      { now: NOW },
    )

    expect(result.created).toBe(0)
    expect(converted(result, 'a').categoryId).toBe('ic-sal')
    expect(converted(result, 'b').categoryId).toBe('ic-oth')
    expect(names(result)).toEqual(['salary', 'OTHER'])
  })

  it('keeps the existing records exactly as they are', () => {
    const result = convertIncomeSources([legacy('a', 'Gig')], existing, {
      now: NOW,
    })

    expect(result.incomeCategories[0]).toBe(existing[0])
    expect(result.incomeCategories[1]).toBe(existing[1])
    expect(names(result)).toEqual(['salary', 'OTHER', 'Gig'])
    expect(result.created).toBe(1)
  })

  it('addDefaults adds only the defaults that are missing, case-insensitively', () => {
    const result = convertIncomeSources([], existing, {
      now: NOW,
      addDefaults: true,
    })

    expect(names(result)).toEqual([
      'salary',
      'OTHER',
      'Freelance',
      'Gifts',
      'Investments',
      'Refunds',
    ])
    expect(result.created).toBe(4)
  })

  it('creates Other (with its icon) when it is needed and absent', () => {
    const result = convertIncomeSources(
      [legacy('a', '')],
      [{ id: 'ic-sal', name: 'Salary', icon: '💼', updatedAt: OLD }],
      { now: NOW },
    )

    expect(names(result)).toEqual(['Salary', 'Other'])
    expect(result.incomeCategories[1].icon).toBe('🪙')
    expect(result.created).toBe(1)
  })

  it('with no income and no defaults changes nothing', () => {
    const result = convertIncomeSources([], existing, { now: NOW })

    expect(result.incomeCategories).toEqual(existing)
    expect(result.income).toEqual([])
    expect(result.created).toBe(0)
  })

  it('with no income and addDefaults gives the six defaults', () => {
    const result = convertIncomeSources([], [], { now: NOW, addDefaults: true })

    expect(names(result)).toEqual(DEFAULT_INCOME_CATEGORIES.map((c) => c.name))
    expect(result.created).toBe(6)
    expect(result.income).toEqual([])
  })
})

describe('convertIncomeSources: entries that already have a category', () => {
  it('returns them as the very same object, untouched', () => {
    const done: IncomeEntry = {
      id: 'done',
      categoryId: 'ic-x',
      amount: 9,
      currency: 'EUR',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: OLD,
    }
    const result = convertIncomeSources(
      [done, legacy('a', 'Gig')],
      [{ id: 'ic-x', name: 'X', icon: null, updatedAt: OLD }],
      { now: NOW },
    )

    expect(result.income[0]).toBe(done)
    expect(done.updatedAt).toBe(OLD)
    expect(converted(result, 'a').updatedAt).toBe(NOW)
  })

  it('does not create a category for the source of an already categorised entry', () => {
    const done = { ...legacy('done', 'Ignored'), categoryId: 'ic-x' }
    const result = convertIncomeSources([done], [], { now: NOW })

    expect(result.incomeCategories).toEqual([])
    expect(result.created).toBe(0)
    expect(result.income[0]).toBe(done)
  })

  it('treats an empty categoryId as needing conversion', () => {
    const result = convertIncomeSources(
      [legacy('a', 'Gig', { categoryId: '' })],
      [],
      { now: NOW },
    )

    expect(nameOf(result, 'a')).toBe('Gig')
  })
})

describe('convertIncomeSources: timestamps', () => {
  it('preserveUpdatedAt keeps the entry own updatedAt', () => {
    const result = convertIncomeSources([legacy('a', 'Gig')], [], {
      now: NOW,
      preserveUpdatedAt: true,
    })

    expect(converted(result, 'a').updatedAt).toBe(OLD)
  })

  it('preserveUpdatedAt leaves updatedAt absent when the entry had none', () => {
    const noStamp = legacy('a', 'Gig')
    Reflect.deleteProperty(noStamp, 'updatedAt')

    const result = convertIncomeSources([noStamp], [], {
      now: NOW,
      preserveUpdatedAt: true,
    })

    expect('updatedAt' in converted(result, 'a')).toBe(false)
  })

  it('without preserveUpdatedAt a missing updatedAt becomes now', () => {
    const noStamp = legacy('a', 'Gig')
    Reflect.deleteProperty(noStamp, 'updatedAt')

    const result = convertIncomeSources([noStamp], [], { now: NOW })

    expect(converted(result, 'a').updatedAt).toBe(NOW)
  })

  it('defaults now to the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-02-03T04:05:06.000Z'))

    const result = convertIncomeSources([legacy('a', 'Gig')], [])

    expect(converted(result, 'a').updatedAt).toBe('2027-02-03T04:05:06.000Z')
    expect(result.incomeCategories[0].updatedAt).toBe('2027-02-03T04:05:06.000Z')
  })
})

describe('convertIncomeSources: purity and idempotence', () => {
  it('never mutates its inputs', () => {
    const income = [legacy('a', 'Salary'), legacy('b', '')]
    const categories: Array<Category> = [
      { id: 'ic-1', name: 'Gifts', icon: '🎁', updatedAt: OLD },
    ]
    const incomeBefore = JSON.stringify(income)
    const categoriesBefore = JSON.stringify(categories)
    Object.freeze(income)
    Object.freeze(categories)
    for (const i of income) Object.freeze(i)
    for (const c of categories) Object.freeze(c)

    const result = convertIncomeSources(income, categories, {
      now: NOW,
      addDefaults: true,
    })

    expect(JSON.stringify(income)).toBe(incomeBefore)
    expect(JSON.stringify(categories)).toBe(categoriesBefore)
    expect(result.income).not.toBe(income)
    expect(result.incomeCategories).not.toBe(categories)
    expect(income[0].source).toBe('Salary')
  })

  it('a second run over its own result creates nothing and returns the same entries', () => {
    const first = convertIncomeSources(
      [legacy('a', 'Salary'), legacy('b', 'Upwork'), legacy('c', '')],
      [],
      { now: NOW, addDefaults: true },
    )

    const second = convertIncomeSources(first.income, first.incomeCategories, {
      now: '2030-01-01T00:00:00.000Z',
      addDefaults: true,
    })

    expect(second.created).toBe(0)
    expect(second.incomeCategories).toEqual(first.incomeCategories)
    first.income.forEach((entry, index) => {
      expect(second.income[index]).toBe(entry)
    })
  })

  it('is deterministic apart from the generated ids', () => {
    const input = [legacy('a', 'Salary'), legacy('b', 'Upwork')]

    const a = convertIncomeSources(input, [], { now: NOW, addDefaults: true })
    const b = convertIncomeSources(input, [], { now: NOW, addDefaults: true })

    expect(names(a)).toEqual(names(b))
    expect(a.created).toBe(b.created)
    expect(nameOf(a, 'a')).toBe(nameOf(b, 'a'))
    expect(a.incomeCategories[0].id).not.toBe(b.incomeCategories[0].id)
  })
})

describe('incomeSourceLabel', () => {
  it('prefers the category name', () => {
    expect(
      incomeSourceLabel({
        category: { id: 'c', name: 'Salary', icon: null },
        source: 'Old text',
      }),
    ).toBe('Salary')
  })

  it('falls back to the trimmed legacy source', () => {
    expect(
      incomeSourceLabel({ category: undefined, source: '  Freelance gig ' }),
    ).toBe('Freelance gig')
    expect(incomeSourceLabel({ source: 'Other gig' })).toBe('Other gig')
  })

  it('falls back to Uncategorized for a blank or missing source', () => {
    expect(incomeSourceLabel({})).toBe('Uncategorized')
    expect(incomeSourceLabel({ source: '' })).toBe('Uncategorized')
    expect(incomeSourceLabel({ source: '   ' })).toBe('Uncategorized')
    expect(incomeSourceLabel({ category: undefined, source: undefined })).toBe(
      'Uncategorized',
    )
  })
})
