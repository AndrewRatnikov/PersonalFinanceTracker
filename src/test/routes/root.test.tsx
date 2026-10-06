// No CONTRACT_GAPs: the root beforeLoad behaviour (#12) is fully specified in
// the Interface Contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Route } from '@/routes/__root'

const { getServerUser } = vi.hoisted(() => ({ getServerUser: vi.fn() }))

vi.mock('@/lib/auth', () => ({ getServerUser }))

// The real module opens IndexedDB at import time, which jsdom does not have.
vi.mock('@/lib/localDb', () => ({
  initLocalDb: vi.fn(),
  provisionDefaultCategories: vi.fn(),
  unlockLocalDb: vi.fn(),
  clearLocalDb: vi.fn(),
  wipeLocalDbKey: vi.fn(),
}))

const OFFLINE_USER_KEY = 'minima_offline_user'

interface BeforeLoadResult {
  auth: { user: { id: string } | null; isLoading: boolean }
}

async function runBeforeLoad(): Promise<BeforeLoadResult> {
  const beforeLoad = Route.options.beforeLoad as unknown as (ctx: {
    location: { pathname: string; href: string }
  }) => Promise<BeforeLoadResult>
  return beforeLoad({ location: { pathname: '/', href: '/' } })
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
  })
}

describe('root beforeLoad offline identity (#12)', () => {
  beforeEach(() => {
    localStorage.clear()
    getServerUser.mockReset()
  })

  afterEach(() => {
    setOnline(true)
  })

  it('removes the cached offline user when the server says there is no user', async () => {
    localStorage.setItem(OFFLINE_USER_KEY, '{"id":"u1"}')
    getServerUser.mockResolvedValue(null)

    const result = await runBeforeLoad()

    expect(localStorage.getItem(OFFLINE_USER_KEY)).toBeNull()
    expect(result.auth.user).toBeNull()
  })

  it('caches the identity of a signed-in user', async () => {
    getServerUser.mockResolvedValue({ id: 'u2' })

    const result = await runBeforeLoad()

    expect(result.auth.user?.id).toBe('u2')
    expect(localStorage.getItem(OFFLINE_USER_KEY)).toBe('{"id":"u2"}')
  })

  it('rethrows the original error (not a SyntaxError) for a corrupt cache while online', async () => {
    localStorage.setItem(OFFLINE_USER_KEY, '{corrupt')
    getServerUser.mockRejectedValue(new Error('network down'))
    setOnline(true)

    await expect(runBeforeLoad()).rejects.toThrow('network down')
  })

  it('resolves with no user for a corrupt cache while offline', async () => {
    localStorage.setItem(OFFLINE_USER_KEY, '{corrupt')
    getServerUser.mockRejectedValue(new Error('network down'))
    setOnline(false)

    const result = await runBeforeLoad()

    expect(result.auth.user).toBeNull()
  })

  it('still falls back to a valid cached user when the server request fails', async () => {
    localStorage.setItem(OFFLINE_USER_KEY, '{"id":"u1"}')
    getServerUser.mockRejectedValue(new Error('network down'))

    const result = await runBeforeLoad()

    expect(result.auth.user?.id).toBe('u1')
  })
})
