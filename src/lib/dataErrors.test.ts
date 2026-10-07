// No CONTRACT_GAPs: dataErrors is fully specified in the Interface Contract.

import { describe, expect, it } from 'vitest'

import {
  DecryptError,
  isDataStorageKey,
  isDecryptError,
  storageKeyLabel,
} from '@/lib/dataErrors'

describe('DecryptError', () => {
  it('carries the storage key, name and message', () => {
    const cause = new Error('bad tag')
    const err = new DecryptError('expenses_2026_03', cause)

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('DecryptError')
    expect(err.storageKey).toBe('expenses_2026_03')
    expect(err.message).toBe('Could not decrypt local data "expenses_2026_03"')
    expect(err.cause).toBe(cause)
  })

  it('uses the key it was given', () => {
    expect(new DecryptError('income').storageKey).toBe('income')
    expect(new DecryptError('budgets').message).toContain('budgets')
  })
})

describe('isDecryptError', () => {
  it('is true for a DecryptError', () => {
    expect(isDecryptError(new DecryptError('income'))).toBe(true)
  })

  it('is true for an Error shaped like a DecryptError (other module copy)', () => {
    const err = Object.assign(new Error('x'), {
      name: 'DecryptError',
      storageKey: 'categories',
    })

    expect(isDecryptError(err)).toBe(true)
  })

  it('is false for an Error named DecryptError without a string storageKey', () => {
    const noKey = Object.assign(new Error('x'), { name: 'DecryptError' })
    const badKey = Object.assign(new Error('x'), {
      name: 'DecryptError',
      storageKey: 5,
    })

    expect(isDecryptError(noKey)).toBe(false)
    expect(isDecryptError(badKey)).toBe(false)
  })

  it('is false for other errors and non-errors', () => {
    expect(isDecryptError(new Error('boom'))).toBe(false)
    expect(isDecryptError(new TypeError('boom'))).toBe(false)
    expect(isDecryptError(null)).toBe(false)
    expect(isDecryptError(undefined)).toBe(false)
    expect(isDecryptError('DecryptError')).toBe(false)
    expect(isDecryptError({ name: 'DecryptError', storageKey: 'income' })).toBe(
      false,
    )
  })
})

describe('isDataStorageKey', () => {
  it.each(['categories', 'income', 'budgets', 'expenses_2026_03', 'expenses_1999_12'])(
    'accepts %s',
    (key) => {
      expect(isDataStorageKey(key)).toBe(true)
    },
  )

  it.each([
    'quarantine:expenses_2026_03:2026-03-01T00:00:00.000Z',
    'quarantine:categories:2026-03-01T00:00:00.000Z',
    'expenses_',
    'expenses_2026_3',
    'expenses_26_03',
    'expenses_2026_03_old',
    'xexpenses_2026_03',
    'Categories',
    'categories2',
    'minima_key_verify_u1',
    '',
  ])('rejects %s', (key) => {
    expect(isDataStorageKey(key)).toBe(false)
  })
})

describe('storageKeyLabel', () => {
  it('labels an expenses chunk with the month', () => {
    expect(storageKeyLabel('expenses_2026_03')).toBe('Expenses · 2026-03')
    expect(storageKeyLabel('expenses_2024_11')).toBe('Expenses · 2024-11')
  })

  it('labels the single-key collections', () => {
    expect(storageKeyLabel('categories')).toBe('Categories')
    expect(storageKeyLabel('income')).toBe('Income')
    expect(storageKeyLabel('budgets')).toBe('Budgets')
  })

  it('returns anything else unchanged', () => {
    expect(storageKeyLabel('something_else')).toBe('something_else')
    expect(
      storageKeyLabel('quarantine:income:2026-03-01T00:00:00.000Z'),
    ).toBe('quarantine:income:2026-03-01T00:00:00.000Z')
  })
})
