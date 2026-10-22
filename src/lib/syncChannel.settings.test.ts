// No CONTRACT_GAPs: the meta:settings and syncedSettings mappings of
// queryKeysForStorageKeys are fully specified in the Interface Contract
// (module: syncChannel). The existing mappings are re-checked here so the new
// one cannot replace them.

import { describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { listenForChanges, queryKeysForStorageKeys } from '@/lib/syncChannel'

const SETTINGS_QUERY_KEYS = [
  ['settings'],
  ['conversion-status'],
  ['expenses'],
  ['income'],
  ['analytics'],
  ['budgets'],
]

describe('queryKeysForStorageKeys for meta:settings', () => {
  it('maps it to the settings, conversion status and data queries', () => {
    expect(queryKeysForStorageKeys(['meta:settings'])).toEqual(SETTINGS_QUERY_KEYS)
  })

  it('does not repeat a key that another storage key also maps to', () => {
    const keys = queryKeysForStorageKeys(['income', 'meta:settings'])

    expect(keys.filter((k) => k[0] === 'income')).toHaveLength(1)
    expect(keys.filter((k) => k[0] === 'analytics')).toHaveLength(1)
    expect(keys.map((k) => k[0])).toEqual(
      expect.arrayContaining(['settings', 'conversion-status', 'budgets']),
    )
  })

  it('leaves the other mappings unchanged', () => {
    expect(queryKeysForStorageKeys(['income'])).toEqual([['income'], ['analytics']])
    expect(queryKeysForStorageKeys(['budgets'])).toEqual([
      ['budgets'],
      ['analytics'],
    ])
    expect(queryKeysForStorageKeys(['expenses_2026_10'])).toEqual([
      ['expenses'],
      ['analytics'],
    ])
    expect(queryKeysForStorageKeys(['categories'])).toEqual([
      ['categories'],
      ['expenses'],
      ['budgets'],
    ])
  })

  it('still maps an unknown key to nothing', () => {
    expect(queryKeysForStorageKeys(['quarantine:whatever'])).toEqual([])
  })
})

describe('queryKeysForStorageKeys for syncedSettings', () => {
  it('maps it to the same six queries as meta:settings', () => {
    const synced = queryKeysForStorageKeys(['syncedSettings'])

    expect(synced).toEqual(SETTINGS_QUERY_KEYS)
    expect(synced).toEqual(queryKeysForStorageKeys(['meta:settings']))
  })

  it('does not repeat a key when it comes with meta:settings or a data key', () => {
    const both = queryKeysForStorageKeys(['syncedSettings', 'meta:settings'])
    const withIncome = queryKeysForStorageKeys(['income', 'syncedSettings'])

    expect(both).toEqual(SETTINGS_QUERY_KEYS)
    expect(withIncome.filter((k) => k[0] === 'income')).toHaveLength(1)
    expect(withIncome.filter((k) => k[0] === 'settings')).toHaveLength(1)
  })

  it('does not map the bookkeeping key meta:sync to any query', () => {
    expect(queryKeysForStorageKeys(['meta:sync'])).toEqual([])
  })
})

describe('listenForChanges with a settings message', () => {
  function listenAndSend(key: string) {
    let handler: ((event: MessageEvent) => void) | undefined
    const channel: SyncChannel = {
      postMessage: vi.fn(),
      addEventListener: (_type, listener) => {
        handler = listener
      },
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }
    const invalidateQueries = vi.fn()
    listenForChanges({ invalidateQueries }, channel)

    handler?.(
      new MessageEvent('message', {
        data: { type: 'changed', keys: [key] },
      }),
    )
    return invalidateQueries
  }

  it.each(['meta:settings', 'syncedSettings'])(
    'a %s message invalidates the settings and conversion-status queries',
    (key) => {
      const invalidateQueries = listenAndSend(key)

      const invalidated = invalidateQueries.mock.calls.map(
        (c) => (c[0] as { queryKey: Array<string> }).queryKey[0],
      )
      expect(invalidated).toEqual(
        expect.arrayContaining(['settings', 'conversion-status', 'expenses']),
      )
      expect(invalidateQueries).toHaveBeenCalledTimes(6)
    },
  )

  it('an unrelated key invalidates nothing', () => {
    expect(listenAndSend('meta:sync')).not.toHaveBeenCalled()
  })
})
