// No CONTRACT_GAPs: the draft and URL helpers are fully specified in the
// Interface Contract (module: expenseDraft) and plan Approach section 2.

import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'

import type { TransactionsSearch } from '@/lib/expenseDraft'
import {
  buildCreatedAt,
  createdAtForDate,
  drawerInitialFromSearch,
  parseDraftAmount,
  validateTransactionsSearch,
} from '@/lib/expenseDraft'

describe('parseDraftAmount', () => {
  it.each([
    ['65', 65],
    ['12,5', 12.5],
    ['12.5', 12.5],
    ['  7 ', 7],
    ['0,25', 0.25],
  ])('parses "%s" as %d', (text, expected) => {
    expect(parseDraftAmount(text)).toBe(expected)
  })

  it.each(['', '   ', '1.2.3', '1,2,3', '1.2,3', '1,2.3', 'abc', '12,5x'])(
    'returns NaN for "%s"',
    (text) => {
      expect(Number.isNaN(parseDraftAmount(text))).toBe(true)
    },
  )
})

describe('buildCreatedAt', () => {
  const original = new Date(2026, 2, 15, 14, 30, 45, 123).toISOString()

  it('returns the original timestamp untouched when the date did not change', () => {
    expect(buildCreatedAt('2026-03-15', '2026-03-15', original)).toBe(original)
  })

  it('returns an empty string for an empty date', () => {
    expect(buildCreatedAt('', '2026-03-15', original)).toBe('')
  })

  it('moves to the picked date and keeps the original local time of day', () => {
    const result = buildCreatedAt('2026-04-02', '2026-03-15', original)
    const parsed = dayjs(result)

    expect(parsed.format('YYYY-MM-DD')).toBe('2026-04-02')
    expect(parsed.hour()).toBe(14)
    expect(parsed.minute()).toBe(30)
    expect(parsed.second()).toBe(45)
    expect(parsed.millisecond()).toBe(123)
  })

  it('keeps the time of day of a different original', () => {
    const other = new Date(2026, 0, 5, 7, 5, 9, 0).toISOString()

    const parsed = dayjs(buildCreatedAt('2026-02-20', '2026-01-05', other))

    expect(parsed.format('YYYY-MM-DD')).toBe('2026-02-20')
    expect(parsed.hour()).toBe(7)
    expect(parsed.minute()).toBe(5)
  })

  it('returns an invalid date unchanged, so validation fails on it', () => {
    expect(buildCreatedAt('not-a-date', '2026-03-15', original)).toBe('not-a-date')
  })
})

describe('createdAtForDate', () => {
  const now = new Date(2026, 9, 20, 16, 45, 30, 0)

  it('returns undefined for today, so the store stamps the current time', () => {
    expect(createdAtForDate('2026-10-20', '2026-10-20', now)).toBeUndefined()
  })

  it('returns the picked local date with the time of day of now', () => {
    const result = createdAtForDate('2026-10-18', '2026-10-20', now)
    const parsed = dayjs(result)

    expect(parsed.format('YYYY-MM-DD')).toBe('2026-10-18')
    expect(parsed.hour()).toBe(16)
    expect(parsed.minute()).toBe(45)
    expect(parsed.second()).toBe(30)
  })

  it('works for a future date as well', () => {
    const result = createdAtForDate('2026-11-02', '2026-10-20', now)

    expect(dayjs(result).format('YYYY-MM-DD')).toBe('2026-11-02')
    expect(dayjs(result).hour()).toBe(16)
  })

  it('returns an invalid date unchanged', () => {
    expect(createdAtForDate('garbage', '2026-10-20', now)).toBe('garbage')
  })

  it('uses the current time when now is not given', () => {
    const before = Date.now()
    const result = createdAtForDate('2026-01-01', '2026-10-20')
    const after = Date.now()
    const parsed = dayjs(result)

    expect(parsed.format('YYYY-MM-DD')).toBe('2026-01-01')
    const nowMinutes = new Date(before).getHours() * 60 + new Date(before).getMinutes()
    const parsedMinutes = parsed.hour() * 60 + parsed.minute()
    const endMinutes = new Date(after).getHours() * 60 + new Date(after).getMinutes()
    // Allow the minute to roll over while the test runs.
    expect(parsedMinutes === nowMinutes || parsedMinutes === endMinutes).toBe(true)
  })
})

describe('validateTransactionsSearch', () => {
  it('keeps a full, valid add request (a numeric amount becomes a string)', () => {
    expect(
      validateTransactionsSearch({
        add: 'expense',
        category: 'cat-food',
        amount: 12.5,
        currency: 'EUR',
      }),
    ).toEqual({
      add: 'expense',
      category: 'cat-food',
      amount: '12.5',
      currency: 'EUR',
    })
  })

  it('keeps every prefill param of a different request', () => {
    expect(
      validateTransactionsSearch({
        add: 'expense',
        category: 'cat-coffee',
        amount: '65',
        currency: 'uah',
        description: 'Coffee',
      }),
    ).toEqual({
      add: 'expense',
      category: 'cat-coffee',
      amount: '65',
      currency: 'UAH',
      description: 'Coffee',
    })
  })

  it('drops an add value other than "expense"', () => {
    expect(validateTransactionsSearch({ add: 'income' })).toEqual({})
    expect(validateTransactionsSearch({ add: true })).toEqual({})
    expect(validateTransactionsSearch({ add: 'Expense' })).toEqual({})
  })

  it('reads the prefill params only together with add=expense', () => {
    expect(
      validateTransactionsSearch({ category: 'cat-food', amount: 5, currency: 'USD' }),
    ).toEqual({})
    expect(
      validateTransactionsSearch({ add: 'income', amount: 5, description: 'x' }),
    ).toEqual({})
  })

  it('lets edit win over add', () => {
    expect(
      validateTransactionsSearch({ edit: 'e1', add: 'expense', amount: 5 }),
    ).toEqual({ edit: 'e1' })
  })

  it('keeps a valid edit id on its own', () => {
    expect(validateTransactionsSearch({ edit: 'abc_DEF-123' })).toEqual({
      edit: 'abc_DEF-123',
    })
  })

  it('drops invalid ids', () => {
    expect(validateTransactionsSearch({ edit: 'a b' })).toEqual({})
    expect(validateTransactionsSearch({ edit: '<script>' })).toEqual({})
    expect(validateTransactionsSearch({ edit: '' })).toEqual({})
    expect(validateTransactionsSearch({ edit: 42 })).toEqual({})
    expect(validateTransactionsSearch({ edit: 'x'.repeat(101) })).toEqual({})
    expect(
      validateTransactionsSearch({ add: 'expense', category: '<script>' }),
    ).toEqual({ add: 'expense' })
    expect(
      validateTransactionsSearch({ add: 'expense', category: 'x'.repeat(101) }),
    ).toEqual({ add: 'expense' })
  })

  it('accepts ids of up to 100 characters', () => {
    const id = 'x'.repeat(100)

    expect(validateTransactionsSearch({ edit: id })).toEqual({ edit: id })
  })

  it('falls back to add when the edit id is invalid', () => {
    expect(
      validateTransactionsSearch({ edit: 'bad id', add: 'expense', amount: 5 }),
    ).toEqual({ add: 'expense', amount: '5' })
  })

  it('drops the bad prefill values of a request but keeps add', () => {
    expect(
      validateTransactionsSearch({
        add: 'expense',
        amount: '-3',
        currency: 'GBP',
        category: '<script>',
      }),
    ).toEqual({ add: 'expense' })
  })

  it('normalises a decimal comma in the amount', () => {
    expect(validateTransactionsSearch({ add: 'expense', amount: '12,5' })).toEqual({
      add: 'expense',
      amount: '12.5',
    })
  })

  it.each([
    ['0', undefined],
    ['0.00', undefined],
    ['-1', undefined],
    ['abc', undefined],
    ['1.234', undefined],
    ['1234567890', undefined],
    ['', undefined],
    ['5', '5'],
    ['123456789', '123456789'],
    ['0.5', '0.5'],
    ['10.25', '10.25'],
  ])('amount "%s" becomes %s', (amount, expected) => {
    const result: TransactionsSearch = validateTransactionsSearch({
      add: 'expense',
      amount,
    })

    expect(result.amount).toBe(expected)
  })

  it('accepts a numeric amount and drops other types', () => {
    expect(validateTransactionsSearch({ add: 'expense', amount: 7 }).amount).toBe('7')
    expect(validateTransactionsSearch({ add: 'expense', amount: 0 }).amount).toBeUndefined()
    expect(
      validateTransactionsSearch({ add: 'expense', amount: { v: 1 } }).amount,
    ).toBeUndefined()
    expect(
      validateTransactionsSearch({ add: 'expense', amount: ['5'] }).amount,
    ).toBeUndefined()
  })

  it('upper-cases a known currency and drops an unknown one', () => {
    expect(validateTransactionsSearch({ add: 'expense', currency: 'usd' }).currency).toBe(
      'USD',
    )
    expect(validateTransactionsSearch({ add: 'expense', currency: 'EUR' }).currency).toBe(
      'EUR',
    )
    expect(
      validateTransactionsSearch({ add: 'expense', currency: 'GBP' }).currency,
    ).toBeUndefined()
    expect(
      validateTransactionsSearch({ add: 'expense', currency: 5 }).currency,
    ).toBeUndefined()
  })

  it('trims the description, cuts it to 120 characters and drops empty ones', () => {
    expect(
      validateTransactionsSearch({ add: 'expense', description: '  Coffee  ' })
        .description,
    ).toBe('Coffee')
    expect(
      validateTransactionsSearch({ add: 'expense', description: 'a'.repeat(300) })
        .description,
    ).toBe('a'.repeat(120))
    expect(
      validateTransactionsSearch({ add: 'expense', description: '   ' }).description,
    ).toBeUndefined()
    expect(
      validateTransactionsSearch({ add: 'expense', description: 42 }).description,
    ).toBe('42')
    expect(
      validateTransactionsSearch({ add: 'expense', description: { a: 1 } })
        .description,
    ).toBeUndefined()
    expect(
      validateTransactionsSearch({ add: 'expense', description: Number.NaN })
        .description,
    ).toBeUndefined()
  })

  it('drops unknown keys', () => {
    expect(
      validateTransactionsSearch({ add: 'expense', foo: 'bar', page: 3 }),
    ).toEqual({ add: 'expense' })
    expect(validateTransactionsSearch({ foo: 'bar' })).toEqual({})
  })

  it('returns an empty object for an empty search', () => {
    expect(validateTransactionsSearch({})).toEqual({})
  })
})

describe('drawerInitialFromSearch', () => {
  it('maps the search params to the drawer initial values', () => {
    expect(
      drawerInitialFromSearch({
        add: 'expense',
        category: 'cat-coffee',
        amount: '65',
        currency: 'UAH',
        description: 'Coffee',
      }),
    ).toEqual({
      categoryId: 'cat-coffee',
      amount: '65',
      currency: 'UAH',
      description: 'Coffee',
    })
  })

  it('omits the keys that are not set', () => {
    const initial = drawerInitialFromSearch({ add: 'expense', amount: '12.5' })

    expect(Object.keys(initial)).toEqual(['amount'])
    expect(initial.amount).toBe('12.5')
  })

  it('returns an empty object for a bare add request', () => {
    expect(Object.keys(drawerInitialFromSearch({ add: 'expense' }))).toEqual([])
  })
})
