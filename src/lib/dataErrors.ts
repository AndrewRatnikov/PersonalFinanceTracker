// Errors and key helpers for the encrypted local store. This module depends
// only on the i18n core and the in-memory space keyring, so UI code can use it
// without pulling in localDb.

import { t } from '../i18n/core'
import { getHeldSpace } from './spaces/keyring'
import type { MessageKey } from '../i18n/core'

export class DecryptError extends Error {
  readonly storageKey: string
  constructor(storageKey: string, cause?: unknown) {
    super(`Could not decrypt local data "${storageKey}"`, { cause })
    this.name = 'DecryptError'
    this.storageKey = storageKey
  }
}

export function isDecryptError(err: unknown): err is DecryptError {
  if (err instanceof DecryptError) return true
  return (
    err instanceof Error &&
    err.name === 'DecryptError' &&
    typeof (err as { storageKey?: unknown }).storageKey === 'string'
  )
}

const EXPENSE_CHUNK_RE = /^expenses_(\d{4})_(\d{2})$/

const SINGLE_KEY_LABELS: Record<string, MessageKey> = {
  categories: 'common.storageKeys.categories',
  income: 'common.storageKeys.income',
  budgets: 'common.storageKeys.budgets',
  incomeCategories: 'common.storageKeys.incomeCategories',
  recurring: 'common.storageKeys.recurring',
  syncedSettings: 'common.storageKeys.syncedSettings',
}

// Personal-only records holding key material (encrypted with the DEK).
const PERSONAL_ONLY_LABELS: Record<string, MessageKey> = {
  identity: 'common.storageKeys.identity',
  spaceKeys: 'common.storageKeys.spaceKeys',
}

// Family-only records (encrypted with the space key).
const FAMILY_ONLY_LABELS: Record<string, MessageKey> = {
  spaceInfo: 'common.storageKeys.spaceInfo',
  memberProfiles: 'common.storageKeys.memberProfiles',
}

const has = (map: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key)

// `space:<id>:<rest>` with a valid Family id (see spaces/types.ts; repeated
// here so this module keeps depending only on the i18n core).
const SPACE_KEY_RE = /^space:([A-Za-z0-9-]{1,64}):(.+)$/

function splitSpaceKey(key: string): { spaceId: string; baseKey: string } | null {
  const match = SPACE_KEY_RE.exec(key)
  if (!match || match[1] === 'personal') return null
  return { spaceId: match[1], baseKey: match[2] }
}

// True for the keys that hold personal user data in the current (v1) format,
// including the personal key material records `identity` and `spaceKeys`.
// Quarantine copies (`quarantine:<key>:<ISO>`), Family keys and anything else
// are not.
export function isDataStorageKey(key: string): boolean {
  return (
    has(SINGLE_KEY_LABELS, key) ||
    has(PERSONAL_ONLY_LABELS, key) ||
    EXPENSE_CHUNK_RE.test(key)
  )
}

function isFamilyBaseKey(baseKey: string): boolean {
  return (
    has(SINGLE_KEY_LABELS, baseKey) ||
    has(FAMILY_ONLY_LABELS, baseKey) ||
    EXPENSE_CHUNK_RE.test(baseKey)
  )
}

// True for `space:<id>:<key>` where <key> is a Family data key (the personal
// data keys plus spaceInfo / memberProfiles; never meta:sync or key material).
export function isSpaceDataStorageKey(key: string): boolean {
  const parts = splitSpaceKey(key)
  return parts !== null && isFamilyBaseKey(parts.baseKey)
}

export function isAnyDataStorageKey(key: string): boolean {
  return isDataStorageKey(key) || isSpaceDataStorageKey(key)
}

function baseKeyLabel(key: string): string | null {
  const match = EXPENSE_CHUNK_RE.exec(key)
  if (match) {
    return t('common.storageKeys.expensesMonth', { month: `${match[1]}-${match[2]}` })
  }
  if (has(SINGLE_KEY_LABELS, key)) return t(SINGLE_KEY_LABELS[key])
  return null
}

// 'expenses_2026_03' -> 'Expenses · 2026-03', 'categories' -> 'Categories', ...
// A Family key names its space: 'Our home · Categories'.
// (in the UI language; the YYYY-MM month stays a machine format)
export function storageKeyLabel(key: string): string {
  const parts = splitSpaceKey(key)
  if (parts && isFamilyBaseKey(parts.baseKey)) {
    const label =
      baseKeyLabel(parts.baseKey) ?? t(FAMILY_ONLY_LABELS[parts.baseKey])
    const space =
      getHeldSpace(parts.spaceId)?.name ?? t('common.storageKeys.familySpace')
    return t('common.storageKeys.inSpace', { space, key: label })
  }
  const label = baseKeyLabel(key)
  if (label !== null) return label
  if (has(PERSONAL_ONLY_LABELS, key)) return t(PERSONAL_ONLY_LABELS[key])
  return key
}
