// Plaintext app settings in `meta:settings` (spec §4.3), next to the
// brute-force counter that vault.ts keeps in the same object. Writes merge into
// the stored object so the counter fields are never lost.
//
// `recoveryKeyConfirmed` is false after an operation that produced a recovery
// key the user hasn't confirmed saving yet (vault.ts writes it), and true once
// RecoveryKeySaveStep is confirmed. A missing field means confirmed, so vaults
// created before the field existed don't nag. Never store the key itself.
//
// The currency settings (`mainCurrency`, `fetchExchangeRates`) are synced
// settings: they live in the encrypted `syncedSettings` record that localDb
// owns (readSyncedSettings / updateSyncedSettings), not in `meta:settings`.
// Stores not migrated yet fall back to the legacy plaintext fields inside
// localDb. `mainCurrency` is written only by localDb.convertBudgets, together
// with the converted budgets, so the budgets and the main currency can never
// disagree.

import { get, set } from 'idb-keyval'

import { isDecryptError } from './dataErrors'
import { DEFAULT_MAIN_CURRENCY } from './domain'
import { getLocalStore, readSyncedSettings, updateSyncedSettings } from './localDb'
import { dbFor } from './spaces/spaceDb'
import { PERSONAL_SPACE_ID } from './spaces/types'
import { META_SETTINGS_KEY } from './vault'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type { Currency } from './domain'
import type { OpenAppIn } from './spaces/activeSpace'
import type { SpaceOption } from './spaces/spaceDb'

export type AutoLockMinutes = 0 | 1 | 5 | 15 | 60 // 0 = Off

export const AUTO_LOCK_OPTIONS: ReadonlyArray<AutoLockMinutes> = [
  0, 1, 5, 15, 60,
]

export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 15

export const APP_SETTINGS_QUERY_KEY = ['settings'] as const

export interface AppSettings {
  // Always one of AUTO_LOCK_OPTIONS when read through getAppSettings(). Typed
  // as number so plain object literals (e.g. test fixtures) are assignable.
  autoLockMinutes: number
  installHintDismissed: boolean
  persistRequestedAt: string | null
  recoveryKeyConfirmed: boolean
}

function defaults(): AppSettings {
  return {
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    installHintDismissed: false,
    persistRequestedAt: null,
    recoveryKeyConfirmed: true,
  }
}

function isAutoLockMinutes(value: unknown): value is AutoLockMinutes {
  return AUTO_LOCK_OPTIONS.some((option) => option === value)
}

type StoredSettings = Record<string, unknown>

async function readRaw(store: UseStore): Promise<StoredSettings | null> {
  const raw = await get<unknown>(META_SETTINGS_KEY, store)
  if (!raw || typeof raw !== 'object') return null
  return raw as StoredSettings
}

export async function getAppSettings(): Promise<AppSettings> {
  const result = defaults()
  try {
    const store = getLocalStore()
    if (!store) return result
    const raw = await readRaw(store)
    if (!raw) return result
    if (isAutoLockMinutes(raw.autoLockMinutes)) {
      result.autoLockMinutes = raw.autoLockMinutes
    }
    if (typeof raw.installHintDismissed === 'boolean') {
      result.installHintDismissed = raw.installHintDismissed
    }
    if (typeof raw.persistRequestedAt === 'string') {
      result.persistRequestedAt = raw.persistRequestedAt
    }
    if (typeof raw.recoveryKeyConfirmed === 'boolean') {
      result.recoveryKeyConfirmed = raw.recoveryKeyConfirmed
    }
    return result
  } catch {
    return defaults()
  }
}

export async function updateAppSettings(
  patch: Partial<AppSettings>,
): Promise<void> {
  const store = getLocalStore()
  if (!store) return
  await withWriteLock(META_SETTINGS_KEY, async () => {
    const stored = await readRaw(store)
    await set(META_SETTINGS_KEY, { ...stored, ...patch }, store)
  })
}

// ── Open the app in (device-only, meta:settings `openAppIn`) ─────────────────
// Kept out of AppSettings on purpose: getAppSettings' shape stays unchanged.

export const OPEN_APP_IN_QUERY_KEY = ['settings', 'open-app-in'] as const

export const OPEN_APP_IN_OPTIONS: ReadonlyArray<OpenAppIn> = [
  'last',
  'personal',
  'family',
]

export const DEFAULT_OPEN_APP_IN: OpenAppIn = 'last'

function isOpenAppIn(value: unknown): value is OpenAppIn {
  return OPEN_APP_IN_OPTIONS.some((option) => option === value)
}

export async function getOpenAppIn(): Promise<OpenAppIn> {
  try {
    const store = getLocalStore()
    if (!store) return DEFAULT_OPEN_APP_IN
    const raw = await readRaw(store)
    return raw && isOpenAppIn(raw.openAppIn) ? raw.openAppIn : DEFAULT_OPEN_APP_IN
  } catch {
    return DEFAULT_OPEN_APP_IN
  }
}

export async function setOpenAppIn(value: OpenAppIn): Promise<void> {
  if (!isOpenAppIn(value)) return
  const store = getLocalStore()
  if (!store) return
  await withWriteLock(META_SETTINGS_KEY, async () => {
    const stored = await readRaw(store)
    await set(META_SETTINGS_KEY, { ...stored, openAppIn: value }, store)
  })
}

// ── Currency settings ─────────────────────────────────────────────────────────

export const DEFAULT_FETCH_EXCHANGE_RATES = true

// Under the ['settings'] prefix, so every invalidation of ['settings'] covers it.
export const CURRENCY_SETTINGS_QUERY_KEY = ['settings', 'currency'] as const

export interface CurrencySettings {
  mainCurrency: Currency
  fetchExchangeRates: boolean
}

function currencyDefaults(): CurrencySettings {
  return {
    mainCurrency: DEFAULT_MAIN_CURRENCY,
    fetchExchangeRates: DEFAULT_FETCH_EXCHANGE_RATES,
  }
}

// Reads the synced settings record (legacy fields or defaults while it does
// not exist). Throws only a DecryptError, so an unreadable record opens the
// Data problem screen instead of silently reading as UAH. Any other failure
// (also a test mocking localDb without readSyncedSettings) gives the defaults.
// `{ spaceId }` reads that space's own record (each space has its own main
// currency and rates switch); without it, personal.
export async function getCurrencySettings(
  opts?: SpaceOption,
): Promise<CurrencySettings> {
  const spaceId = opts?.spaceId ?? PERSONAL_SPACE_ID
  try {
    const record =
      spaceId === PERSONAL_SPACE_ID
        ? await readSyncedSettings()
        : await dbFor(spaceId).readSyncedSettings()
    return {
      mainCurrency: record.mainCurrency,
      fetchExchangeRates: record.fetchExchangeRates,
    }
  } catch (err) {
    if (isDecryptError(err)) throw err
    return currencyDefaults()
  }
}

// Only `fetchExchangeRates` is patchable here; the main currency changes
// through conversion.changeMainCurrency. localDb writes the record (rev +
// updatedAt) and announces `syncedSettings` after it commits.
export async function updateCurrencySettings(
  patch: { fetchExchangeRates?: boolean },
  opts?: SpaceOption,
): Promise<void> {
  const spaceId = opts?.spaceId ?? PERSONAL_SPACE_ID
  if (spaceId === PERSONAL_SPACE_ID) await updateSyncedSettings(patch)
  else await dbFor(spaceId).updateSyncedSettings(patch)
}
