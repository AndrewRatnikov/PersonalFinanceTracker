// No CONTRACT_GAPs: getOpenAppIn / setOpenAppIn are specified in the Interface
// Contract (appSettings.ts). The store mock mirrors appSettings.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_OPEN_APP_IN,
  OPEN_APP_IN_OPTIONS,
  OPEN_APP_IN_QUERY_KEY,
  getAppSettings,
  getOpenAppIn,
  setOpenAppIn,
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

beforeEach(() => {
  mockStore.clear()
  idbGet.mockClear()
  idbSet.mockClear()
  getLocalStore.mockReset().mockReturnValue('mock-store')
})

describe('constants', () => {
  it('lists the options, the default and the query key', () => {
    expect([...OPEN_APP_IN_OPTIONS]).toEqual(['last', 'personal', 'family'])
    expect(DEFAULT_OPEN_APP_IN).toBe('last')
    expect([...OPEN_APP_IN_QUERY_KEY]).toEqual(['settings', 'open-app-in'])
  })
})

describe('getOpenAppIn', () => {
  it('defaults to last for an empty store', async () => {
    expect(await getOpenAppIn()).toBe('last')
  })

  it('returns each stored valid value', async () => {
    for (const value of ['personal', 'family', 'last'] as const) {
      mockStore.set('meta:settings', { openAppIn: value })
      expect(await getOpenAppIn()).toBe(value)
    }
  })

  it('falls back to last for an invalid value', async () => {
    mockStore.set('meta:settings', { openAppIn: 'everywhere' })
    expect(await getOpenAppIn()).toBe('last')
    mockStore.set('meta:settings', { openAppIn: 3 })
    expect(await getOpenAppIn()).toBe('last')
  })

  it('never throws when the read fails', async () => {
    idbGet.mockRejectedValueOnce(new Error('boom'))
    await expect(getOpenAppIn()).resolves.toBe('last')
  })
})

describe('setOpenAppIn', () => {
  it('writes the value into meta:settings and keeps the other fields', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 5, recoveryKeyConfirmed: false })

    await setOpenAppIn('family')

    const saved = mockStore.get('meta:settings') as Record<string, unknown>
    expect(saved.openAppIn).toBe('family')
    expect(saved.autoLockMinutes).toBe(5)
    expect(saved.recoveryKeyConfirmed).toBe(false)
    expect(await getOpenAppIn()).toBe('family')
  })

  it('a later value replaces the earlier one', async () => {
    await setOpenAppIn('family')
    await setOpenAppIn('personal')

    expect(await getOpenAppIn()).toBe('personal')
  })

  it('does not change what getAppSettings returns', async () => {
    const before = await getAppSettings()
    await setOpenAppIn('family')

    expect(await getAppSettings()).toEqual(before)
  })
})
