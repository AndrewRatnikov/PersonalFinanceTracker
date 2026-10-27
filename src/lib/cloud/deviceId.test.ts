// No CONTRACT_GAPs: deviceId exports, the storage key and the label rules are
// specified in plan section 7 and the Interface Contract (module: deviceId).
// idb-keyval is mocked (localWipe pulls in the local store) and no network or
// real storage is touched. Run 3 adds resetDeviceId (plan section 5).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLang, translate } from '@/i18n/core'
import {
  DEVICE_ID_STORAGE_KEY,
  defaultDeviceLabel,
  getDeviceId,
  resetDeviceId,
} from '@/lib/cloud/deviceId'
import { removeMinimaLocalStorageKeys } from '@/lib/localWipe'

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  setMany: () => Promise.resolve(),
  del: () => Promise.resolve(),
  clear: () => Promise.resolve(),
  keys: () => Promise.resolve([]),
}))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadChrome:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  windowsOpera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  unknown: 'curl/8.0',
}

beforeEach(() => {
  localStorage.clear()
  setLang('en', { persist: false })
})

afterEach(() => {
  vi.restoreAllMocks()
  setLang('en', { persist: false })
})

describe('getDeviceId', () => {
  it('stores the key under minima_device_id', () => {
    expect(DEVICE_ID_STORAGE_KEY).toBe('minima_device_id')
  })

  it('creates a UUID, stores it and returns the same one next time', () => {
    const first = getDeviceId()
    const second = getDeviceId()

    expect(first).toMatch(UUID_RE)
    expect(second).toBe(first)
    expect(localStorage.getItem('minima_device_id')).toBe(first)
  })

  it('returns a valid stored UUID unchanged', () => {
    const stored = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    localStorage.setItem('minima_device_id', stored)
    expect(getDeviceId()).toBe(stored)
    expect(localStorage.getItem('minima_device_id')).toBe(stored)
  })

  it('replaces a junk stored value with a new UUID', () => {
    for (const junk of ['', 'not-a-uuid', '1234', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5']) {
      localStorage.setItem('minima_device_id', junk)
      const id = getDeviceId()
      expect(id, junk).toMatch(UUID_RE)
      expect(id).not.toBe(junk)
      expect(localStorage.getItem('minima_device_id')).toBe(id)
    }
  })

  it('gives a different id after the stored one is cleared', () => {
    const first = getDeviceId()
    localStorage.removeItem('minima_device_id')
    const second = getDeviceId()
    expect(second).toMatch(UUID_RE)
    expect(second).not.toBe(first)
  })

  it('falls back to one in-memory UUID when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })

    const first = getDeviceId()
    const second = getDeviceId()

    expect(first).toMatch(UUID_RE)
    expect(second).toBe(first)
  })
})

describe('resetDeviceId', () => {
  it('stores and returns a new UUID that getDeviceId then returns', () => {
    const before = getDeviceId()
    const next = resetDeviceId()

    expect(next).toMatch(UUID_RE)
    expect(next).not.toBe(before)
    expect(localStorage.getItem('minima_device_id')).toBe(next)
    expect(getDeviceId()).toBe(next)
  })

  it('works when no id was stored yet', () => {
    expect(localStorage.getItem('minima_device_id')).toBeNull()
    const next = resetDeviceId()
    expect(next).toMatch(UUID_RE)
    expect(localStorage.getItem('minima_device_id')).toBe(next)
  })

  it('gives a different id every time', () => {
    const a = resetDeviceId()
    const b = resetDeviceId()
    const c = resetDeviceId()
    expect(new Set([a, b, c]).size).toBe(3)
    expect(getDeviceId()).toBe(c)
  })

  it('falls back to a new in-memory UUID when localStorage throws', () => {
    const memoryBefore = (() => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied')
      })
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('denied')
      })
      return getDeviceId()
    })()

    const next = resetDeviceId()

    expect(next).toMatch(UUID_RE)
    expect(next).not.toBe(memoryBefore)
    expect(getDeviceId()).toBe(next)
  })
})

describe('"Remove data" clears the device id', () => {
  it('removeMinimaLocalStorageKeys removes minima_device_id', () => {
    const id = getDeviceId()
    localStorage.setItem('other_app_key', 'keep')
    expect(localStorage.getItem('minima_device_id')).toBe(id)

    removeMinimaLocalStorageKeys()

    expect(localStorage.getItem('minima_device_id')).toBeNull()
    expect(localStorage.getItem('other_app_key')).toBe('keep')
  })

  it('also removes a reset id', () => {
    const id = resetDeviceId()
    expect(localStorage.getItem('minima_device_id')).toBe(id)
    removeMinimaLocalStorageKeys()
    expect(localStorage.getItem('minima_device_id')).toBeNull()
  })
})

describe('defaultDeviceLabel', () => {
  it.each([
    ['Android Chrome', UA.androidChrome, 'Chrome on Android'],
    ['iPhone Safari', UA.iphoneSafari, 'Safari on iPhone'],
    ['iPad Chrome', UA.ipadChrome, 'Chrome on iPad'],
    ['Windows Edge', UA.windowsEdge, 'Edge on Windows'],
    ['Windows Opera', UA.windowsOpera, 'Opera on Windows'],
    ['Samsung Internet', UA.samsung, 'Samsung Internet on Android'],
    ['Linux Firefox', UA.linuxFirefox, 'Firefox on Linux'],
    ['Mac Chrome', UA.macChrome, 'Chrome on macOS'],
    ['Mac Safari', UA.macSafari, 'Safari on macOS'],
    ['ChromeOS', UA.chromeOs, 'Chrome on ChromeOS'],
    ['iPhone Firefox', UA.iphoneFirefox, 'Firefox on iPhone'],
  ])('%s', (_name, ua, expected) => {
    expect(defaultDeviceLabel(ua)).toBe(expected)
  })

  it('uses the translated unknown browser and platform for an unrecognised agent', () => {
    const label = defaultDeviceLabel(UA.unknown)
    const expected = translate('en', 'cloud.device.defaultLabel', {
      browser: translate('en', 'cloud.device.unknownBrowser'),
      platform: translate('en', 'cloud.device.unknownPlatform'),
    })
    expect(label).toBe(expected)
    expect(label).not.toMatch(/Chrome|Safari|Firefox|Windows|Linux/)
  })

  it('follows the interface language', () => {
    setLang('uk', { persist: false })
    expect(defaultDeviceLabel(UA.androidChrome)).toBe('Chrome на Android')
    expect(defaultDeviceLabel(UA.iphoneSafari)).toBe('Safari на iPhone')
    expect(defaultDeviceLabel(UA.androidChrome)).not.toBe('Chrome on Android')
  })

  it('defaults to navigator.userAgent', () => {
    const spy = vi.spyOn(window.navigator, 'userAgent', 'get')
    spy.mockReturnValue(UA.androidChrome)
    expect(defaultDeviceLabel()).toBe('Chrome on Android')
    spy.mockReturnValue(UA.linuxFirefox)
    expect(defaultDeviceLabel()).toBe('Firefox on Linux')
  })

  it('is at most 60 characters', () => {
    for (const ua of Object.values(UA)) {
      const label = defaultDeviceLabel(ua)
      expect(label.length).toBeGreaterThan(0)
      expect(label.length).toBeLessThanOrEqual(60)
    }
  })
})
