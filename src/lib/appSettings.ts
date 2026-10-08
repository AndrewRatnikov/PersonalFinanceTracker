// Plaintext app settings in `meta:settings` (spec §4.3), next to the
// brute-force counter that vault.ts keeps in the same object. Writes merge into
// the stored object so the counter fields are never lost.

import { get, set } from 'idb-keyval'

import { getLocalStore } from './localDb'
import { META_SETTINGS_KEY } from './vault'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'

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
}

function defaults(): AppSettings {
  return {
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    installHintDismissed: false,
    persistRequestedAt: null,
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
