// Backup reminder (spec §6.2): settings in the plaintext `meta:settings`
// object, next to the app settings and the brute-force counter, plus the pure
// rule for the Dashboard banner. Writes merge into the stored object so no
// other field is ever lost.

import { get, set } from 'idb-keyval'

import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getLocalStore,
} from './localDb'
import { META_SETTINGS_KEY } from './vault'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'

export type BackupReminderDays = 0 | 7 | 14 | 30 // 0 = Off

export const BACKUP_REMINDER_OPTIONS: ReadonlyArray<BackupReminderDays> = [
  7, 14, 30, 0,
]

export const DEFAULT_BACKUP_REMINDER_DAYS: BackupReminderDays = 14

export const BACKUP_SNOOZE_DAYS = 3

export const BACKUP_REMINDER_MIN_RECORDS = 10

export const BACKUP_REMINDER_QUERY_KEY = ['backup-reminder'] as const

export const BACKUP_SETTINGS_QUERY_KEY = ['backup-settings'] as const

export interface BackupSettings {
  // Always one of BACKUP_REMINDER_OPTIONS when read through
  // getBackupSettings(). Typed as number so plain object literals fit.
  backupReminderDays: number
  lastBackupAt: string | null
  lastDataChangeAt: string | null
  backupReminderSnoozedUntil: string | null
}

export interface BackupReminderStatus {
  show: boolean
  daysSinceBackup: number | null
}

const DAY_MS = 86_400_000

function defaults(): BackupSettings {
  return {
    backupReminderDays: DEFAULT_BACKUP_REMINDER_DAYS,
    lastBackupAt: null,
    lastDataChangeAt: null,
    backupReminderSnoozedUntil: null,
  }
}

function isReminderDays(value: unknown): value is BackupReminderDays {
  return BACKUP_REMINDER_OPTIONS.some((option) => option === value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

type StoredSettings = Record<string, unknown>

async function readRaw(store: UseStore): Promise<StoredSettings | null> {
  const raw = await get<unknown>(META_SETTINGS_KEY, store)
  if (!raw || typeof raw !== 'object') return null
  return raw as StoredSettings
}

// Never throws: any failure reads as the defaults.
export async function getBackupSettings(): Promise<BackupSettings> {
  const result = defaults()
  try {
    const store = getLocalStore()
    if (!store) return result
    const raw = await readRaw(store)
    if (!raw) return result
    if (isReminderDays(raw.backupReminderDays)) {
      result.backupReminderDays = raw.backupReminderDays
    }
    result.lastBackupAt = stringOrNull(raw.lastBackupAt)
    result.lastDataChangeAt = stringOrNull(raw.lastDataChangeAt)
    result.backupReminderSnoozedUntil = stringOrNull(
      raw.backupReminderSnoozedUntil,
    )
    return result
  } catch {
    return defaults()
  }
}

export async function updateBackupSettings(
  patch: Partial<BackupSettings>,
): Promise<void> {
  const store = getLocalStore()
  if (!store) return
  await withWriteLock(META_SETTINGS_KEY, async () => {
    const stored = await readRaw(store)
    await set(META_SETTINGS_KEY, { ...stored, ...patch }, store)
  })
}

// A completed .minima download: records the time and ends any snooze.
export async function recordBackupCompleted(now = new Date()): Promise<void> {
  await updateBackupSettings({
    lastBackupAt: now.toISOString(),
    backupReminderSnoozedUntil: null,
  })
}

// "Later": hides the banner for BACKUP_SNOOZE_DAYS.
export async function snoozeBackupReminder(now = new Date()): Promise<void> {
  await updateBackupSettings({
    backupReminderSnoozedUntil: new Date(
      now.getTime() + BACKUP_SNOOZE_DAYS * DAY_MS,
    ).toISOString(),
  })
}

export function daysSinceBackup(
  lastBackupAt: string | null,
  now: Date,
): number | null {
  if (lastBackupAt === null) return null
  const last = Date.parse(lastBackupAt)
  if (Number.isNaN(last)) return null
  return Math.floor((now.getTime() - last) / DAY_MS)
}

// Every condition except the record count (which needs reading the vault).
function conditionsWithoutCount(settings: BackupSettings, now: Date): boolean {
  if (settings.backupReminderDays === 0) return false

  if (settings.lastDataChangeAt === null) return false
  const changed = Date.parse(settings.lastDataChangeAt)
  if (Number.isNaN(changed)) return false

  if (settings.lastBackupAt !== null) {
    const backedUp = Date.parse(settings.lastBackupAt)
    if (!Number.isNaN(backedUp)) {
      if (changed <= backedUp) return false
      if (now.getTime() - backedUp < settings.backupReminderDays * DAY_MS) {
        return false
      }
    }
  }

  if (settings.backupReminderSnoozedUntil !== null) {
    const until = Date.parse(settings.backupReminderSnoozedUntil)
    if (!Number.isNaN(until) && now.getTime() < until) return false
  }

  return true
}

// The Dashboard banner rule (§6.2): reminders on, data changed since the last
// backup (or never backed up), the frequency has elapsed, at least 10 records,
// and no active snooze.
export function shouldShowBackupReminder({
  settings,
  recordCount,
  now,
}: {
  settings: BackupSettings
  recordCount: number
  now: Date
}): boolean {
  return (
    conditionsWithoutCount(settings, now) &&
    recordCount >= BACKUP_REMINDER_MIN_RECORDS
  )
}

export async function countVaultRecords(): Promise<number> {
  const [expenses, income, categories, budgets] = await Promise.all([
    getAllExpenses(),
    getAllIncome(),
    getAllCategories(),
    getAllBudgets(),
  ])
  return expenses.length + income.length + categories.length + budgets.length
}

export async function getBackupReminderStatus(
  now = new Date(),
): Promise<BackupReminderStatus> {
  const settings = await getBackupSettings()
  const days = daysSinceBackup(settings.lastBackupAt, now)
  // Skip reading every chunk when the banner can't show anyway.
  if (!conditionsWithoutCount(settings, now)) {
    return { show: false, daysSinceBackup: days }
  }
  const recordCount = await countVaultRecords()
  return {
    show: shouldShowBackupReminder({ settings, recordCount, now }),
    daysSinceBackup: days,
  }
}

export function backupReminderText(daysSince: number | null): string {
  if (daysSince === null) return 'No backup yet.'
  return `Last backup: ${daysSince} days ago.`
}
