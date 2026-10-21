// No CONTRACT_GAPs: recurringInputSchema, recurringInputSchemaFor, the issue
// paths and the messages are specified in the Interface Contract (module:
// schemas) and plan section 9. The schema messages are now catalog keys
// ('errors.validation.*'); validationMessage() turns them into text in the
// current language.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setLang } from '@/i18n/core'
import { validationMessage } from '@/i18n/errors'
import {
  recurringInputSchema,
  recurringInputSchemaFor,
} from '@/lib/schemas'

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

function valid(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'expense',
    amount: 10,
    currency: 'UAH',
    categoryId: 'c1',
    description: 'Netflix',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-03-01',
    end: { type: 'never' },
    mode: 'auto',
    ...overrides,
  }
}

function issuesOf(result: {
  success: boolean
  error?: { issues: Array<{ path: Array<PropertyKey>; message: string }> }
}) {
  return (result.error?.issues ?? []).map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }))
}

describe('recurringInputSchema accepts', () => {
  it('a valid expense and returns the parsed values', () => {
    const result = recurringInputSchema.safeParse(valid())

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      kind: 'expense',
      amount: 10,
      currency: 'UAH',
      categoryId: 'c1',
      frequency: { unit: 'month', interval: 1 },
      startDate: '2026-03-01',
      mode: 'auto',
    })
  })

  it('description may be null, a string or omitted', () => {
    expect(recurringInputSchema.safeParse(valid({ description: null })).success).toBe(true)
    expect(recurringInputSchema.safeParse(valid({ description: 'x' })).success).toBe(true)
    expect(
      recurringInputSchema.safeParse(valid({ description: undefined })).success,
    ).toBe(true)
  })

  it('interval at the bounds 1 and 365', () => {
    for (const interval of [1, 365]) {
      expect(
        recurringInputSchema.safeParse(
          valid({ frequency: { unit: 'day', interval } }),
        ).success,
      ).toBe(true)
    }
  })

  it('all four units, both kinds, both modes and every currency', () => {
    for (const unit of ['day', 'week', 'month', 'year']) {
      expect(
        recurringInputSchema.safeParse(valid({ frequency: { unit, interval: 2 } }))
          .success,
      ).toBe(true)
    }
    expect(recurringInputSchema.safeParse(valid({ kind: 'income' })).success).toBe(true)
    expect(recurringInputSchema.safeParse(valid({ mode: 'ask' })).success).toBe(true)
    for (const currency of ['UAH', 'USD', 'EUR']) {
      expect(recurringInputSchema.safeParse(valid({ currency })).success).toBe(true)
    }
  })

  it('an end date equal to the start date, and afterCount 1', () => {
    expect(
      recurringInputSchema.safeParse(
        valid({ end: { type: 'onDate', date: '2026-03-01' } }),
      ).success,
    ).toBe(true)
    expect(
      recurringInputSchema.safeParse(valid({ end: { type: 'afterCount', count: 1 } }))
        .success,
    ).toBe(true)
  })

  it('a leap day in a leap year', () => {
    expect(
      recurringInputSchema.safeParse(valid({ startDate: '2028-02-29' })).success,
    ).toBe(true)
  })
})

describe('recurringInputSchema rejects', () => {
  it.each([0, -5])('amount %s with the amount-positive key on amount', (amount) => {
    const result = recurringInputSchema.safeParse(valid({ amount }))

    expect(result.success).toBe(false)
    expect(issuesOf(result)).toContainEqual({
      path: 'amount',
      message: 'errors.validation.amountPositive',
    })
  })

  it('a currency that is not in CURRENCIES, on currency', () => {
    const result = recurringInputSchema.safeParse(valid({ currency: 'GBP' }))

    expect(result.success).toBe(false)
    expect(issuesOf(result).map((i) => i.path)).toContain('currency')
  })

  it('an empty categoryId with the category-required key on categoryId', () => {
    const result = recurringInputSchema.safeParse(valid({ categoryId: '' }))

    expect(result.success).toBe(false)
    expect(issuesOf(result)).toContainEqual({
      path: 'categoryId',
      message: 'errors.validation.categoryRequired',
    })
  })

  it.each([0, 366, 1.5, -1])(
    'interval %s with the interval-range key on frequency.interval',
    (interval) => {
      const result = recurringInputSchema.safeParse(
        valid({ frequency: { unit: 'month', interval } }),
      )

      expect(result.success).toBe(false)
      expect(issuesOf(result)).toContainEqual({
        path: 'frequency.interval',
        message: 'errors.validation.intervalRange',
      })
    },
  )

  it('an unknown unit, kind or mode', () => {
    expect(
      recurringInputSchema.safeParse(valid({ frequency: { unit: 'hour', interval: 1 } }))
        .success,
    ).toBe(false)
    expect(recurringInputSchema.safeParse(valid({ kind: 'transfer' })).success).toBe(
      false,
    )
    expect(recurringInputSchema.safeParse(valid({ mode: 'manual' })).success).toBe(false)
  })

  it.each(['2026-02-30', '2026-13-01', '2027-02-29', 'not-a-date', '2026-3-1', ''])(
    'startDate %s with the invalid-date key on startDate',
    (startDate) => {
      const result = recurringInputSchema.safeParse(valid({ startDate }))

      expect(result.success).toBe(false)
      expect(issuesOf(result)).toContainEqual({
        path: 'startDate',
        message: 'errors.validation.invalidDate',
      })
    },
  )

  it('an end date before the start date, on end', () => {
    const result = recurringInputSchema.safeParse(
      valid({ end: { type: 'onDate', date: '2026-02-28' } }),
    )

    expect(result.success).toBe(false)
    expect(issuesOf(result)).toContainEqual({
      path: 'end',
      message: 'errors.validation.endBeforeStart',
    })
  })

  it('an invalid end date', () => {
    const result = recurringInputSchema.safeParse(
      valid({ end: { type: 'onDate', date: '2026-02-31' } }),
    )

    expect(result.success).toBe(false)
  })

  it.each([0, -2])('afterCount %s with the at-least-one key', (count) => {
    const result = recurringInputSchema.safeParse(
      valid({ end: { type: 'afterCount', count } }),
    )

    expect(result.success).toBe(false)
    expect(issuesOf(result).map((i) => i.message)).toContain(
      'errors.validation.atLeastOne',
    )
  })

  it('a fractional afterCount', () => {
    expect(
      recurringInputSchema.safeParse(valid({ end: { type: 'afterCount', count: 1.5 } }))
        .success,
    ).toBe(false)
  })

  it('an end of an unknown type', () => {
    expect(
      recurringInputSchema.safeParse(valid({ end: { type: 'sometimes' } })).success,
    ).toBe(false)
  })
})

describe('recurringInputSchemaFor', () => {
  it('accepts a categoryId that is in the list', () => {
    const schema = recurringInputSchemaFor(['c1', 'c2'])

    expect(schema.safeParse(valid({ categoryId: 'c1' })).success).toBe(true)
    expect(schema.safeParse(valid({ categoryId: 'c2' })).success).toBe(true)
  })

  it('rejects a categoryId that is not in the list with the category-not-found key on categoryId', () => {
    const result = recurringInputSchemaFor(['c1', 'c2']).safeParse(
      valid({ categoryId: 'c9' }),
    )

    expect(result.success).toBe(false)
    expect(issuesOf(result)).toContainEqual({
      path: 'categoryId',
      message: 'errors.validation.categoryNotFound',
    })
  })

  it('rejects everything when the list is empty', () => {
    const result = recurringInputSchemaFor([]).safeParse(valid())

    expect(result.success).toBe(false)
    expect(issuesOf(result).map((i) => i.message)).toContain(
      'errors.validation.categoryNotFound',
    )
  })

  it('still applies the base rules', () => {
    const result = recurringInputSchemaFor(['c1']).safeParse(valid({ amount: 0 }))

    expect(result.success).toBe(false)
    expect(issuesOf(result).map((i) => i.path)).toContain('amount')
  })
})

describe('schema messages become text through validationMessage', () => {
  function messageAt(path: string, overrides: Record<string, unknown>) {
    const result = recurringInputSchema.safeParse(valid(overrides))
    const issue = issuesOf(result).find((i) => i.path === path)
    if (!issue) throw new Error(`no issue at ${path}`)
    return issue.message
  }

  it('shows the English text in English', () => {
    expect(validationMessage(messageAt('amount', { amount: 0 }))).toBe(
      'Amount must be greater than 0',
    )
    expect(validationMessage(messageAt('categoryId', { categoryId: '' }))).toBe(
      'Category is required',
    )
    expect(validationMessage(messageAt('startDate', { startDate: '2026-02-30' }))).toBe(
      'Invalid date',
    )
    expect(
      validationMessage(
        messageAt('end', { end: { type: 'onDate', date: '2026-02-28' } }),
      ),
    ).toBe("End date can't be before the start date")
  })

  it('shows Ukrainian text in Ukrainian', () => {
    setLang('uk', { persist: false })

    expect(validationMessage(messageAt('amount', { amount: 0 }))).toBe(
      'Сума має бути більшою за 0',
    )
    expect(validationMessage(messageAt('categoryId', { categoryId: '' }))).toMatch(
      /[Ѐ-ӿ]/,
    )
    expect(validationMessage(messageAt('startDate', { startDate: '2026-02-30' }))).toMatch(
      /[Ѐ-ӿ]/,
    )
  })
})
