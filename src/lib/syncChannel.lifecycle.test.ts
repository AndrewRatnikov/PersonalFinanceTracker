// No CONTRACT_GAPs: the lock / wiped messages and listenForLockAndWipe are
// fully specified in the Interface Contract (module: syncChannel).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import type { SyncChannel } from '@/lib/syncChannel'
import {
  listenForChanges,
  listenForLockAndWipe,
  postLock,
  postWiped,
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

function message(data: unknown) {
  return new MessageEvent('message', { data })
}

function registeredListener(channel: ReturnType<typeof fakeChannel>) {
  const call = channel.addEventListener.mock.calls[0]
  return call[1]
}

afterEach(() => {
  setSyncChannel(undefined)
})

describe('postLock', () => {
  it("posts { type: 'lock' }", () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postLock()

    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'lock' })
  })

  it('is a no-op without a channel', () => {
    setSyncChannel(null)

    expect(() => postLock()).not.toThrow()
  })

  it('swallows a postMessage failure', () => {
    const channel = fakeChannel()
    channel.postMessage.mockImplementation(() => {
      throw new Error('closed')
    })
    setSyncChannel(channel)

    expect(() => postLock()).not.toThrow()
  })
})

describe('postWiped', () => {
  it("posts { type: 'wiped' }", () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    postWiped()

    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'wiped' })
  })

  it('is a no-op without a channel', () => {
    setSyncChannel(null)

    expect(() => postWiped()).not.toThrow()
  })

  it('swallows a postMessage failure', () => {
    const channel = fakeChannel()
    channel.postMessage.mockImplementation(() => {
      throw new Error('closed')
    })
    setSyncChannel(channel)

    expect(() => postWiped()).not.toThrow()
  })
})

describe('listenForLockAndWipe', () => {
  it('calls onLock, and only onLock, for a lock message', () => {
    const channel = fakeChannel()
    const onLock = vi.fn()
    const onWiped = vi.fn()
    listenForLockAndWipe({ onLock, onWiped }, channel)

    registeredListener(channel)(message({ type: 'lock' }))

    expect(onLock).toHaveBeenCalledTimes(1)
    expect(onWiped).not.toHaveBeenCalled()
  })

  it('calls onWiped, and only onWiped, for a wiped message', () => {
    const channel = fakeChannel()
    const onLock = vi.fn()
    const onWiped = vi.fn()
    listenForLockAndWipe({ onLock, onWiped }, channel)

    registeredListener(channel)(message({ type: 'wiped' }))

    expect(onWiped).toHaveBeenCalledTimes(1)
    expect(onLock).not.toHaveBeenCalled()
  })

  it.each([
    ['a changed message', { type: 'changed', keys: ['income'] }],
    ['an unknown type', { type: 'bogus' }],
    ['null', null],
    ['a string', 'lock'],
    ['an object without a type', {}],
  ])('ignores %s', (_name, data) => {
    const channel = fakeChannel()
    const onLock = vi.fn()
    const onWiped = vi.fn()
    listenForLockAndWipe({ onLock, onWiped }, channel)

    registeredListener(channel)(message(data))

    expect(onLock).not.toHaveBeenCalled()
    expect(onWiped).not.toHaveBeenCalled()
  })

  it('returns an unsubscribe function that removes the same listener', () => {
    const channel = fakeChannel()
    const unsubscribe = listenForLockAndWipe(
      { onLock: vi.fn(), onWiped: vi.fn() },
      channel,
    )
    const listener = registeredListener(channel)

    expect(channel.removeEventListener).not.toHaveBeenCalled()
    unsubscribe()

    expect(channel.removeEventListener).toHaveBeenCalledTimes(1)
    expect(channel.removeEventListener).toHaveBeenCalledWith('message', listener)
  })

  it('returns a harmless function for a null channel', () => {
    const unsubscribe = listenForLockAndWipe(
      { onLock: vi.fn(), onWiped: vi.fn() },
      null,
    )

    expect(() => unsubscribe()).not.toThrow()
  })

  it('uses the default channel when none is passed', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    const onLock = vi.fn()
    listenForLockAndWipe({ onLock, onWiped: vi.fn() })

    registeredListener(channel)(message({ type: 'lock' }))

    expect(onLock).toHaveBeenCalledTimes(1)
  })
})

describe('listenForChanges with the new message types', () => {
  it.each([{ type: 'lock' }, { type: 'wiped' }])(
    'does not invalidate anything for %o',
    (data) => {
      const channel = fakeChannel()
      const queryClient = {
        invalidateQueries: vi.fn<QueryClient['invalidateQueries']>(),
      }
      listenForChanges(queryClient, channel)

      registeredListener(channel)(message(data))

      expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
    },
  )

  it('still invalidates for a changed message', () => {
    const channel = fakeChannel()
    const queryClient = {
      invalidateQueries: vi.fn<QueryClient['invalidateQueries']>(),
    }
    listenForChanges(queryClient, channel)

    registeredListener(channel)(message({ type: 'changed', keys: ['income'] }))

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['income'],
    })
  })
})
