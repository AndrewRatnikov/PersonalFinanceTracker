// CONTRACT_GAP: the query keys for the Family-only base keys spaceInfo and
//   memberProfiles are not fixed by the Interface Contract; they are not
//   asserted.
// CONTRACT_GAP: the Interface Contract names `markKeyringStale` as the effect
//   of a personal `spaceKeys` message; it is observed through the keyring
//   loader (listHeldSpaceIds reloads once the keyring is stale).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import type { HeldSpace } from '@/lib/spaces/keyring'
import type { SyncChannel } from '@/lib/syncChannel'
import {
  clearKeyring,
  listHeldSpaceIds,
  setKeyring,
  setKeyringLoader,
} from '@/lib/spaces/keyring'
import {
  listenForChanges,
  postChanged,
  queryKeysForStorageKeys,
  setSyncChannel,
} from '@/lib/syncChannel'

const FAMILY = '3f2b1c4e-0000-4000-8000-00000000aaaa'

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

// Starts listening and returns the registered listener.
function listen(client: ReturnType<typeof fakeQueryClient>) {
  const channel = fakeChannel()
  listenForChanges(client, channel)
  const [, listener] = channel.addEventListener.mock.calls[0]
  return listener
}

async function held(id: string): Promise<HeldSpace> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return { id, name: 'Home', role: 'owner', keyVersion: 1, keys: [{ keyVersion: 1, key }] }
}

afterEach(() => {
  setSyncChannel(undefined)
  setKeyringLoader(null)
  clearKeyring()
  vi.unstubAllGlobals()
})

describe('postChanged', () => {
  it('a personal message is byte-identical to today (no spaceId property)', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postChanged(['expenses_2026_03'])

    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    const [sent] = channel.postMessage.mock.calls[0]
    expect(sent).toEqual({ type: 'changed', keys: ['expenses_2026_03'] })
    expect(Object.keys(sent)).toEqual(['type', 'keys'])
    expect(JSON.stringify(sent)).toBe('{"type":"changed","keys":["expenses_2026_03"]}')
  })

  it('an explicit personal spaceId adds nothing to the message', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postChanged(['income'], 'personal')

    const [sent] = channel.postMessage.mock.calls[0]
    expect(sent).toEqual({ type: 'changed', keys: ['income'] })
    expect(sent).not.toHaveProperty('spaceId')
  })

  it('a Family message carries the spaceId and the base keys', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postChanged(['expenses_2026_03', 'categories'], FAMILY)

    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'changed',
      keys: ['expenses_2026_03', 'categories'],
      spaceId: FAMILY,
    })
  })

  it('posts nothing for an empty key list, for either space', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postChanged([])
    postChanged([], FAMILY)

    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('does nothing without a channel', () => {
    setSyncChannel(null)

    expect(() => {
      postChanged(['income'], FAMILY)
    }).not.toThrow()
  })

  it('a failing channel never fails the write', () => {
    const channel = fakeChannel()
    channel.postMessage.mockImplementation(() => {
      throw new Error('closed')
    })
    setSyncChannel(channel)

    expect(() => {
      postChanged(['income'], FAMILY)
    }).not.toThrow()
  })
})

describe('queryKeysForStorageKeys', () => {
  it('maps the key material records to no query keys', () => {
    expect(queryKeysForStorageKeys(['identity'])).toEqual([])
    expect(queryKeysForStorageKeys(['spaceKeys'])).toEqual([])
    expect(queryKeysForStorageKeys(['identity', 'spaceKeys'])).toEqual([])
  })

  it('does not change the mapping of the existing keys', () => {
    expect(queryKeysForStorageKeys(['expenses_2024_03'])).toEqual([['expenses'], ['analytics']])
    expect(queryKeysForStorageKeys(['identity', 'income'])).toEqual([['income'], ['analytics']])
  })
})

describe('listenForChanges', () => {
  it('a Family message invalidates the base query keys (the prefix covers every space)', () => {
    const client = fakeQueryClient()
    const listener = listen(client)

    listener(message({ type: 'changed', keys: ['expenses_2026_03'], spaceId: FAMILY }))

    expect(client.invalidateQueries.mock.calls.map(([opts]) => opts?.queryKey)).toEqual([
      ['expenses'],
      ['analytics'],
    ])
  })

  it('a personal message invalidates the same base keys', () => {
    const client = fakeQueryClient()
    const listener = listen(client)

    listener(message({ type: 'changed', keys: ['expenses_2026_03'] }))

    expect(client.invalidateQueries.mock.calls.map(([opts]) => opts?.queryKey)).toEqual([
      ['expenses'],
      ['analytics'],
    ])
  })

  it('ignores a message that is not a changed message', () => {
    const client = fakeQueryClient()
    const listener = listen(client)

    listener(message({ type: 'lock' }))
    listener(message({ type: 'changed', keys: 'income', spaceId: FAMILY }))
    listener(message(null))

    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })

  it('a personal message with spaceKeys marks the keyring stale, so the next access reloads', async () => {
    const loader = vi.fn(() => Promise.resolve())
    setKeyringLoader(loader)
    setKeyring([await held(FAMILY)])
    expect(await listHeldSpaceIds()).toEqual([FAMILY])
    expect(loader).not.toHaveBeenCalled()
    const listener = listen(fakeQueryClient())

    listener(message({ type: 'changed', keys: ['spaceKeys'] }))
    await listHeldSpaceIds()

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('a message without spaceKeys leaves the keyring alone', async () => {
    const loader = vi.fn(() => Promise.resolve())
    setKeyringLoader(loader)
    setKeyring([await held(FAMILY)])
    const listener = listen(fakeQueryClient())

    listener(message({ type: 'changed', keys: ['categories', 'identity'] }))
    listener(message({ type: 'changed', keys: ['categories'], spaceId: FAMILY }))
    await listHeldSpaceIds()

    expect(loader).not.toHaveBeenCalled()
  })

  it('a spaceKeys message does not invalidate any query', () => {
    const client = fakeQueryClient()
    const listener = listen(client)

    listener(message({ type: 'changed', keys: ['spaceKeys'] }))

    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })
})
