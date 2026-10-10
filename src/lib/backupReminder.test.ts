// No CONTRACT_GAPs: backupReminder exports, rule and dependencies are fully
// specified in the Interface Contract (module: backupReminder).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupSettings } from '@/lib/backupReminder'
import {
  BACKUP_REMINDER_MIN_RECORDS,
  BACKUP_REMINDER_OPTIONS,
  BACKUP_REMINDER_QUERY_KEY,
  BACKUP_SETTINGS_QUERY_KEY,
  BACKUP_SNOOZE_DAYS,
  DEFAULT_BACKUP_REMINDER_DAYS,
  backupReminderText,
  countVaultRecords,
  daysSinceBackup,
  getBackupReminderStatus,
  getBackupSettings,
  recordBackupCompleted,
  shouldShowBackupReminder,
  snoozeBackupReminder,
  updateBackupSettings,
} from '@/lib/backupReminder'

const {
  mockStore,
  getLocalStore,
  getAllExpenses,
  getAllIncome,
  getAllCategories,
  getAllBudgets,
  idbGet,
  idbSet,
} = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  return {
    mockStore: store,
    getLocalStore: vi.fn(),
    getAllExpenses: vi.fn(),
    getAllIncome: vi.fn(),
    getAllCategories: vi.fn(),
    getAllBudgets: vi.fn(),
    idbGet: vi.fn((key: string) => Promise.resolve(store.get(key))),
    idbSet: vi.fn((key: string, value: unknown) => {
      store.set(key, value)
      return Promise.resolve()
    }),
  }
})

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: idbGet,
  set: idbSet,
}))

vi.mock('@/lib/localDb', () => ({
  getLocalStore,
  getAllExpenses,
  getAllIncome,
  getAllCategories,
  getAllBudgets,
}))

vi.mock('@/lib/vault', () => ({ META_SETTINGS_KEY: 'meta:settings' }))

const DAY = 86_400_000

const DEFAULTS: BackupSettings = {
  backupReminderDays: 14,
  lastBackupAt: null,
  lastDataChangeAt: null,
  backupReminderSnoozedUntil: null,
}

// A state in which the banner shows: 19 days since the last backup, data
// changed after it, 14-day frequency, 10 records, no snooze.
const NOW = new Date('2026-01-20T12:00:00.000Z')
const DUE: BackupSettings = {
  backupReminderDays: 14,
  lastBackupAt: '2026-01-01T12:00:00.000Z',
  lastDataChangeAt: '2026-01-05T12:00:00.000Z',
  backupReminderSnoozedUntil: null,
}

function show(
  patch: Partial<BackupSettings> = {},
  recordCount = 10,
  now: Date = NOW,
) {
  return shouldShowBackupReminder({
    settings: { ...DUE, ...patch },
    recordCount,
    now,
  })
}

function fillCounts(
  e: number,
  i: number,
  c: number,
  b: number,
) {
  getAllExpenses.mockResolvedValue(Array.from({ length: e }, () => ({})))
  getAllIncome.mockResolvedValue(Array.from({ length: i }, () => ({})))
  getAllCategories.mockResolvedValue(Array.from({ length: c }, () => ({})))
  getAllBudgets.mockResolvedValue(Array.from({ length: b }, () => ({})))
}

beforeEach(() => {
  mockStore.clear()
  idbGet.mockClear()
  idbSet.mockClear()
  getLocalStore.mockReset().mockReturnValue('mock-store')
  getAllExpenses.mockReset().mockResolvedValue([])
  getAllIncome.mockReset().mockResolvedValue([])
  getAllCategories.mockReset().mockResolvedValue([])
  getAllBudgets.mockReset().mockResolvedValue([])
})

describe('backupReminder constants', () => {
  it('lists the frequency options, defaults and keys', () => {
    expect([...BACKUP_REMINDER_OPTIONS]).toEqual([7, 14, 30, 0])
    expect(DEFAULT_BACKUP_REMINDER_DAYS).toBe(14)
    expect(BACKUP_SNOOZE_DAYS).toBe(3)
    expect(BACKUP_REMINDER_MIN_RECORDS).toBe(10)
    expect([...BACKUP_REMINDER_QUERY_KEY]).toEqual(['backup-reminder'])
    expect([...BACKUP_SETTINGS_QUERY_KEY]).toEqual(['backup-settings'])
  })
})

describe('getBackupSettings', () => {
  it('returns the defaults for an empty store', async () => {
    expect(await getBackupSettings()).toEqual(DEFAULTS)
  })

  it('returns stored valid values', async () => {
    mockStore.set('meta:settings', {
      backupReminderDays: 30,
      lastBackupAt: '2026-01-01T00:00:00.000Z',
      lastDataChangeAt: '2026-01-02T00:00:00.000Z',
      backupReminderSnoozedUntil: '2026-01-03T00:00:00.000Z',
    })

    expect(await getBackupSettings()).toEqual({
      backupReminderDays: 30,
      lastBackupAt: '2026-01-01T00:00:00.000Z',
      lastDataChangeAt: '2026-01-02T00:00:00.000Z',
      backupReminderSnoozedUntil: '2026-01-03T00:00:00.000Z',
    })
  })

  it('accepts 0 (Off) and each listed option', async () => {
    for (const days of [0, 7, 14, 30]) {
      mockStore.set('meta:settings', { backupReminderDays: days })
      expect((await getBackupSettings()).backupReminderDays).toBe(days)
    }
  })

  it('falls back to 14 for a frequency outside the options', async () => {
    mockStore.set('meta:settings', { backupReminderDays: 10 })

    expect((await getBackupSettings()).backupReminderDays).toBe(14)
  })

  it('reads non-string timestamps as null', async () => {
    mockStore.set('meta:settings', {
      backupReminderDays: '7',
      lastBackupAt: 123,
      lastDataChangeAt: true,
      backupReminderSnoozedUntil: {},
    })

    expect(await getBackupSettings()).toEqual(DEFAULTS)
  })

  it('returns the defaults without a store', async () => {
    getLocalStore.mockReturnValue(null)
    mockStore.set('meta:settings', { backupReminderDays: 7 })

    expect(await getBackupSettings()).toEqual(DEFAULTS)
  })

  it('never throws: returns the defaults when the read rejects', async () => {
    idbGet.mockRejectedValueOnce(new Error('idb broke'))

    expect(await getBackupSettings()).toEqual(DEFAULTS)
  })
})

describe('updateBackupSettings', () => {
  it('writes a patch that getBackupSettings reads back', async () => {
    await updateBackupSettings({ backupReminderDays: 7 })
    expect((await getBackupSettings()).backupReminderDays).toBe(7)

    await updateBackupSettings({ backupReminderDays: 0 })
    expect((await getBackupSettings()).backupReminderDays).toBe(0)
  })

  it('merges the patch with the stored backup settings', async () => {
    await updateBackupSettings({ lastBackupAt: '2026-01-01T00:00:00.000Z' })
    await updateBackupSettings({ lastDataChangeAt: '2026-01-02T00:00:00.000Z' })

    expect(await getBackupSettings()).toEqual({
      ...DEFAULTS,
      lastBackupAt: '2026-01-01T00:00:00.000Z',
      lastDataChangeAt: '2026-01-02T00:00:00.000Z',
    })
  })

  it('keeps autoLockMinutes and the brute-force counter', async () => {
    mockStore.set('meta:settings', {
      autoLockMinutes: 5,
      failedUnlockAttempts: 4,
      unlockBlockedUntil: '2030-01-01T00:00:00.000Z',
    })

    await updateBackupSettings({ backupReminderDays: 30 })

    expect(mockStore.get('meta:settings')).toEqual({
      autoLockMinutes: 5,
      failedUnlockAttempts: 4,
      unlockBlockedUntil: '2030-01-01T00:00:00.000Z',
      backupReminderDays: 30,
    })
  })
})

describe('recordBackupCompleted', () => {
  it('sets lastBackupAt to the given time and clears the snooze', async () => {
    mockStore.set('meta:settings', {
      backupReminderSnoozedUntil: '2030-01-01T00:00:00.000Z',
      autoLockMinutes: 5,
    })

    await recordBackupCompleted(new Date('2026-02-03T04:05:06.000Z'))

    const settings = await getBackupSettings()
    expect(settings.lastBackupAt).toBe('2026-02-03T04:05:06.000Z')
    expect(settings.backupReminderSnoozedUntil).toBeNull()
    expect(
      (mockStore.get('meta:settings') as { autoLockMinutes: number })
        .autoLockMinutes,
    ).toBe(5)
  })

  it('uses a different time for a different argument', async () => {
    await recordBackupCompleted(new Date('2026-02-03T04:05:06.000Z'))
    await recordBackupCompleted(new Date('2026-03-09T10:00:00.000Z'))

    expect((await getBackupSettings()).lastBackupAt).toBe(
      '2026-03-09T10:00:00.000Z',
    )
  })

  it('defaults to the current time', async () => {
    const before = Date.now()
    await recordBackupCompleted()
    const after = Date.now()

    const stamp = Date.parse((await getBackupSettings()).lastBackupAt ?? '')
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(after)
  })
})

describe('snoozeBackupReminder', () => {
  it('snoozes for 3 days from the given time', async () => {
    await snoozeBackupReminder(new Date('2026-02-03T04:05:06.000Z'))

    expect((await getBackupSettings()).backupReminderSnoozedUntil).toBe(
      '2026-02-06T04:05:06.000Z',
    )
  })

  it('moves with the given time', async () => {
    await snoozeBackupReminder(new Date('2026-02-03T04:05:06.000Z'))
    await snoozeBackupReminder(new Date('2026-05-01T00:00:00.000Z'))

    expect((await getBackupSettings()).backupReminderSnoozedUntil).toBe(
      '2026-05-04T00:00:00.000Z',
    )
  })

  it('does not touch lastBackupAt or lastDataChangeAt', async () => {
    mockStore.set('meta:settings', {
      lastBackupAt: '2026-01-01T00:00:00.000Z',
      lastDataChangeAt: '2026-01-02T00:00:00.000Z',
    })

    await snoozeBackupReminder(new Date('2026-02-03T04:05:06.000Z'))

    const s = await getBackupSettings()
    expect(s.lastBackupAt).toBe('2026-01-01T00:00:00.000Z')
    expect(s.lastDataChangeAt).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('daysSinceBackup', () => {
  it('is null when there was never a backup', () => {
    expect(daysSinceBackup(null, NOW)).toBeNull()
  })

  it('counts whole elapsed days, rounded down', () => {
    expect(daysSinceBackup('2026-01-19T12:00:00.000Z', NOW)).toBe(1)
    expect(daysSinceBackup('2026-01-01T12:00:00.000Z', NOW)).toBe(19)
    expect(daysSinceBackup('2026-01-01T13:00:00.000Z', NOW)).toBe(18)
    expect(daysSinceBackup(NOW.toISOString(), NOW)).toBe(0)
  })
})

describe('shouldShowBackupReminder', () => {
  it('shows when every condition holds', () => {
    expect(show()).toBe(true)
  })

  it('hides when the reminder is off, whatever else holds', () => {
    expect(show({ backupReminderDays: 0 })).toBe(false)
  })

  it('hides when no data change has been recorded', () => {
    expect(show({ lastDataChangeAt: null })).toBe(false)
    expect(show({ lastDataChangeAt: null, lastBackupAt: null })).toBe(false)
  })

  it('hides when the data has not changed since the last backup', () => {
    expect(show({ lastDataChangeAt: '2026-01-01T11:00:00.000Z' })).toBe(false)
    expect(show({ lastDataChangeAt: DUE.lastBackupAt })).toBe(false)
    expect(show({ lastDataChangeAt: '2026-01-01T12:00:00.001Z' })).toBe(true)
  })

  it('shows for a never-backed-up vault once data changed', () => {
    expect(show({ lastBackupAt: null })).toBe(true)
  })

  it('waits until the frequency has elapsed since the last backup', () => {
    const justUnder = new Date(
      Date.parse(DUE.lastBackupAt ?? '') + 14 * DAY - 1,
    )
    const exactly = new Date(Date.parse(DUE.lastBackupAt ?? '') + 14 * DAY)

    expect(show({}, 10, justUnder)).toBe(false)
    expect(show({}, 10, exactly)).toBe(true)
  })

  it('uses the configured frequency', () => {
    // 19 days since the backup.
    expect(show({ backupReminderDays: 7 })).toBe(true)
    expect(show({ backupReminderDays: 14 })).toBe(true)
    expect(show({ backupReminderDays: 30 })).toBe(false)
  })

  it('needs at least 10 records', () => {
    expect(show({}, 9)).toBe(false)
    expect(show({}, 10)).toBe(true)
    expect(show({}, 250)).toBe(true)
    expect(show({}, 0)).toBe(false)
  })

  it('hides while a snooze is active and returns once it has passed', () => {
    const until = new Date(NOW.getTime() + 1).toISOString()
    expect(show({ backupReminderSnoozedUntil: until })).toBe(false)
    expect(show({ backupReminderSnoozedUntil: NOW.toISOString() })).toBe(true)
    expect(
      show({ backupReminderSnoozedUntil: '2026-01-10T00:00:00.000Z' }),
    ).toBe(true)
  })
})

describe('countVaultRecords', () => {
  it('adds the expenses, income, categories and budgets', async () => {
    fillCounts(4, 3, 2, 1)
    expect(await countVaultRecords()).toBe(10)

    fillCounts(0, 7, 0, 5)
    expect(await countVaultRecords()).toBe(12)
  })

  it('is 0 for an empty vault', async () => {
    expect(await countVaultRecords()).toBe(0)
  })
})

describe('getBackupReminderStatus', () => {
  function storeSettings(patch: Partial<BackupSettings> = {}) {
    mockStore.set('meta:settings', { ...DUE, ...patch })
  }

  it('shows with the days since the last backup', async () => {
    storeSettings()
    fillCounts(6, 2, 1, 1)

    expect(await getBackupReminderStatus(NOW)).toEqual({
      show: true,
      daysSinceBackup: 19,
    })
  })

  it('does not show with fewer than 10 records', async () => {
    storeSettings()
    fillCounts(5, 2, 1, 1)

    const status = await getBackupReminderStatus(NOW)

    expect(status.show).toBe(false)
    expect(status.daysSinceBackup).toBe(19)
  })

  it('reports null days and shows when there was never a backup', async () => {
    storeSettings({ lastBackupAt: null })
    fillCounts(10, 0, 0, 0)

    expect(await getBackupReminderStatus(NOW)).toEqual({
      show: true,
      daysSinceBackup: null,
    })
  })

  it('does not show when the reminder is off, and skips reading the records', async () => {
    storeSettings({ backupReminderDays: 0 })
    fillCounts(50, 0, 0, 0)

    const status = await getBackupReminderStatus(NOW)

    expect(status.show).toBe(false)
    expect(getAllExpenses).not.toHaveBeenCalled()
    expect(getAllIncome).not.toHaveBeenCalled()
  })

  it('skips reading the records when the data has not changed since the backup', async () => {
    storeSettings({ lastDataChangeAt: '2026-01-01T00:00:00.000Z' })
    fillCounts(50, 0, 0, 0)

    expect((await getBackupReminderStatus(NOW)).show).toBe(false)
    expect(getAllExpenses).not.toHaveBeenCalled()
  })

  it('skips reading the records while snoozed', async () => {
    storeSettings({ backupReminderSnoozedUntil: '2026-01-21T00:00:00.000Z' })
    fillCounts(50, 0, 0, 0)

    expect((await getBackupReminderStatus(NOW)).show).toBe(false)
    expect(getAllExpenses).not.toHaveBeenCalled()
  })

  it('reads the records when the other conditions hold', async () => {
    storeSettings()
    fillCounts(10, 0, 0, 0)

    await getBackupReminderStatus(NOW)

    expect(getAllExpenses).toHaveBeenCalledTimes(1)
  })

  it('hides after a backup is recorded and shows again after a later change', async () => {
    storeSettings()
    fillCounts(10, 0, 0, 0)
    expect((await getBackupReminderStatus(NOW)).show).toBe(true)

    await recordBackupCompleted(NOW)
    expect((await getBackupReminderStatus(NOW)).show).toBe(false)

    const later = new Date(NOW.getTime() + 20 * DAY)
    await updateBackupSettings({
      lastDataChangeAt: new Date(NOW.getTime() + DAY).toISOString(),
    })
    expect((await getBackupReminderStatus(later)).show).toBe(true)
  })

  it('hides for 3 days after "Later", then returns', async () => {
    storeSettings()
    fillCounts(10, 0, 0, 0)

    await snoozeBackupReminder(NOW)

    expect(
      (await getBackupReminderStatus(new Date(NOW.getTime() + 2 * DAY))).show,
    ).toBe(false)
    expect(
      (await getBackupReminderStatus(new Date(NOW.getTime() + 3 * DAY))).show,
    ).toBe(true)
  })
})

describe('backupReminderText', () => {
  it('says there is no backup yet for null', () => {
    expect(backupReminderText(null)).toBe('No backup yet.')
  })

  it('reports the number of days', () => {
    expect(backupReminderText(19)).toBe('Last backup: 19 days ago.')
    expect(backupReminderText(3)).toBe('Last backup: 3 days ago.')
  })
})
