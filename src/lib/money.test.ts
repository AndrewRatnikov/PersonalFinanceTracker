// No CONTRACT_GAPs: the money helpers are fully specified in the Interface
// Contract (module: money) and plan section 7. The language is pinned in
// beforeEach; English expectations are built with Intl for 'en-US' and
// Ukrainian ones for 'uk-UA' (never hard-coded separators).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EntryConversion } from '@/lib/domain'
import { setLang } from '@/i18n/core'
import {
  formatAmount,
  formatMoney,
  formatRate,
  formatShortMoney,
  identityConversion,
  isConverted,
  mainAmountOf,
  pendingLabel,
} from '@/lib/money'

const fmt2 = (n: number) =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const fmt2uk = (n: number) =>
  n.toLocaleString('uk-UA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

function conv(
  mainCurrency: EntryConversion['mainCurrency'],
  mainAmount: number,
  rate = 41.52,
): EntryConversion {
  return { mainCurrency, rate, mainAmount, rateDate: '2026-10-14', source: 'nbu' }
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('formatAmount', () => {
  it('always shows 2 decimals', () => {
    expect(formatAmount(5)).toBe(fmt2(5))
    expect(formatAmount(5.5)).toBe(fmt2(5.5))
    expect(formatAmount(5)).not.toBe(formatAmount(5.5))
  })

  it('rounds for display only: 33.333333 shows as 33.33, 2.675 style values do not gain digits', () => {
    expect(formatAmount(33.333333)).toBe(fmt2(33.33))
    expect(formatAmount(66.666666)).toBe(fmt2(66.67))
  })

  it('formats large numbers with the locale grouping', () => {
    expect(formatAmount(1234567.891)).toBe(fmt2(1234567.89))
  })

  it('formats negative numbers', () => {
    expect(formatAmount(-12.5)).toBe(fmt2(-12.5))
  })

  it('follows the UI language, not the device locale', () => {
    expect(formatAmount(1234.5)).toBe(fmt2(1234.5))

    setLang('uk', { persist: false })

    expect(formatAmount(1234.5)).toBe(fmt2uk(1234.5))
    expect(formatAmount(1234.5)).not.toBe(fmt2(1234.5))
  })
})

describe('formatMoney', () => {
  it('appends the currency code to the 2-decimal amount', () => {
    expect(formatMoney(830.4, 'UAH')).toBe(`${fmt2(830.4)} UAH`)
    expect(formatMoney(20, 'USD')).toBe(`${fmt2(20)} USD`)
    expect(formatMoney(33.333333, 'EUR')).toBe(`${fmt2(33.33)} EUR`)
  })

  it('differs by currency and by value', () => {
    expect(formatMoney(1, 'UAH')).not.toBe(formatMoney(1, 'USD'))
    expect(formatMoney(1, 'UAH')).not.toBe(formatMoney(2, 'UAH'))
  })

  it('in Ukrainian writes грн for the hryvnia and keeps the code for other currencies', () => {
    setLang('uk', { persist: false })

    expect(formatMoney(830.4, 'UAH')).toBe(`${fmt2uk(830.4)} грн`)
    expect(formatMoney(20, 'USD')).toBe(`${fmt2uk(20)} USD`)
    expect(formatMoney(33.333333, 'EUR')).toBe(`${fmt2uk(33.33)} EUR`)
  })
})

describe('formatShortMoney', () => {
  it('shows a whole amount without decimals, in the UI language', () => {
    expect(formatShortMoney(65, 'UAH')).toBe('65 UAH')

    setLang('uk', { persist: false })

    expect(formatShortMoney(65, 'UAH')).toBe('65 грн')
    expect(formatShortMoney(12.5, 'USD')).toBe(`${fmt2uk(12.5)} USD`)
  })
})

describe('formatRate', () => {
  it('shows up to 4 fraction digits', () => {
    const expected = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    expect(formatRate(41.52)).toBe(expected(41.52))
    expect(formatRate(41.123456)).toBe(expected(41.1235))
    expect(formatRate(0.02217)).toBe(expected(0.0222))
    expect(formatRate(1)).toBe(expected(1))
  })

  it('differs for different rates', () => {
    expect(formatRate(41.52)).not.toBe(formatRate(45.1))
  })

  it('uses the Ukrainian decimal separator in Ukrainian', () => {
    setLang('uk', { persist: false })

    expect(formatRate(41.123456)).toBe(
      (41.1235).toLocaleString('uk-UA', { maximumFractionDigits: 4 }),
    )
    expect(formatRate(41.52)).not.toBe((41.52).toLocaleString('en-US'))
  })
})

describe('isConverted', () => {
  it('is true only when the stored conversion is for the given main currency', () => {
    const entry = { conversion: conv('UAH', 830.4) }

    expect(isConverted(entry, 'UAH')).toBe(true)
    expect(isConverted(entry, 'EUR')).toBe(false)
    expect(isConverted(entry, 'USD')).toBe(false)
  })

  it('is false without a conversion', () => {
    expect(isConverted({}, 'UAH')).toBe(false)
  })
})

describe('mainAmountOf', () => {
  it('returns the stored mainAmount of a converted entry (unrounded)', () => {
    const entry = {
      amount: 20,
      currency: 'USD' as const,
      conversion: conv('UAH', 830.4000001),
    }

    expect(mainAmountOf(entry, 'UAH')).toBe(830.4000001)
  })

  it('uses the stored mainAmount of two different entries differently', () => {
    const a = { amount: 1, currency: 'USD' as const, conversion: conv('UAH', 41.5) }
    const b = { amount: 1, currency: 'EUR' as const, conversion: conv('UAH', 45.1) }

    expect(mainAmountOf(a, 'UAH')).toBe(41.5)
    expect(mainAmountOf(b, 'UAH')).toBe(45.1)
  })

  it('returns the amount for an entry already in the main currency, without a stored conversion', () => {
    expect(mainAmountOf({ amount: 100, currency: 'UAH' }, 'UAH')).toBe(100)
    expect(mainAmountOf({ amount: 7, currency: 'EUR' }, 'EUR')).toBe(7)
  })

  it('returns null (pending) for another currency without a matching conversion', () => {
    expect(mainAmountOf({ amount: 20, currency: 'USD' }, 'UAH')).toBeNull()
  })

  it('returns null when the conversion is for another main currency', () => {
    const entry = {
      amount: 20,
      currency: 'USD' as const,
      conversion: conv('UAH', 830.4),
    }

    expect(mainAmountOf(entry, 'EUR')).toBeNull()
  })

  it('falls back to the amount when the entry is in the main currency but its conversion is for an older main currency', () => {
    const entry = {
      amount: 20,
      currency: 'USD' as const,
      conversion: conv('UAH', 830.4),
    }

    expect(mainAmountOf(entry, 'USD')).toBe(20)
  })
})

describe('identityConversion', () => {
  it('has rate 1, the amount as mainAmount and the source "identity"', () => {
    const createdAt = new Date(2026, 9, 14, 12, 0, 0).toISOString()

    expect(identityConversion({ amount: 100, createdAt }, 'UAH')).toEqual({
      mainCurrency: 'UAH',
      rate: 1,
      mainAmount: 100,
      rateDate: '2026-10-14',
      source: 'identity',
    })
  })

  it('carries the main currency and the amount', () => {
    const createdAt = new Date(2026, 0, 5, 12, 0, 0).toISOString()
    const result = identityConversion({ amount: 33.333333, createdAt }, 'EUR')

    expect(result.mainCurrency).toBe('EUR')
    expect(result.mainAmount).toBe(33.333333)
    expect(result.rateDate).toBe('2026-01-05')
  })

  it('takes rateDate from the LOCAL calendar date of createdAt', () => {
    const justAfterLocalMidnight = new Date(2026, 9, 14, 0, 30, 0).toISOString()
    const lateEvening = new Date(2026, 9, 14, 23, 45, 0).toISOString()

    expect(
      identityConversion({ amount: 1, createdAt: justAfterLocalMidnight }, 'UAH')
        .rateDate,
    ).toBe('2026-10-14')
    expect(
      identityConversion({ amount: 1, createdAt: lateEvening }, 'UAH').rateDate,
    ).toBe('2026-10-14')
  })

  it('makes the entry converted for that main currency', () => {
    const createdAt = new Date(2026, 9, 14, 12, 0, 0).toISOString()
    const entry = { conversion: identityConversion({ amount: 5, createdAt }, 'UAH') }

    expect(isConverted(entry, 'UAH')).toBe(true)
    expect(isConverted(entry, 'USD')).toBe(false)
  })

  it('stays a machine date whatever the UI language', () => {
    setLang('uk', { persist: false })
    const createdAt = new Date(2026, 9, 14, 12, 0, 0).toISOString()

    expect(identityConversion({ amount: 1, createdAt }, 'UAH').rateDate).toBe(
      '2026-10-14',
    )
  })
})

describe('pendingLabel', () => {
  it('uses the singular for 1', () => {
    expect(pendingLabel(1)).toBe('1 entry waiting for exchange rates')
  })

  it('uses the plural otherwise', () => {
    expect(pendingLabel(2)).toBe('2 entries waiting for exchange rates')
    expect(pendingLabel(15)).toBe('15 entries waiting for exchange rates')
  })

  it('is Ukrainian in Ukrainian and carries the count', () => {
    setLang('uk', { persist: false })

    for (const count of [1, 2, 5, 21]) {
      const label = pendingLabel(count)
      expect(label).toMatch(/[Ѐ-ӿ]/)
      expect(label).toContain(String(count))
      expect(label).not.toContain('entry')
      expect(label).not.toContain('entries')
    }
    expect(pendingLabel(1)).not.toBe(pendingLabel(5))
  })
})
