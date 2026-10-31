// No CONTRACT_GAPs: resolveStartSpace and isShortcutUrl are specified in the
// plan (Approach section 2) and the Interface Contract (activeSpace.ts).

import { describe, expect, it } from 'vitest'

import { isShortcutUrl, resolveStartSpace } from '@/lib/spaces/activeSpace'

const FAM = 'fam-1'

describe('resolveStartSpace', () => {
  it('is personal whenever no Family is held', () => {
    for (const openIn of ['last', 'personal', 'family'] as const) {
      expect(resolveStartSpace({ openIn, lastUsed: 'personal', familyId: null, shortcut: false })).toBe('personal')
    }
    expect(resolveStartSpace({ openIn: 'family', lastUsed: FAM, familyId: null, shortcut: true })).toBe('personal')
  })

  it('last used: the stored space if it is the Family, else personal', () => {
    expect(resolveStartSpace({ openIn: 'last', lastUsed: FAM, familyId: FAM, shortcut: false })).toBe(FAM)
    expect(resolveStartSpace({ openIn: 'last', lastUsed: 'personal', familyId: FAM, shortcut: false })).toBe('personal')
    expect(resolveStartSpace({ openIn: 'last', lastUsed: 'gone-space', familyId: FAM, shortcut: false })).toBe('personal')
  })

  it('"family" opens the Family whatever was used last', () => {
    expect(resolveStartSpace({ openIn: 'family', lastUsed: 'personal', familyId: FAM, shortcut: false })).toBe(FAM)
  })

  it('"personal" opens personal whatever was used last', () => {
    expect(resolveStartSpace({ openIn: 'personal', lastUsed: FAM, familyId: FAM, shortcut: false })).toBe('personal')
  })

  it('the shortcut always follows the last used space', () => {
    expect(resolveStartSpace({ openIn: 'personal', lastUsed: FAM, familyId: FAM, shortcut: true })).toBe(FAM)
    expect(resolveStartSpace({ openIn: 'family', lastUsed: 'personal', familyId: FAM, shortcut: true })).toBe('personal')
  })
})

describe('isShortcutUrl', () => {
  it('is true for /transactions?add=expense', () => {
    expect(isShortcutUrl('/transactions', '?add=expense')).toBe(true)
  })

  it('is false with an explicit space param', () => {
    expect(isShortcutUrl('/transactions', '?add=expense&space=family')).toBe(false)
    expect(isShortcutUrl('/transactions', '?space=personal&add=expense')).toBe(false)
  })

  it('is false for other paths or without add=expense', () => {
    expect(isShortcutUrl('/income', '?add=expense')).toBe(false)
    expect(isShortcutUrl('/transactions', '')).toBe(false)
    expect(isShortcutUrl('/transactions', '?edit=e1')).toBe(false)
    expect(isShortcutUrl('/', '')).toBe(false)
  })
})
