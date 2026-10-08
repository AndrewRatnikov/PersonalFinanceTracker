// No CONTRACT_GAPs: storagePersistence exports and test notes are fully
// specified in the Interface Contract (module: storagePersistence).
//
// navigator.storage is replaced with Object.defineProperty (not vi.mock( of
// the module under test); only appSettings is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { updateAppSettings } from '@/lib/appSettings'
import {
  ensurePersistentStorage,
  formatBytes,
  getStorageStatus,
  requestPersistentStorage,
} from '@/lib/storagePersistence'

vi.mock('@/lib/appSettings', () => ({ updateAppSettings: vi.fn() }))

interface StorageStub {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

function stubStorage(value: StorageStub | undefined) {
  Object.defineProperty(navigator, 'storage', { value, configurable: true })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(updateAppSettings).mockResolvedValue(undefined)
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'storage')
})

describe('requestPersistentStorage', () => {
  it('returns true and records persistRequestedAt when persist() is granted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({ persist })

    const granted = await requestPersistentStorage()

    expect(granted).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(updateAppSettings).toHaveBeenCalledTimes(1)
    const patch = vi.mocked(updateAppSettings).mock.calls[0][0]
    expect(typeof patch.persistRequestedAt).toBe('string')
    expect(Number.isNaN(Date.parse(patch.persistRequestedAt as string))).toBe(
      false,
    )
  })

  it('returns false when persist() is denied, and still records the request', async () => {
    stubStorage({ persist: vi.fn().mockResolvedValue(false) })

    const granted = await requestPersistentStorage()

    expect(granted).toBe(false)
    expect(updateAppSettings).toHaveBeenCalledTimes(1)
  })

  it('returns false without throwing when the API is missing', async () => {
    stubStorage(undefined)

    await expect(requestPersistentStorage()).resolves.toBe(false)
    expect(updateAppSettings).not.toHaveBeenCalled()
  })

  it('returns false without throwing when storage has no persist()', async () => {
    stubStorage({})

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('returns false without throwing when persist() rejects', async () => {
    stubStorage({ persist: vi.fn().mockRejectedValue(new Error('denied')) })

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('returns false without throwing when recording the settings fails', async () => {
    stubStorage({ persist: vi.fn().mockResolvedValue(true) })
    vi.mocked(updateAppSettings).mockRejectedValue(new Error('idb broke'))

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})

describe('ensurePersistentStorage', () => {
  it('does nothing when storage is already persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({ persisted: vi.fn().mockResolvedValue(true), persist })

    await ensurePersistentStorage()

    expect(persist).not.toHaveBeenCalled()
    expect(updateAppSettings).not.toHaveBeenCalled()
  })

  it('requests persistence when storage is not persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({ persisted: vi.fn().mockResolvedValue(false), persist })

    await ensurePersistentStorage()

    expect(persist).toHaveBeenCalledTimes(1)
    expect(updateAppSettings).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the API is missing', async () => {
    stubStorage(undefined)

    await expect(ensurePersistentStorage()).resolves.toBeUndefined()
  })

  it('does not throw when persisted() rejects', async () => {
    stubStorage({
      persisted: vi.fn().mockRejectedValue(new Error('nope')),
      persist: vi.fn().mockResolvedValue(true),
    })

    await expect(ensurePersistentStorage()).resolves.toBeUndefined()
  })
})

describe('getStorageStatus', () => {
  it('combines persisted() and estimate()', async () => {
    stubStorage({
      persisted: vi.fn().mockResolvedValue(true),
      estimate: vi.fn().mockResolvedValue({ usage: 1536, quota: 1048576 }),
    })

    expect(await getStorageStatus()).toEqual({
      persisted: true,
      usage: 1536,
      quota: 1048576,
    })
  })

  it('reports a different state for a best-effort origin', async () => {
    stubStorage({
      persisted: vi.fn().mockResolvedValue(false),
      estimate: vi.fn().mockResolvedValue({ usage: 10, quota: 20 }),
    })

    expect(await getStorageStatus()).toEqual({
      persisted: false,
      usage: 10,
      quota: 20,
    })
  })

  it('returns false and nulls when the API is missing', async () => {
    stubStorage(undefined)

    expect(await getStorageStatus()).toEqual({
      persisted: false,
      usage: null,
      quota: null,
    })
  })

  it('returns nulls for usage and quota when estimate() is unavailable', async () => {
    stubStorage({ persisted: vi.fn().mockResolvedValue(true) })

    expect(await getStorageStatus()).toEqual({
      persisted: true,
      usage: null,
      quota: null,
    })
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1048576, '1.0 MB'],
    [5 * 1048576 + 104858, '5.1 MB'],
    [1073741824, '1.0 GB'],
    [2.5 * 1073741824, '2.5 GB'],
  ])('formats %d as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})
