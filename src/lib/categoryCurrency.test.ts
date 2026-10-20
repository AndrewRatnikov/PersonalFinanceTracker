// No CONTRACT_GAPs: categoryDefaultCurrency / currencyForCategory are fully
// specified in the Interface Contract (module: categoryCurrency).

import { describe, expect, it } from 'vitest'

import type { Category } from '@/lib/domain'
import {
  categoryDefaultCurrency,
  currencyForCategory,
} from '@/lib/categoryCurrency'

const food: Category = { id: 'cat-food', name: 'Food', icon: '🍔' }
const server: Category = {
  id: 'cat-server',
  name: 'Server Costs',
  icon: '🖥️',
  defaultCurrency: 'USD',
}
const euro: Category = { id: 'cat-euro', name: 'Euro', defaultCurrency: 'EUR' }

// A restored backup could hold anything in this field.
const junk = { defaultCurrency: 'GBP' } as unknown as Category

describe('categoryDefaultCurrency', () => {
  it('returns the stored default currency', () => {
    expect(categoryDefaultCurrency(server)).toBe('USD')
    expect(categoryDefaultCurrency(euro)).toBe('EUR')
  })

  it('returns undefined when the category has none', () => {
    expect(categoryDefaultCurrency(food)).toBeUndefined()
  })

  it('returns undefined for a missing category', () => {
    expect(categoryDefaultCurrency(undefined)).toBeUndefined()
    expect(categoryDefaultCurrency(null)).toBeUndefined()
  })

  it('ignores a value that is not a known currency', () => {
    expect(categoryDefaultCurrency(junk)).toBeUndefined()
    expect(
      categoryDefaultCurrency({ defaultCurrency: null } as unknown as Category),
    ).toBeUndefined()
  })
})

describe('currencyForCategory', () => {
  it('prefers the category default over the main currency', () => {
    expect(currencyForCategory(server, 'UAH')).toBe('USD')
    expect(currencyForCategory(euro, 'UAH')).toBe('EUR')
  })

  it('falls back to the main currency, whichever it is', () => {
    expect(currencyForCategory(food, 'UAH')).toBe('UAH')
    expect(currencyForCategory(food, 'EUR')).toBe('EUR')
  })

  it('falls back to the main currency for a missing category or junk', () => {
    expect(currencyForCategory(undefined, 'USD')).toBe('USD')
    expect(currencyForCategory(null, 'EUR')).toBe('EUR')
    expect(currencyForCategory(junk, 'UAH')).toBe('UAH')
  })

  it('the default wins even when it equals a different main currency', () => {
    expect(currencyForCategory(server, 'USD')).toBe('USD')
    expect(currencyForCategory(server, 'EUR')).toBe('USD')
  })
})
