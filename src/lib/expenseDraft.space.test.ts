// No CONTRACT_GAPs: the `space` search param is specified in the Interface
// Contract (expenseDraft.ts): kept only together with add=expense.

import { describe, expect, it } from 'vitest'

import { drawerInitialFromSearch, validateTransactionsSearch } from '@/lib/expenseDraft'

describe('validateTransactionsSearch: space', () => {
  it('keeps family and personal together with add=expense', () => {
    expect(validateTransactionsSearch({ add: 'expense', space: 'family' })).toMatchObject({
      add: 'expense',
      space: 'family',
    })
    expect(validateTransactionsSearch({ add: 'expense', space: 'personal' })).toMatchObject({
      add: 'expense',
      space: 'personal',
    })
  })

  it('drops space without add=expense', () => {
    expect('space' in validateTransactionsSearch({ space: 'family' })).toBe(false)
    expect('space' in validateTransactionsSearch({ edit: 'e1', space: 'family' })).toBe(false)
  })

  it('drops any other value', () => {
    expect('space' in validateTransactionsSearch({ add: 'expense', space: 'fam-1' })).toBe(false)
    expect('space' in validateTransactionsSearch({ add: 'expense', space: 7 })).toBe(false)
    expect('space' in validateTransactionsSearch({ add: 'expense', space: '' })).toBe(false)
  })

  it('does not disturb the other params', () => {
    expect(
      validateTransactionsSearch({ add: 'expense', space: 'family', category: 'cat-food', amount: 12.5 }),
    ).toMatchObject({ add: 'expense', category: 'cat-food', amount: '12.5' })
  })
})

describe('drawerInitialFromSearch: space', () => {
  it('ignores the space param', () => {
    const withSpace = drawerInitialFromSearch({ add: 'expense', space: 'family', category: 'cat-food' })
    const without = drawerInitialFromSearch({ add: 'expense', category: 'cat-food' })

    expect(withSpace).toEqual(without)
    expect(JSON.stringify(withSpace)).not.toContain('family')
  })
})
