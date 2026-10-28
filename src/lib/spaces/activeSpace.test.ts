// CONTRACT_GAP: what setActiveSpaceId does for an empty string is not part of
//   the Interface Contract (the plan says "any non-empty string"); only the
//   non-empty case is tested.
//
// The keyring is driven directly with setKeyring / clearKeyring; no localDb.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HeldSpace } from '@/lib/spaces/keyring'
import {
  ACTIVE_SPACE_STORAGE_KEY,
  getActiveSpaceId,
  setActiveSpaceId,
  subscribeActiveSpace,
} from '@/lib/spaces/activeSpace'
import { clearKeyring, setKeyring } from '@/lib/spaces/keyring'

const FAMILY = '3f2b1c4e-0000-4000-8000-00000000aaaa'
const OTHER = '3f2b1c4e-0000-4000-8000-00000000bbbb'

async function held(id: string): Promise<HeldSpace> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return {
    id,
    name: 'Home',
    role: 'owner',
    keyVersion: 1,
    keys: [{ keyVersion: 1, key }],
  }
}

beforeEach(() => {
  localStorage.clear()
  clearKeyring()
})

afterEach(() => {
  clearKeyring()
  localStorage.clear()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('storage key', () => {
  it('is minima_active_space', () => {
    expect(ACTIVE_SPACE_STORAGE_KEY).toBe('minima_active_space')
  })
})

describe('getActiveSpaceId', () => {
  it('is personal on a fresh device', () => {
    expect(getActiveSpaceId()).toBe('personal')
  })

  it('returns a held Family space once it is chosen', async () => {
    setKeyring([await held(FAMILY)])

    setActiveSpaceId(FAMILY)

    expect(getActiveSpaceId()).toBe(FAMILY)
  })

  it('persists the choice in localStorage', async () => {
    setKeyring([await held(FAMILY)])

    setActiveSpaceId(FAMILY)

    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(FAMILY)
  })

  it('reads a choice written earlier (another tab or a reload)', async () => {
    setKeyring([await held(FAMILY)])
    localStorage.setItem(ACTIVE_SPACE_STORAGE_KEY, FAMILY)

    expect(getActiveSpaceId()).toBe(FAMILY)
  })

  it('falls back to personal for an unknown id', () => {
    setActiveSpaceId(OTHER)

    expect(getActiveSpaceId()).toBe('personal')
  })

  it('falls back to personal for an id that is not held, while another one is', async () => {
    setKeyring([await held(FAMILY)])

    setActiveSpaceId(OTHER)

    expect(getActiveSpaceId()).toBe('personal')
  })

  it('keeps the stored value on a fallback and uses it again once the space is held', async () => {
    setActiveSpaceId(FAMILY)
    expect(getActiveSpaceId()).toBe('personal')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(FAMILY)

    // The vault is unlocked and the keyring loads.
    setKeyring([await held(FAMILY)])

    expect(getActiveSpaceId()).toBe(FAMILY)
  })

  it('falls back to personal after the keyring is cleared (lock), keeping the choice', async () => {
    setKeyring([await held(FAMILY)])
    setActiveSpaceId(FAMILY)
    expect(getActiveSpaceId()).toBe(FAMILY)

    clearKeyring()

    expect(getActiveSpaceId()).toBe('personal')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(FAMILY)
  })

  it('personal can be chosen again', async () => {
    setKeyring([await held(FAMILY)])
    setActiveSpaceId(FAMILY)

    setActiveSpaceId('personal')

    expect(getActiveSpaceId()).toBe('personal')
  })
})

describe('subscribeActiveSpace', () => {
  it('notifies a subscriber on every change', async () => {
    setKeyring([await held(FAMILY)])
    const listener = vi.fn()
    subscribeActiveSpace(listener)

    setActiveSpaceId(FAMILY)
    expect(listener).toHaveBeenCalledTimes(1)

    setActiveSpaceId('personal')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying after the returned cleanup runs', () => {
    const listener = vi.fn()
    const off = subscribeActiveSpace(listener)

    off()
    setActiveSpaceId('personal')

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not call a listener that subscribed after a change', () => {
    setActiveSpaceId('personal')
    const late = vi.fn()

    subscribeActiveSpace(late)

    expect(late).not.toHaveBeenCalled()
  })
})

describe('ENABLE_SPACES', () => {
  async function loadFlag(): Promise<boolean> {
    vi.resetModules()
    const mod = await import('@/lib/featureFlags')
    return mod.ENABLE_SPACES
  }

  it('is off when VITE_ENABLE_SPACES is not set', async () => {
    vi.stubEnv('VITE_ENABLE_SPACES', '')

    expect(await loadFlag()).toBe(false)
  })

  it('is off for any value other than "true"', async () => {
    vi.stubEnv('VITE_ENABLE_SPACES', '1')

    expect(await loadFlag()).toBe(false)
  })

  it('is on for "true"', async () => {
    vi.stubEnv('VITE_ENABLE_SPACES', 'true')

    expect(await loadFlag()).toBe(true)
  })
})
