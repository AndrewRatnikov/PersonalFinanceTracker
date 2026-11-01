import { useSyncExternalStore } from 'react'

/** Tailwind `md`: the settings sidebar layout starts here. */
export const DESKTOP_QUERY = '(min-width: 768px)'

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {}
  const mql = window.matchMedia(DESKTOP_QUERY)
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }
  // Safari < 14.
  mql.addListener(onChange)
  return () => mql.removeListener(onChange)
}

function getSnapshot(): boolean {
  return hasMatchMedia() && window.matchMedia(DESKTOP_QUERY).matches
}

function getServerSnapshot(): boolean {
  return false
}

/**
 * True from the `md` breakpoint up. False on the server and when
 * `window.matchMedia` is missing (jsdom without a mock), so those render the
 * phone layout.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
