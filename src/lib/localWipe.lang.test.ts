// No CONTRACT_GAPs: wipeLocalData() also calls clearStoredLang() (Interface
// Contract, "Changed lib signatures": src/lib/localWipe.ts), so "Remove data"
// clears the language cookie and the minima_lang key and detection goes back to
// automatic. The harness is the one of localWipe.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { persistLang, readStoredLang, resolveClientLang } from '@/i18n/resolve'
import { wipeLocalData } from '@/lib/localWipe'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

function clearCookies() {
  document.cookie = 'minima_lang=; Path=/; Max-Age=0'
  document.cookie = 'other=; Path=/; Max-Age=0'
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  clearCookies()
  vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  clearCookies()
})

describe('wipeLocalData and the language choice', () => {
  it('clears the language cookie as well as the minima_ keys', async () => {
    persistLang('uk')
    document.cookie = 'other=keep; Path=/'
    expect(document.cookie).toContain('minima_lang=uk')

    await wipeLocalData()

    expect(document.cookie).not.toContain('minima_lang')
    expect(localStorage.getItem('minima_lang')).toBeNull()
    expect(document.cookie).toContain('other=keep')
  })

  it('clears a cookie that has no localStorage twin', async () => {
    document.cookie = 'minima_lang=uk; Path=/'

    await wipeLocalData()

    expect(document.cookie).not.toContain('minima_lang')
  })

  it('goes back to automatic detection', async () => {
    persistLang('en')
    expect(resolveClientLang({ languages: ['uk-UA'] })).toBe('en')

    await wipeLocalData()

    expect(readStoredLang()).toBeNull()
    expect(resolveClientLang({ languages: ['uk-UA'] })).toBe('uk')
    expect(resolveClientLang({ languages: ['en-US'] })).toBe('en')
  })

  it('is safe when no language was ever chosen', async () => {
    await expect(wipeLocalData()).resolves.toBeUndefined()

    expect(document.cookie).not.toContain('minima_lang')
  })
})
