// No CONTRACT_GAPs: appSettings exports and dependencies are fully specified
// in the Interface Contract (module: appSettings).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APP_SETTINGS_QUERY_KEY,
  AUTO_LOCK_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
  getAppSettings,
  updateAppSettings,
} from '@/lib/appSettings'

const { mockStore, getLocalStore, idbGet, idbSet } = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  return {
    mockStore: store,
    getLocalStore: vi.fn(),
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

vi.mock('@/lib/localDb', () => ({ getLocalStore }))

vi.mock('@/lib/vault', () => ({ META_SETTINGS_KEY: 'meta:settings' }))

const DEFAULTS = {
  autoLockMinutes: 15,
  installHintDismissed: false,
  persistRequestedAt: null,
  recoveryKeyConfirmed: true,
}

beforeEach(() => {
  mockStore.clear()
  idbGet.mockClear()
  idbSet.mockClear()
  getLocalStore.mockReset().mockReturnValue('mock-store')
})

describe('appSettings constants', () => {
  it('lists the auto-lock options and a default of 15', () => {
    expect([...AUTO_LOCK_OPTIONS]).toEqual([0, 1, 5, 15, 60])
    expect(DEFAULT_AUTO_LOCK_MINUTES).toBe(15)
    expect([...APP_SETTINGS_QUERY_KEY]).toEqual(['settings'])
  })
})

describe('getAppSettings', () => {
  it('returns the defaults for an empty store', async () => {
    expect(await getAppSettings()).toEqual(DEFAULTS)
  })

  it('returns stored valid values', async () => {
    mockStore.set('meta:settings', {
      autoLockMinutes: 5,
      installHintDismissed: true,
      persistRequestedAt: '2026-01-02T03:04:05.000Z',
      recoveryKeyConfirmed: false,
    })

    expect(await getAppSettings()).toEqual({
      autoLockMinutes: 5,
      installHintDismissed: true,
      persistRequestedAt: '2026-01-02T03:04:05.000Z',
      recoveryKeyConfirmed: false,
    })
  })

  it('accepts 0 (Off) as a valid auto-lock value', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 0 })

    expect((await getAppSettings()).autoLockMinutes).toBe(0)
  })

  it('falls back to the default for an auto-lock value outside the options', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 7 })

    expect((await getAppSettings()).autoLockMinutes).toBe(15)
  })

  it('falls back to defaults for fields of the wrong type', async () => {
    mockStore.set('meta:settings', {
      autoLockMinutes: '5',
      installHintDismissed: 'yes',
      persistRequestedAt: 42,
      recoveryKeyConfirmed: 'no',
    })

    expect(await getAppSettings()).toEqual(DEFAULTS)
  })

  it('ignores the brute-force counter fields', async () => {
    mockStore.set('meta:settings', {
      failedUnlockAttempts: 3,
      unlockBlockedUntil: null,
    })

    expect(await getAppSettings()).toEqual(DEFAULTS)
  })

  it('returns defaults without a store', async () => {
    getLocalStore.mockReturnValue(null)
    mockStore.set('meta:settings', { autoLockMinutes: 5 })

    expect(await getAppSettings()).toEqual(DEFAULTS)
  })

  it('never throws: returns defaults when the read rejects', async () => {
    idbGet.mockRejectedValueOnce(new Error('idb broke'))

    expect(await getAppSettings()).toEqual(DEFAULTS)
  })
})

describe('recoveryKeyConfirmed', () => {
  it('treats a missing field as confirmed (true)', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 5 })

    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(true)
  })

  it('reads a stored false as false', async () => {
    mockStore.set('meta:settings', { recoveryKeyConfirmed: false })

    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(false)
  })

  it('reads a stored true as true', async () => {
    mockStore.set('meta:settings', { recoveryKeyConfirmed: true })

    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(true)
  })

  it.each([0, null, 'false', 'true', {}])(
    'treats the non-boolean %j as confirmed (true)',
    async (value) => {
      mockStore.set('meta:settings', { recoveryKeyConfirmed: value })

      expect((await getAppSettings()).recoveryKeyConfirmed).toBe(true)
    },
  )

  it('updateAppSettings({ recoveryKeyConfirmed: true }) flips a stored false and keeps other fields', async () => {
    mockStore.set('meta:settings', {
      recoveryKeyConfirmed: false,
      autoLockMinutes: 5,
      failedUnlockAttempts: 2,
    })

    await updateAppSettings({ recoveryKeyConfirmed: true })

    expect(mockStore.get('meta:settings')).toEqual({
      recoveryKeyConfirmed: true,
      autoLockMinutes: 5,
      failedUnlockAttempts: 2,
    })
    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(true)
  })

  it('updateAppSettings({ recoveryKeyConfirmed: false }) is stored and read back', async () => {
    await updateAppSettings({ recoveryKeyConfirmed: false })

    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(false)
  })

  it('updating another field keeps a stored recoveryKeyConfirmed: false', async () => {
    mockStore.set('meta:settings', { recoveryKeyConfirmed: false })

    await updateAppSettings({ autoLockMinutes: 60 })

    expect(await getAppSettings()).toEqual({
      ...DEFAULTS,
      autoLockMinutes: 60,
      recoveryKeyConfirmed: false,
    })
  })
})

describe('updateAppSettings', () => {
  it('writes a patch that getAppSettings reads back', async () => {
    await updateAppSettings({ autoLockMinutes: 60 })
    expect((await getAppSettings()).autoLockMinutes).toBe(60)

    await updateAppSettings({ autoLockMinutes: 1 })
    expect((await getAppSettings()).autoLockMinutes).toBe(1)
  })

  it('merges the patch with the stored settings', async () => {
    await updateAppSettings({ autoLockMinutes: 5 })
    await updateAppSettings({ installHintDismissed: true })

    expect(await getAppSettings()).toEqual({
      autoLockMinutes: 5,
      installHintDismissed: true,
      persistRequestedAt: null,
      recoveryKeyConfirmed: true,
    })
  })

  it('preserves the brute-force counter fields', async () => {
    mockStore.set('meta:settings', {
      failedUnlockAttempts: 4,
      unlockBlockedUntil: '2030-01-01T00:00:00.000Z',
    })

    await updateAppSettings({ autoLockMinutes: 5 })

    expect(mockStore.get('meta:settings')).toEqual({
      failedUnlockAttempts: 4,
      unlockBlockedUntil: '2030-01-01T00:00:00.000Z',
      autoLockMinutes: 5,
    })
  })

  it('is a no-op without a store', async () => {
    getLocalStore.mockReturnValue(null)

    await updateAppSettings({ autoLockMinutes: 5 })

    expect(idbSet).not.toHaveBeenCalled()
    expect(mockStore.size).toBe(0)
  })
})
