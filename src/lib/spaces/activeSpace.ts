// The space the whole app shows, chosen per device and stored in localStorage
// `minima_active_space`. A stored id that is not 'personal' and not held by the
// keyring (unknown, or not loaded yet while locked) reads as 'personal'; the
// stored value is kept, so the space comes back once its key is loaded.
// The UI keeps the tab's active space in React state (ActiveSpaceRoot in
// switcher.tsx); this stored value is only the shared default (spec §20, §23).

import { isSpaceHeld } from './keyring'
import { PERSONAL_SPACE_ID } from './types'
import type { SpaceId } from './types'

export const ACTIVE_SPACE_STORAGE_KEY = 'minima_active_space'

const listeners = new Set<() => void>()

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function getActiveSpaceId(): SpaceId {
  let stored: string | null = null
  try {
    stored = storage()?.getItem(ACTIVE_SPACE_STORAGE_KEY) ?? null
  } catch {
    stored = null
  }
  if (stored && stored !== PERSONAL_SPACE_ID && isSpaceHeld(stored)) return stored
  return PERSONAL_SPACE_ID
}

export function setActiveSpaceId(spaceId: SpaceId): void {
  if (typeof spaceId !== 'string' || spaceId === '') return
  try {
    storage()?.setItem(ACTIVE_SPACE_STORAGE_KEY, spaceId)
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch (err) {
      console.error('Active space listener failed:', err instanceof Error ? err.name : typeof err)
    }
  }
}

export function subscribeActiveSpace(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The "Open the app in" choice (device-only, meta:settings `openAppIn`). */
export type OpenAppIn = 'last' | 'personal' | 'family'

/**
 * The space a page load starts in. No Family held → personal. The shortcut and
 * "last" follow the last used space (only when it is the held Family);
 * "family" / "personal" open that space.
 */
export function resolveStartSpace(input: {
  openIn: OpenAppIn
  lastUsed: SpaceId
  familyId: string | null
  shortcut: boolean
}): SpaceId {
  const { openIn, lastUsed, familyId, shortcut } = input
  if (familyId === null) return PERSONAL_SPACE_ID
  if (shortcut || openIn === 'last') {
    return lastUsed === familyId ? familyId : PERSONAL_SPACE_ID
  }
  if (openIn === 'family') return familyId
  return PERSONAL_SPACE_ID
}

/** True for the home-screen shortcut URL: /transactions?add=expense without a space param. */
export function isShortcutUrl(pathname: string, search: string): boolean {
  if (pathname.replace(/\/+$/, '') !== '/transactions') return false
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return false
  }
  return params.get('add') === 'expense' && !params.has('space')
}
