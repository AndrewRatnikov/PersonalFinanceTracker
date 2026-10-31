// No CONTRACT_GAPs: categoryMatchKey is specified in the Interface Contract
// (trim, collapse inner whitespace, lowercase, strip diacritics).

import { describe, expect, it } from 'vitest'

import { categoryMatchKey } from '@/lib/spaces/categoryMatch'

describe('categoryMatchKey', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(categoryMatchKey(' Їжа ')).toBe(categoryMatchKey('їжа'))
    expect(categoryMatchKey('FOOD')).toBe(categoryMatchKey('food'))
  })

  it('ignores diacritics', () => {
    expect(categoryMatchKey('Café')).toBe(categoryMatchKey('cafe'))
  })

  it('collapses inner whitespace', () => {
    expect(categoryMatchKey('Eating   out')).toBe(categoryMatchKey('eating out'))
  })

  it('keeps different names apart', () => {
    expect(categoryMatchKey('Food')).not.toBe(categoryMatchKey('Home'))
    expect(categoryMatchKey('Їжа')).not.toBe(categoryMatchKey('Їда'))
  })

  it('does not leave uppercase or accents in the key', () => {
    expect(categoryMatchKey('  Éclair  ')).toBe('eclair')
  })
})
