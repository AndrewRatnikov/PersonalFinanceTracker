// A stable per-device id for the sync server, kept in localStorage, plus a
// default device label ("Chrome on Android"). "Remove data" clears every
// minima_* key (localWipe.ts), so the id goes with it.

import { MAX_DEVICE_LABEL_CHARS } from './types'
import { t } from '@/i18n/core'

export const DEVICE_ID_STORAGE_KEY = 'minima_device_id'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Used for the life of the page when localStorage is unavailable.
let memoryId: string | null = null

function fallbackId(): string {
  memoryId ??= crypto.randomUUID()
  return memoryId
}

export function getDeviceId(): string {
  try {
    if (typeof localStorage === 'undefined') return fallbackId()
    const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    if (stored !== null && UUID_RE.test(stored)) return stored
    const id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id)
    return id
  } catch {
    return fallbackId()
  }
}

// First match wins: Edge, Opera and Samsung Internet also say "Chrome", and
// Chrome also says "Safari".
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/FxiOS|Firefox\//, 'Firefox'],
  [/CriOS|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

// iPhone and iPad say "Mac OS X", and Android says "Linux", so they go first.
const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
]

function firstMatch(
  userAgent: string,
  rules: ReadonlyArray<[RegExp, string]>,
): string | null {
  for (const [pattern, name] of rules) {
    if (pattern.test(userAgent)) return name
  }
  return null
}

export function defaultDeviceLabel(
  userAgent: string = typeof navigator === 'undefined'
    ? ''
    : navigator.userAgent,
): string {
  const browser =
    firstMatch(userAgent, BROWSERS) ?? t('cloud.device.unknownBrowser')
  const platform =
    firstMatch(userAgent, PLATFORMS) ?? t('cloud.device.unknownPlatform')
  return t('cloud.device.defaultLabel', { browser, platform })
    .trim()
    .slice(0, MAX_DEVICE_LABEL_CHARS)
}
