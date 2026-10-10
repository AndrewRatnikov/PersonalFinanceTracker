// No CONTRACT_GAPs: startTabAutoLock, connectOtherTabs, setSyncChannel are all
// specified in the Interface Contract.

import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { reloadToHome } from '@/lib/localWipe'
import { setSyncChannel } from '@/lib/syncChannel'
import { lockVault } from '@/lib/vault'
import {
  cancelCreateVault,
  connectOtherTabs,
  getVaultSession,
  setVaultPhase,
  startTabAutoLock,
} from '@/lib/vaultSession'

vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

// Two endpoints on one bus: a post on one is delivered to the other's listeners.
function fakeBus() {
  const listeners: [Set<(e: MessageEvent) => void>, Set<(e: MessageEvent) => void>] =
    [new Set(), new Set()]
  const posted: [Array<unknown>, Array<unknown>] = [[], []]
  function endpoint(index: 0 | 1): SyncChannel {
    const other = index === 0 ? 1 : 0
    return {
      postMessage: (message) => {
        posted[index].push(message)
        for (const listener of Array.from(listeners[other])) {
          listener(new MessageEvent('message', { data: message }))
        }
      },
      addEventListener: (_type, listener) => {
        listeners[index].add(listener)
      },
      removeEventListener: (_type, listener) => {
        listeners[index].delete(listener)
      },
      close: () => {},
    }
  }
  return { a: endpoint(0), b: endpoint(1), posted }
}

beforeEach(() => {
  vi.mocked(lockVault).mockReset()
  vi.mocked(reloadToHome).mockReset()
  setVaultPhase('checking')
  cancelCreateVault()
})

afterEach(() => {
  vi.useRealTimers()
  setSyncChannel(undefined)
})

describe('startTabAutoLock', () => {
  it('locks its own tab after the idle time and posts no lock message', () => {
    vi.useFakeTimers()
    const channel = fakeChannel()
    setSyncChannel(channel)
    const doc = document.implementation.createHTMLDocument()
    const clear = vi.fn()
    setVaultPhase('unlocked')

    startTabAutoLock(1, { clear }, doc)
    vi.advanceTimersByTime(61_000)

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('does not lock before the idle time has passed', () => {
    vi.useFakeTimers()
    const doc = document.implementation.createHTMLDocument()
    const clear = vi.fn()
    setVaultPhase('unlocked')

    startTabAutoLock(1, { clear }, doc)
    vi.advanceTimersByTime(30_000)

    expect(clear).not.toHaveBeenCalled()
    expect(getVaultSession().phase).toBe('unlocked')
  })

  it('returns a no-op for minutes <= 0 and never locks', () => {
    vi.useFakeTimers()
    const doc = document.implementation.createHTMLDocument()
    const clear = vi.fn()
    setVaultPhase('unlocked')

    const stop = startTabAutoLock(0, { clear }, doc)
    vi.advanceTimersByTime(10 * 60_000)
    stop()

    expect(clear).not.toHaveBeenCalled()
    expect(getVaultSession().phase).toBe('unlocked')
  })

  it('returns a stop function that cancels the pending lock', () => {
    vi.useFakeTimers()
    const doc = document.implementation.createHTMLDocument()
    const clear = vi.fn()
    setVaultPhase('unlocked')

    const stop = startTabAutoLock(1, { clear }, doc)
    stop()
    vi.advanceTimersByTime(5 * 60_000)

    expect(clear).not.toHaveBeenCalled()
  })

  it('uses the global document when none is passed', () => {
    vi.useFakeTimers()
    const clear = vi.fn()
    setVaultPhase('unlocked')

    const stop = startTabAutoLock(1, { clear })
    vi.advanceTimersByTime(61_000)
    stop()

    expect(clear).toHaveBeenCalledTimes(1)
  })
})

describe('two tabs sharing a channel', () => {
  it('locks the idle tab B and leaves the active tab A unlocked after 61 s', () => {
    vi.useFakeTimers()
    const bus = fakeBus()
    const docA = document.implementation.createHTMLDocument()
    const docB = document.implementation.createHTMLDocument()
    const qcA = new QueryClient()
    const qcB = new QueryClient()
    const clearA = vi.spyOn(qcA, 'clear')
    const clearB = vi.spyOn(qcB, 'clear')
    setVaultPhase('unlocked')

    // Tab A: listens to the bus and auto-locks on its own document.
    const onWiped = vi.fn()
    connectOtherTabs(qcA, { channel: bus.a, onWiped })
    startTabAutoLock(1, qcA, docA)
    // Tab B: posts through its endpoint (the default channel) and has no activity.
    setSyncChannel(bus.b)
    startTabAutoLock(1, qcB, docB)

    for (let elapsed = 0; elapsed < 61_000; elapsed += 10_000) {
      docA.dispatchEvent(new Event('keydown'))
      vi.advanceTimersByTime(10_000)
    }
    vi.advanceTimersByTime(1_000)

    expect(clearB).toHaveBeenCalledTimes(1)
    expect(clearA).not.toHaveBeenCalled()
    expect(bus.posted[1]).toEqual([])
    expect(bus.posted[0]).toEqual([])
    expect(onWiped).not.toHaveBeenCalled()
  })

  it('a manual lock from a tab still locks the other tab (contrast)', () => {
    const bus = fakeBus()
    const qcA = new QueryClient()
    const clearA = vi.spyOn(qcA, 'clear')
    setVaultPhase('unlocked')
    connectOtherTabs(qcA, { channel: bus.a })
    setSyncChannel(bus.b)

    // Manual lock path posts { type: 'lock' } through the default channel.
    bus.b.postMessage({ type: 'lock' })

    expect(clearA).toHaveBeenCalledTimes(1)
  })

  it('a wiped message from another tab still locks this tab and calls onWiped', () => {
    const bus = fakeBus()
    const qcA = new QueryClient()
    const clearA = vi.spyOn(qcA, 'clear')
    const onWiped = vi.fn()
    setVaultPhase('unlocked')
    connectOtherTabs(qcA, { channel: bus.a, onWiped })

    bus.b.postMessage({ type: 'wiped' })

    expect(clearA).toHaveBeenCalledTimes(1)
    expect(onWiped).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
  })
})
