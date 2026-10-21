// Durable storage (spec §6.1): ask the browser not to evict our IndexedDB, and
// report whether it agreed. Every function here is best-effort and never
// throws; the API is missing in some browsers.

import { t } from '../i18n/core'
import { formatNumber } from '../i18n/format'
import { updateAppSettings } from './appSettings'

export interface StorageStatus {
  persisted: boolean
  usage: number | null
  quota: number | null
}

function storageManager(): Partial<StorageManager> | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as { storage?: Partial<StorageManager> }).storage
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = storageManager()
    if (!storage?.persist) return false
    const granted = await storage.persist()
    await updateAppSettings({ persistRequestedAt: new Date().toISOString() })
    return granted
  } catch {
    return false
  }
}

export async function ensurePersistentStorage(): Promise<void> {
  try {
    const storage = storageManager()
    if (storage?.persisted && (await storage.persisted())) return
    await requestPersistentStorage()
  } catch {
    // Best-effort only.
  }
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const status: StorageStatus = { persisted: false, usage: null, quota: null }
  const storage = storageManager()
  if (!storage) return status
  try {
    if (storage.persisted) status.persisted = await storage.persisted()
  } catch {
    status.persisted = false
  }
  try {
    if (storage.estimate) {
      const estimate = await storage.estimate()
      status.usage = typeof estimate.usage === 'number' ? estimate.usage : null
      status.quota = typeof estimate.quota === 'number' ? estimate.quota : null
    }
  } catch {
    status.usage = null
    status.quota = null
  }
  return status
}

const UNITS = ['common.bytes.kb', 'common.bytes.mb', 'common.bytes.gb'] as const

// "512 B", "1.5 KB" (en) / "512 Б", "1,5 КБ" (uk)
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${t('common.bytes.b')}`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const number = formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `${number} ${t(UNITS[unit])}`
}
