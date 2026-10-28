// CONTRACT_GAP: the English label texts come from the plan's i18n section
//   (identity 'Identity key', spaceKeys 'Family space keys', spaceInfo 'Space
//   details', memberProfiles 'Members', familySpace 'Family space', inSpace
//   '{space} · {key}'); the Ukrainian texts are only checked to differ from
//   the English ones.
//
// Pure functions over the i18n core and the in-memory keyring; no storage.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HeldSpace } from '@/lib/spaces/keyring'
import {
  DecryptError,
  isAnyDataStorageKey,
  isDataStorageKey,
  isDecryptError,
  isSpaceDataStorageKey,
  storageKeyLabel,
} from '@/lib/dataErrors'
import { setLang } from '@/i18n/core'
import { clearKeyring, setKeyring } from '@/lib/spaces/keyring'

const ID = '3f2b1c4e-0000-4000-8000-00000000aaaa'
const OTHER = '3f2b1c4e-0000-4000-8000-00000000bbbb'

const FAMILY_BASES = [
  'categories',
  'incomeCategories',
  'income',
  'budgets',
  'recurring',
  'syncedSettings',
  'spaceInfo',
  'memberProfiles',
  'expenses_2026_03',
]

async function held(id: string, name: string): Promise<HeldSpace> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return { id, name, role: 'owner', keyVersion: 1, keys: [{ keyVersion: 1, key }] }
}

beforeEach(() => {
  setLang('en', { persist: false })
  clearKeyring()
})

afterEach(() => {
  clearKeyring()
  setLang('en', { persist: false })
})

describe('isDataStorageKey', () => {
  it('now includes the personal key material records', () => {
    expect(isDataStorageKey('identity')).toBe(true)
    expect(isDataStorageKey('spaceKeys')).toBe(true)
  })

  it('still accepts every old personal key', () => {
    for (const key of [
      'categories',
      'income',
      'budgets',
      'incomeCategories',
      'recurring',
      'syncedSettings',
      'expenses_2026_03',
    ]) {
      expect(isDataStorageKey(key), key).toBe(true)
    }
  })

  it('stays personal: a space-prefixed key is not one', () => {
    expect(isDataStorageKey(`space:${ID}:categories`)).toBe(false)
    expect(isDataStorageKey(`space:${ID}:expenses_2026_03`)).toBe(false)
  })

  it('still refuses quarantine copies, headers and unknown keys', () => {
    expect(isDataStorageKey('meta:vault')).toBe(false)
    expect(isDataStorageKey('meta:sync')).toBe(false)
    expect(isDataStorageKey('quarantine:categories:2026-01-01T00:00:00.000Z')).toBe(false)
    expect(isDataStorageKey('spaceInfo')).toBe(false)
    expect(isDataStorageKey('memberProfiles')).toBe(false)
  })
})

describe('isSpaceDataStorageKey', () => {
  it.each(FAMILY_BASES)('accepts space:<id>:%s', (base) => {
    expect(isSpaceDataStorageKey(`space:${ID}:${base}`)).toBe(true)
  })

  it('refuses a personal key', () => {
    for (const base of FAMILY_BASES) expect(isSpaceDataStorageKey(base), base).toBe(false)
  })

  it('refuses meta:sync and unknown base keys of a space', () => {
    expect(isSpaceDataStorageKey(`space:${ID}:meta:sync`)).toBe(false)
    expect(isSpaceDataStorageKey(`space:${ID}:unknown`)).toBe(false)
    expect(isSpaceDataStorageKey(`space:${ID}:expenses_2026`)).toBe(false)
  })

  it('refuses key material records inside a space', () => {
    expect(isSpaceDataStorageKey(`space:${ID}:identity`)).toBe(false)
    expect(isSpaceDataStorageKey(`space:${ID}:spaceKeys`)).toBe(false)
  })

  it('refuses an invalid space id, the personal id and an empty id', () => {
    expect(isSpaceDataStorageKey('space:bad id:categories')).toBe(false)
    expect(isSpaceDataStorageKey('space:personal:categories')).toBe(false)
    expect(isSpaceDataStorageKey('space::categories')).toBe(false)
    expect(isSpaceDataStorageKey(`space:${'a'.repeat(65)}:categories`)).toBe(false)
  })

  it('refuses quarantine copies of a space key', () => {
    expect(
      isSpaceDataStorageKey(`quarantine:space:${ID}:categories:2026-01-01T00:00:00.000Z`),
    ).toBe(false)
  })
})

describe('isAnyDataStorageKey', () => {
  it('accepts personal keys and Family keys', () => {
    expect(isAnyDataStorageKey('expenses_2026_03')).toBe(true)
    expect(isAnyDataStorageKey('spaceKeys')).toBe(true)
    expect(isAnyDataStorageKey(`space:${ID}:budgets`)).toBe(true)
  })

  it('refuses everything else', () => {
    expect(isAnyDataStorageKey('meta:vault')).toBe(false)
    expect(isAnyDataStorageKey(`space:${ID}:meta:sync`)).toBe(false)
    expect(isAnyDataStorageKey('space:bad id:budgets')).toBe(false)
    expect(isAnyDataStorageKey(`quarantine:space:${ID}:budgets:x`)).toBe(false)
  })
})

describe('storageKeyLabel', () => {
  it('keeps the personal labels', () => {
    expect(storageKeyLabel('categories')).toBe('Categories')
    expect(storageKeyLabel('expenses_2026_03')).toBe('Expenses · 2026-03')
  })

  it('labels the key material records', () => {
    expect(storageKeyLabel('identity')).toBe('Identity key')
    expect(storageKeyLabel('spaceKeys')).toBe('Family space keys')
  })

  it('names the space in a Family label', async () => {
    setKeyring([await held(ID, 'Our home')])

    expect(storageKeyLabel(`space:${ID}:categories`)).toBe('Our home · Categories')
    expect(storageKeyLabel(`space:${ID}:expenses_2026_03`)).toBe(
      'Our home · Expenses · 2026-03',
    )
    expect(storageKeyLabel(`space:${ID}:spaceInfo`)).toBe('Our home · Space details')
    expect(storageKeyLabel(`space:${ID}:memberProfiles`)).toBe('Our home · Members')
  })

  it('uses the name of the right space', async () => {
    setKeyring([await held(ID, 'Our home'), await held(OTHER, 'Cabin')])

    expect(storageKeyLabel(`space:${ID}:income`)).toContain('Our home')
    expect(storageKeyLabel(`space:${OTHER}:income`)).toContain('Cabin')
    expect(storageKeyLabel(`space:${OTHER}:income`)).not.toContain('Our home')
  })

  it('falls back to "Family space" when the space is not held', () => {
    expect(storageKeyLabel(`space:${ID}:budgets`)).toBe('Family space · Budgets')
  })

  it('the label of a Family key differs from the personal one of the same base', async () => {
    setKeyring([await held(ID, 'Home')])

    expect(storageKeyLabel(`space:${ID}:budgets`)).not.toBe(storageKeyLabel('budgets'))
  })

  it('follows the UI language', async () => {
    setKeyring([await held(ID, 'Home')])
    const english = storageKeyLabel(`space:${ID}:categories`)
    const englishKeys = storageKeyLabel('spaceKeys')

    setLang('uk', { persist: false })

    expect(storageKeyLabel(`space:${ID}:categories`)).not.toBe(english)
    expect(storageKeyLabel(`space:${ID}:categories`)).toContain('Home')
    expect(storageKeyLabel('spaceKeys')).not.toBe(englishKeys)
  })

  it('returns an unknown key as it is', () => {
    expect(storageKeyLabel('something-else')).toBe('something-else')
  })
})

describe('DecryptError for a Family key', () => {
  it('carries the prefixed storage key and is recognised', () => {
    const err = new DecryptError(`space:${ID}:expenses_2026_03`)

    expect(isDecryptError(err)).toBe(true)
    expect(err.storageKey).toBe(`space:${ID}:expenses_2026_03`)
    expect(isAnyDataStorageKey(err.storageKey)).toBe(true)
  })
})
