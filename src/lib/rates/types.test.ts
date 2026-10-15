// No CONTRACT_GAPs: crossRate, RateUnavailableError and RateTable are fully
// specified in the Interface Contract (module: rates).

import { describe, expect, it } from 'vitest'

import type { RateTable } from '@/lib/rates/types'
import { RateUnavailableError, crossRate } from '@/lib/rates/types'

const TABLE: RateTable = {
  base: 'UAH',
  effectiveDate: '2026-10-14',
  perBase: { UAH: 1, USD: 41.52, EUR: 45.1 },
}

describe('crossRate', () => {
  it('USD to EUR is 41.52 / 45.10', () => {
    expect(crossRate(TABLE, 'USD', 'EUR')).toBeCloseTo(41.52 / 45.1, 12)
  })

  it('EUR to UAH is 45.10 and USD to UAH is 41.52', () => {
    expect(crossRate(TABLE, 'EUR', 'UAH')).toBe(45.1)
    expect(crossRate(TABLE, 'USD', 'UAH')).toBe(41.52)
  })

  it('UAH to USD is the inverse of USD to UAH', () => {
    expect(crossRate(TABLE, 'UAH', 'USD')).toBeCloseTo(1 / 41.52, 12)
    expect(crossRate(TABLE, 'UAH', 'USD') * crossRate(TABLE, 'USD', 'UAH')).toBeCloseTo(
      1,
      12,
    )
  })

  it('is 1 from a currency to itself', () => {
    expect(crossRate(TABLE, 'USD', 'USD')).toBe(1)
    expect(crossRate(TABLE, 'UAH', 'UAH')).toBe(1)
  })

  it('gives different results for different pairs (not a constant)', () => {
    expect(crossRate(TABLE, 'USD', 'UAH')).not.toBe(crossRate(TABLE, 'EUR', 'UAH'))
  })

  it('throws RateUnavailableError when the source currency is missing', () => {
    const table: RateTable = { ...TABLE, perBase: { UAH: 1, EUR: 45.1 } }
    expect(() => crossRate(table, 'USD', 'UAH')).toThrow(RateUnavailableError)
  })

  it('throws RateUnavailableError when the target currency is missing', () => {
    const table: RateTable = { ...TABLE, perBase: { UAH: 1, EUR: 45.1 } }
    expect(() => crossRate(table, 'UAH', 'USD')).toThrow(RateUnavailableError)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RateUnavailableError for the unusable rate %s',
    (bad) => {
      const table: RateTable = { ...TABLE, perBase: { UAH: 1, USD: bad } }
      expect(() => crossRate(table, 'USD', 'UAH')).toThrow(RateUnavailableError)
      expect(() => crossRate(table, 'UAH', 'USD')).toThrow(RateUnavailableError)
    },
  )
})

describe('RateUnavailableError', () => {
  it('is an Error with the name RateUnavailableError', () => {
    const err = new RateUnavailableError('no rates')

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(RateUnavailableError)
    expect(err.name).toBe('RateUnavailableError')
  })
})
