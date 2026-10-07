// No CONTRACT_GAPs: syncChannel and its test notes are fully specified in the
// Interface Contract.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import type { SyncChannel } from '@/lib/syncChannel'
import {
  getSyncChannel,
  listenForChanges,
  postChanged,
  queryKeysForStorageKeys,
  setSyncChannel,
} from '@/lib/syncChannel'

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function fakeQueryClient() {
  return { invalidateQueries: vi.fn<QueryClient['invalidateQueries']>() }
}

function message(data: unknown) {
  return new MessageEvent('message', { data })
}

afterEach(() => {
  setSyncChannel(undefined)
  vi.unstubAllGlobals()
})

describe('queryKeysForStorageKeys', () => {
  it('maps an expenses chunk to expenses and analytics', () => {
    expect(queryKeysForStorageKeys(['expenses_2024_03'])).toEqual([
      ['expenses'],
      ['analytics'],
    ])
  })

  it('maps categories to categories, expenses and budgets', () => {
    expect(queryKeysForStorageKeys(['categories'])).toEqual([
      ['categories'],
      ['expenses'],
      ['budgets'],
    ])
  })

  it('maps income to income and analytics', () => {
    expect(queryKeysForStorageKeys(['income'])).toEqual([
      ['income'],
      ['analytics'],
    ])
  })

  it('maps budgets to budgets and analytics', () => {
    expect(queryKeysForStorageKeys(['budgets'])).toEqual([
      ['budgets'],
      ['analytics'],
    ])
  })

  it('dedupes across keys, keeping first-seen order', () => {
    expect(
      queryKeysForStorageKeys(['expenses_2024_03', 'expenses_2024_04']),
    ).toEqual([['expenses'], ['analytics']])
    expect(queryKeysForStorageKeys(['income', 'budgets'])).toEqual([
      ['income'],
      ['analytics'],
      ['budgets'],
    ])
  })

  it('maps unknown keys and quarantine keys to nothing', () => {
    expect(queryKeysForStorageKeys([])).toEqual([])
    expect(queryKeysForStorageKeys(['something_else'])).toEqual([])
    expect(
      queryKeysForStorageKeys(['quarantine:expenses_2024_03:2024-03-15T00:00:00.000Z']),
    ).toEqual([])
  })
})

describe('listenForChanges', () => {
  it('invalidates income and analytics for an income message', () => {
    const channel = fakeChannel()
    const client = fakeQueryClient()
    listenForChanges(client, channel)

    const listener = channel.addEventListener.mock.calls[0][1]
    listener(message({ type: 'changed', keys: ['income'] }))

    expect(channel.addEventListener.mock.calls[0][0]).toBe('message')
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['income'],
    })
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['analytics'],
    })
  })

  it('does not invalidate unrelated keys for an income message', () => {
    const channel = fakeChannel()
    const client = fakeQueryClient()
    listenForChanges(client, channel)

    channel.addEventListener.mock.calls[0][1](
      message({ type: 'changed', keys: ['income'] }),
    )

    expect(client.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['expenses'],
    })
    expect(client.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['categories'],
    })
    expect(client.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['budgets'],
    })
  })

  it('invalidates categories, expenses and budgets for a categories message', () => {
    const channel = fakeChannel()
    const client = fakeQueryClient()
    listenForChanges(client, channel)

    channel.addEventListener.mock.calls[0][1](
      message({ type: 'changed', keys: ['categories'] }),
    )

    const keys = client.invalidateQueries.mock.calls.map((c) => c[0]?.queryKey)
    expect(keys).toEqual([['categories'], ['expenses'], ['budgets']])
  })

  it('invalidates each distinct query key once for several storage keys', () => {
    const channel = fakeChannel()
    const client = fakeQueryClient()
    listenForChanges(client, channel)

    channel.addEventListener.mock.calls[0][1](
      message({
        type: 'changed',
        keys: ['expenses_2024_03', 'expenses_2024_04', 'income'],
      }),
    )

    const keys = client.invalidateQueries.mock.calls.map((c) => c[0]?.queryKey)
    expect(keys).toEqual([['expenses'], ['analytics'], ['income']])
  })

  it.each([
    ['null', null],
    ['a string', 'changed'],
    ['wrong type', { type: 'other', keys: ['income'] }],
    ['missing keys', { type: 'changed' }],
    ['keys not an array', { type: 'changed', keys: 'income' }],
    ['non-string keys', { type: 'changed', keys: [1, 2] }],
  ])('ignores a malformed message (%s)', (_name, data) => {
    const channel = fakeChannel()
    const client = fakeQueryClient()
    listenForChanges(client, channel)

    channel.addEventListener.mock.calls[0][1](message(data))

    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })

  it('returns an unsubscribe that removes the same listener without closing the channel', () => {
    const channel = fakeChannel()
    const unsubscribe = listenForChanges(fakeQueryClient(), channel)
    const listener = channel.addEventListener.mock.calls[0][1]

    unsubscribe()

    expect(channel.removeEventListener).toHaveBeenCalledWith('message', listener)
    expect(channel.close).not.toHaveBeenCalled()
  })

  it('with a null channel returns a harmless no-op', () => {
    const client = fakeQueryClient()

    const unsubscribe = listenForChanges(client, null)

    expect(() => unsubscribe()).not.toThrow()
    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })

  it('defaults to the injected channel', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    listenForChanges(fakeQueryClient())

    expect(channel.addEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('postChanged / setSyncChannel', () => {
  it('posts a changed message on the injected channel', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postChanged(['income'])
    postChanged(['expenses_2024_03', 'categories'])

    expect(channel.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'changed',
      keys: ['income'],
    })
    expect(channel.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'changed',
      keys: ['expenses_2024_03', 'categories'],
    })
  })

  it('does nothing for an empty key list', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postChanged([])

    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('swallows an error thrown by postMessage', () => {
    const channel = fakeChannel()
    channel.postMessage.mockImplementation(() => {
      throw new Error('channel closed')
    })
    setSyncChannel(channel)

    expect(() => postChanged(['income'])).not.toThrow()
  })

  it('null disables syncing', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    setSyncChannel(null)

    expect(getSyncChannel()).toBeNull()
    expect(() => postChanged(['income'])).not.toThrow()
    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('getSyncChannel returns the injected channel', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    expect(getSyncChannel()).toBe(channel)
  })
})

describe('default BroadcastChannel handling', () => {
  it('returns null and no-ops when BroadcastChannel is unavailable', async () => {
    vi.resetModules()
    vi.stubGlobal('BroadcastChannel', undefined)
    const fresh = await import('@/lib/syncChannel')

    expect(fresh.getSyncChannel()).toBeNull()
    expect(() => fresh.postChanged(['income'])).not.toThrow()
    const unsubscribe = fresh.listenForChanges(fakeQueryClient())
    expect(() => unsubscribe()).not.toThrow()
  })

  it('lazily creates one BroadcastChannel named "minima" and caches it', async () => {
    const names: Array<string> = []
    const posted: Array<unknown> = []
    class FakeBroadcastChannel {
      constructor(name: string) {
        names.push(name)
      }
      postMessage(data: unknown) {
        posted.push(data)
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.resetModules()
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    const fresh = await import('@/lib/syncChannel')

    expect(names).toEqual([])
    const first = fresh.getSyncChannel()
    const second = fresh.getSyncChannel()

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(names).toEqual(['minima'])

    fresh.postChanged(['budgets'])
    expect(posted).toEqual([{ type: 'changed', keys: ['budgets'] }])
  })

  it('setSyncChannel(undefined) restores the default channel', async () => {
    class FakeBroadcastChannel {
      postMessage() {}
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.resetModules()
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    const fresh = await import('@/lib/syncChannel')
    const injected = fakeChannel()

    fresh.setSyncChannel(injected)
    expect(fresh.getSyncChannel()).toBe(injected)

    fresh.setSyncChannel(undefined)
    const restored = fresh.getSyncChannel()
    expect(restored).not.toBeNull()
    expect(restored).not.toBe(injected)
  })
})
