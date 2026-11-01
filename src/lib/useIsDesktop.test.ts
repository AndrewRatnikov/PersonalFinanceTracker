// No CONTRACT_GAPs: DESKTOP_QUERY and useIsDesktop (false without matchMedia and
// on the server, re-renders on a media change event) are specified in the
// Interface Contract (Hook: useIsDesktop). window.matchMedia is replaced by a
// small fake whose "matches" value and listeners the tests control.

import { act, cleanup, renderHook } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_QUERY, useIsDesktop } from '@/lib/useIsDesktop'

type Listener = () => void

interface FakeMedia {
  matches: boolean
  listeners: Set<Listener>
  matchMedia: ReturnType<typeof vi.fn>
  change: (matches: boolean) => void
}

function installMatchMedia(initial: boolean, modern = true): FakeMedia {
  const fake: FakeMedia = {
    matches: initial,
    listeners: new Set<Listener>(),
    matchMedia: vi.fn(),
    change(matches) {
      fake.matches = matches
      act(() => {
        for (const listener of Array.from(fake.listeners)) listener()
      })
    },
  }
  fake.matchMedia.mockImplementation((query: string) => {
    const mql: Record<string, unknown> = {
      get matches() {
        return fake.matches
      },
      media: query,
      onchange: null,
      dispatchEvent: vi.fn(),
    }
    if (modern) {
      mql.addEventListener = (_type: string, l: Listener) => fake.listeners.add(l)
      mql.removeEventListener = (_type: string, l: Listener) => fake.listeners.delete(l)
    } else {
      mql.addListener = (l: Listener) => fake.listeners.add(l)
      mql.removeListener = (l: Listener) => fake.listeners.delete(l)
    }
    return mql
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: fake.matchMedia,
  })
  return fake
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('DESKTOP_QUERY', () => {
  it('is the Tailwind md breakpoint', () => {
    expect(DESKTOP_QUERY).toBe('(min-width: 768px)')
  })
})

describe('useIsDesktop', () => {
  it('is false when window.matchMedia is missing', () => {
    expect(typeof window.matchMedia).not.toBe('function')

    const { result } = renderHook(() => useIsDesktop())

    expect(result.current).toBe(false)
  })

  it('asks matchMedia for the desktop query', () => {
    const fake = installMatchMedia(true)

    renderHook(() => useIsDesktop())

    expect(fake.matchMedia).toHaveBeenCalledWith('(min-width: 768px)')
  })

  it('is true when the query matches and false when it does not', () => {
    installMatchMedia(true)
    const wide = renderHook(() => useIsDesktop())
    expect(wide.result.current).toBe(true)
    wide.unmount()

    installMatchMedia(false)
    const narrow = renderHook(() => useIsDesktop())
    expect(narrow.result.current).toBe(false)
  })

  it('re-renders when the media query changes, in both directions', () => {
    const fake = installMatchMedia(false)
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)

    fake.change(true)
    expect(result.current).toBe(true)

    fake.change(false)
    expect(result.current).toBe(false)
  })

  it('removes its listener on unmount', () => {
    const fake = installMatchMedia(true)
    const { unmount } = renderHook(() => useIsDesktop())
    expect(fake.listeners.size).toBeGreaterThan(0)

    unmount()

    expect(fake.listeners.size).toBe(0)
  })

  it('works with the legacy addListener API', () => {
    const fake = installMatchMedia(false, false)
    const { result, unmount } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)
    expect(fake.listeners.size).toBeGreaterThan(0)

    fake.change(true)
    expect(result.current).toBe(true)

    unmount()
    expect(fake.listeners.size).toBe(0)
  })

  it('renders the phone layout (false) on the server even when the query would match', () => {
    installMatchMedia(true)
    function Probe() {
      return createElement('p', null, String(useIsDesktop()))
    }

    expect(renderToString(createElement(Probe))).toContain('false')
  })
})
