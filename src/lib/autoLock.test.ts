// No CONTRACT_GAPs: startAutoLock signature and test notes are fully specified
// in the Interface Contract (module: autoLock).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startAutoLock } from '@/lib/autoLock'

const MIN = 60_000

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('startAutoLock inactivity timer', () => {
  it('calls onLock exactly once after the timeout', () => {
    const onLock = vi.fn()
    startAutoLock(15, onLock)

    vi.advanceTimersByTime(14 * MIN + 59_000)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(onLock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60 * MIN)
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('honours the configured number of minutes', () => {
    const short = vi.fn()
    const long = vi.fn()
    startAutoLock(1, short)
    startAutoLock(5, long)

    vi.advanceTimersByTime(1 * MIN)
    expect(short).toHaveBeenCalledTimes(1)
    expect(long).not.toHaveBeenCalled()

    vi.advanceTimersByTime(4 * MIN)
    expect(long).toHaveBeenCalledTimes(1)
  })

  it.each(['keydown', 'pointerdown', 'pointermove'])(
    'a %s event at 10 minutes delays the lock',
    (eventName) => {
      const onLock = vi.fn()
      startAutoLock(15, onLock)

      vi.advanceTimersByTime(10 * MIN)
      document.dispatchEvent(new Event(eventName))

      vi.advanceTimersByTime(14 * MIN)
      expect(onLock).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1 * MIN + 1_000)
      expect(onLock).toHaveBeenCalledTimes(1)
    },
  )

  it('never fires for 0 minutes (Off)', () => {
    const onLock = vi.fn()
    const stop = startAutoLock(0, onLock)

    vi.advanceTimersByTime(48 * 60 * MIN)

    expect(onLock).not.toHaveBeenCalled()
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  it('stops firing after the returned cleanup runs', () => {
    const onLock = vi.fn()
    const stop = startAutoLock(15, onLock)

    vi.advanceTimersByTime(5 * MIN)
    stop()
    vi.advanceTimersByTime(60 * MIN)

    expect(onLock).not.toHaveBeenCalled()
  })

  it('ignores activity events after cleanup', () => {
    const onLock = vi.fn()
    const stop = startAutoLock(1, onLock)
    stop()

    document.dispatchEvent(new Event('keydown'))
    vi.advanceTimersByTime(10 * MIN)

    expect(onLock).not.toHaveBeenCalled()
  })

  it('listens on the document passed in', () => {
    const otherDoc = document.implementation.createHTMLDocument('other')
    const onLock = vi.fn()
    startAutoLock(1, onLock, otherDoc)

    vi.advanceTimersByTime(30_000)
    otherDoc.dispatchEvent(new Event('keydown'))
    vi.advanceTimersByTime(50_000)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(20_000)
    expect(onLock).toHaveBeenCalledTimes(1)
  })
})

describe('startAutoLock hidden-tab time', () => {
  it('locks on return when the hidden gap exceeds the timeout, even if timers were throttled', () => {
    const onLock = vi.fn()
    startAutoLock(15, onLock)

    setVisibility('hidden')
    // The clock jumps, but no timer callback runs (throttled background tab).
    vi.setSystemTime(Date.now() + 16 * MIN)
    expect(onLock).not.toHaveBeenCalled()

    setVisibility('visible')

    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('does not lock on return when the hidden gap is shorter than the timeout', () => {
    const onLock = vi.fn()
    startAutoLock(15, onLock)

    setVisibility('hidden')
    vi.setSystemTime(Date.now() + 5 * MIN)
    setVisibility('visible')

    expect(onLock).not.toHaveBeenCalled()
  })

  it('counts becoming visible as activity', () => {
    const onLock = vi.fn()
    startAutoLock(15, onLock)

    vi.advanceTimersByTime(10 * MIN)
    setVisibility('hidden')
    vi.setSystemTime(Date.now() + 2 * MIN)
    setVisibility('visible')

    // 14 minutes after the visible event: still inside the fresh window.
    vi.advanceTimersByTime(14 * MIN)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1 * MIN + 1_000)
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('becoming hidden alone does not reset the inactivity window', () => {
    const onLock = vi.fn()
    startAutoLock(15, onLock)

    vi.advanceTimersByTime(10 * MIN)
    setVisibility('hidden')
    vi.advanceTimersByTime(5 * MIN + 1_000)

    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('does not lock on a visibility change after cleanup', () => {
    const onLock = vi.fn()
    const stop = startAutoLock(15, onLock)
    stop()

    setVisibility('hidden')
    vi.setSystemTime(Date.now() + 60 * MIN)
    setVisibility('visible')

    expect(onLock).not.toHaveBeenCalled()
  })

  it('Off ignores hidden time', () => {
    const onLock = vi.fn()
    startAutoLock(0, onLock)

    setVisibility('hidden')
    vi.setSystemTime(Date.now() + 600 * MIN)
    setVisibility('visible')

    expect(onLock).not.toHaveBeenCalled()
  })
})
