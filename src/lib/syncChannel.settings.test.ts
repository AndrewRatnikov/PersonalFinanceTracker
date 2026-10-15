// No CONTRACT_GAPs: the meta:settings mapping of queryKeysForStorageKeys is
// fully specified in the Interface Contract (plan section 12). The existing
// mappings are re-checked here so the new one cannot replace them.

import { describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { listenForChanges, queryKeysForStorageKeys } from '@/lib/syncChannel'

describe('queryKeysForStorageKeys for meta:settings', () => {
  it('maps it to the settings, conversion status and data queries', () => {
    expect(queryKeysForStorageKeys(['meta:settings'])).toEqual([
      ['settings'],
      ['conversion-status'],
      ['expenses'],
      ['income'],
      ['analytics'],
      ['budgets'],
    ])
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

describe('listenForChanges with a meta:settings message', () => {
  it('invalidates the settings and conversion-status queries', () => {
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
        data: { type: 'changed', keys: ['meta:settings'] },
      }),
    )

    const invalidated = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: Array<string> }).queryKey[0],
    )
    expect(invalidated).toEqual(
      expect.arrayContaining(['settings', 'conversion-status', 'expenses']),
    )
    expect(invalidateQueries).toHaveBeenCalledTimes(6)
  })
})
