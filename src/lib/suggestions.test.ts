// No CONTRACT_GAPs: suggestDescriptions and normalizeForMatch follow the rules
// in Approach section 2 of the plan (grouping, 90-day double weight, tiers,
// category boost, tie-breaks, limit).

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SuggestionEntry } from '@/lib/suggestions'
import { normalizeForMatch, suggestDescriptions } from '@/lib/suggestions'

const NOW = new Date('2026-10-20T12:00:00.000Z')
const DAY = 86_400_000

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

function entry(
  description: string | null | undefined,
  daysAgo: number,
  overrides: Partial<SuggestionEntry> = {},
): SuggestionEntry {
  return {
    description,
    categoryId: 'cat-food',
    amount: 10,
    currency: 'UAH',
    createdAt: ago(daysAgo),
    ...overrides,
  }
}

function repeat(
  count: number,
  description: string,
  daysAgo: number,
  overrides: Partial<SuggestionEntry> = {},
): Array<SuggestionEntry> {
  return Array.from({ length: count }, (_, i) =>
    entry(description, daysAgo + i * 0.001, overrides),
  )
}

function names(
  entries: Array<SuggestionEntry>,
  options: Parameters<typeof suggestDescriptions>[1],
): Array<string> {
  return suggestDescriptions(entries, { now: NOW, ...options }).map(
    (s) => s.description,
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeForMatch', () => {
  it('lowercases, trims, collapses spaces and strips diacritics', () => {
    expect(normalizeForMatch('  Café   Latte ')).toBe('cafe latte')
    expect(normalizeForMatch('ÉCLAIR')).toBe('eclair')
  })

  it('keeps plain text as it is apart from the case', () => {
    expect(normalizeForMatch('Coffee')).toBe('coffee')
    expect(normalizeForMatch('')).toBe('')
  })
})

describe('suggestDescriptions: result shape and grouping', () => {
  it('returns the documented fields from the most recent entry of a group', () => {
    const entries = [
      entry('Coffee', 10, { amount: 50, currency: 'USD', categoryId: 'cat-food' }),
      entry('Coffee', 2, { amount: 65, currency: 'UAH', categoryId: 'cat-coffee' }),
      entry('Coffee', 20, { amount: 40, currency: 'EUR', categoryId: 'cat-server' }),
    ]

    const result = suggestDescriptions(entries, { query: '', now: NOW })

    expect(result).toEqual([
      {
        description: 'Coffee',
        categoryId: 'cat-coffee',
        amount: 65,
        currency: 'UAH',
        lastUsed: ago(2),
        count: 3,
      },
    ])
  })

  it('merges case and spacing variants and shows the latest spelling', () => {
    const entries = [
      entry('latte  macchiato', 30),
      entry('LATTE MACCHIATO', 20),
      entry('  Latte   Macchiato ', 1),
    ]

    const result = suggestDescriptions(entries, { query: '', now: NOW })

    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('Latte Macchiato')
    expect(result[0].count).toBe(3)
    expect(result[0].lastUsed).toBe(ago(1))
  })

  it('uses the latest spelling whatever the input order is', () => {
    const newestFirst = [entry('Tea', 1), entry('tea', 9)]
    const oldestFirst = [entry('tea', 9), entry('Tea', 1)]

    expect(names(newestFirst, { query: '' })).toEqual(['Tea'])
    expect(names(oldestFirst, { query: '' })).toEqual(['Tea'])
  })

  it('does not fold diacritics when grouping', () => {
    const entries = [entry('Cafe', 1), entry('Café', 2)]

    const result = suggestDescriptions(entries, { query: '', now: NOW })

    expect(result).toHaveLength(2)
    expect(result.map((s) => s.count)).toEqual([1, 1])
  })

  it('skips entries without a usable description', () => {
    const entries = [
      entry(undefined, 1),
      entry(null, 1),
      entry('', 1),
      entry('   ', 1),
      entry('Bread', 3),
    ]

    expect(names(entries, { query: '' })).toEqual(['Bread'])
  })

  it('returns nothing for no entries', () => {
    expect(suggestDescriptions([], { query: '', now: NOW })).toEqual([])
  })

  it('does not mutate its input', () => {
    const entries = [entry('B', 5), entry('A', 1), entry('a', 2)]
    const snapshot = JSON.stringify(entries)
    Object.freeze(entries)
    entries.forEach((e) => Object.freeze(e))

    suggestDescriptions(entries, { query: 'a', now: NOW })

    expect(JSON.stringify(entries)).toBe(snapshot)
  })
})

describe('suggestDescriptions: score', () => {
  it('ranks Coffee x5 (recent) above Coffee beans x2 for the query "cof"', () => {
    const entries = [
      ...repeat(2, 'Coffee beans', 3),
      ...repeat(5, 'Coffee', 4),
    ]

    expect(names(entries, { query: 'cof' })).toEqual(['Coffee', 'Coffee beans'])
  })

  it('flips the order when the counts flip', () => {
    const entries = [
      ...repeat(5, 'Coffee beans', 3),
      ...repeat(2, 'Coffee', 4),
    ]

    expect(names(entries, { query: 'cof' })).toEqual(['Coffee beans', 'Coffee'])
  })

  it('counts entries of the last 90 days double', () => {
    // A: 2 recent = 4. B: 3 old = 3. A wins.
    const aWins = [...repeat(2, 'A', 5), ...repeat(3, 'B', 200)]
    // A: 2 recent = 4. B: 5 old = 5. B wins.
    const bWins = [...repeat(2, 'A', 5), ...repeat(5, 'B', 200)]

    expect(names(aWins, { query: '' })).toEqual(['A', 'B'])
    expect(names(bWins, { query: '' })).toEqual(['B', 'A'])
  })

  it('treats an entry exactly 90 days old as recent and one older as not', () => {
    // X: two entries at exactly 90 days = 4 when inclusive (2 when not).
    // U: three old entries = 3.
    const atBoundary = [
      entry('X', 90),
      entry('X', 90),
      ...repeat(3, 'U', 150),
    ]
    // Y: two entries at 91 days = 2, below U's 3.
    const pastBoundary = [
      entry('Y', 91),
      entry('Y', 91),
      ...repeat(3, 'U', 150),
    ]

    expect(names(atBoundary, { query: '' })).toEqual(['X', 'U'])
    expect(names(pastBoundary, { query: '' })).toEqual(['U', 'Y'])
  })

  it('uses the current time when now is not given', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const entries = [...repeat(2, 'A', 5), ...repeat(3, 'B', 200)]

    const result = suggestDescriptions(entries, { query: '' })

    expect(result.map((s) => s.description)).toEqual(['A', 'B'])
  })
})

describe('suggestDescriptions: query tiers', () => {
  it('puts prefix matches before substring matches, even with a lower score', () => {
    const entries = [
      ...repeat(5, 'Iced coffee', 2),
      ...repeat(1, 'Coffee', 30),
    ]

    expect(names(entries, { query: 'cof' })).toEqual(['Coffee', 'Iced coffee'])
  })

  it('drops groups that do not match', () => {
    const entries = [...repeat(3, 'Coffee', 2), ...repeat(3, 'Bread', 2)]

    expect(names(entries, { query: 'cof' })).toEqual(['Coffee'])
    expect(names(entries, { query: 'zzz' })).toEqual([])
  })

  it('matches without regard to case', () => {
    const entries = [entry('Coffee', 1)]

    expect(names(entries, { query: 'COF' })).toEqual(['Coffee'])
    expect(names(entries, { query: 'cOFfee' })).toEqual(['Coffee'])
  })

  it('matches without regard to diacritics, in both directions', () => {
    const entries = [entry('Café Latte', 1), entry('Naive', 2)]

    expect(names(entries, { query: 'cafe' })).toEqual(['Café Latte'])
    expect(names(entries, { query: 'CAFÉ' })).toEqual(['Café Latte'])
    expect(names(entries, { query: 'naïv' })).toEqual(['Naive'])
  })

  it('ignores surrounding and repeated spaces in the query', () => {
    const entries = [entry('Iced coffee', 1)]

    expect(names(entries, { query: '  iced   cof ' })).toEqual(['Iced coffee'])
  })

  it('an empty query keeps every group', () => {
    const entries = [entry('A', 1), entry('B', 2), entry('C', 3)]

    expect(names(entries, { query: '' })).toHaveLength(3)
    expect(names(entries, { query: '   ' })).toHaveLength(3)
  })
})

describe('suggestDescriptions: category boost', () => {
  const entries = [
    ...repeat(5, 'Lunch', 2, { categoryId: 'cat-food' }),
    ...repeat(1, 'Espresso', 3, { categoryId: 'cat-coffee' }),
  ]

  it('puts the given category first, then orders by score', () => {
    expect(names(entries, { query: '', categoryId: 'cat-coffee' })).toEqual([
      'Espresso',
      'Lunch',
    ])
    expect(names(entries, { query: '', categoryId: 'cat-food' })).toEqual([
      'Lunch',
      'Espresso',
    ])
  })

  it('does nothing without a categoryId', () => {
    expect(names(entries, { query: '' })).toEqual(['Lunch', 'Espresso'])
  })

  it('uses the category of the most recent entry of the group', () => {
    const mixed = [
      entry('Snack', 20, { categoryId: 'cat-coffee' }),
      entry('Snack', 1, { categoryId: 'cat-food' }),
      ...repeat(3, 'Other', 2, { categoryId: 'cat-server' }),
    ]

    expect(names(mixed, { query: '', categoryId: 'cat-food' })[0]).toBe('Snack')
    expect(names(mixed, { query: '', categoryId: 'cat-coffee' })[0]).toBe('Other')
  })

  it('does not outrank the match tier', () => {
    const tiered = [
      ...repeat(1, 'Cola', 2, { categoryId: 'cat-food' }),
      ...repeat(1, 'Iced coffee', 2, { categoryId: 'cat-coffee' }),
    ]

    expect(names(tiered, { query: 'co', categoryId: 'cat-coffee' })).toEqual([
      'Cola',
      'Iced coffee',
    ])
  })
})

describe('suggestDescriptions: tie-breaks and limit', () => {
  it('breaks equal scores by the most recent use', () => {
    const entries = [entry('Older', 10), entry('Newer', 2)]

    expect(names(entries, { query: '' })).toEqual(['Newer', 'Older'])
  })

  it('breaks equal score and time by the description, ascending', () => {
    const same = ago(4)
    const entries = [
      entry('Zebra', 0, { createdAt: same }),
      entry('Apple', 0, { createdAt: same }),
      entry('Mango', 0, { createdAt: same }),
    ]

    expect(names(entries, { query: '' })).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('returns at most 5 by default', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`Item ${i}`, i + 1))

    expect(suggestDescriptions(entries, { query: '', now: NOW })).toHaveLength(5)
  })

  it('honours a custom limit', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`Item ${i}`, i + 1))

    expect(names(entries, { query: '', limit: 2 })).toEqual(['Item 0', 'Item 1'])
    expect(names(entries, { query: '', limit: 7 })).toHaveLength(7)
  })
})
