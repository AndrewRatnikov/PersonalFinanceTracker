// No CONTRACT_GAPs: the root beforeLoad behaviour is fully specified in the
// Interface Contract (Root route). This file replaces the offline-identity
// tests: the root route no longer has any auth requirement, so those cases
// (cached user, redirect to /login) are removed by design and replaced by the
// no-auth / no-vault-redirect cases.

import { isRedirect } from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getVaultState } from '@/lib/vault'
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
  getLocalStore: vi.fn(),
  getLocalDbKey: vi.fn(),
}))

vi.mock('@/lib/vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/vault')>()
  return { ...actual, getVaultState: vi.fn() }
})

const DATA_PATHS = ['/transactions', '/analytics', '/income', '/settings']
const OPEN_PATHS = ['/', '/login', '/auth/callback', '/profile']

async function runBeforeLoad(pathname: string): Promise<unknown> {
  const beforeLoad = Route.options.beforeLoad as unknown as (ctx: {
    location: { pathname: string; href: string }
  }) => Promise<unknown>
  return beforeLoad({ location: { pathname, href: pathname } })
}

async function thrownBy(pathname: string): Promise<unknown> {
  try {
    await runBeforeLoad(pathname)
  } catch (err) {
    return err
  }
  return undefined
}

beforeEach(() => {
  localStorage.clear()
  getServerUser.mockReset()
  vi.mocked(getVaultState).mockReset()
})

describe('root beforeLoad without a vault', () => {
  it.each(DATA_PATHS)('redirects %s to / and never to /login', async (path) => {
    vi.mocked(getVaultState).mockResolvedValue('none')

    const err = await thrownBy(path)

    expect(isRedirect(err)).toBe(true)
    expect((err as { options: { to: string } }).options.to).toBe('/')
  })

  it('redirects a data sub-route too', async () => {
    vi.mocked(getVaultState).mockResolvedValue('none')

    const err = await thrownBy('/settings/security')

    expect(isRedirect(err)).toBe(true)
  })

  it.each(OPEN_PATHS)('lets %s through', async (path) => {
    vi.mocked(getVaultState).mockResolvedValue('none')

    await expect(runBeforeLoad(path)).resolves.toBeUndefined()
  })
})

describe('root beforeLoad with a vault', () => {
  it.each(['v1', 'v2', 'orphaned'] as const)(
    "lets every data route through when the vault state is '%s'",
    async (state) => {
      vi.mocked(getVaultState).mockResolvedValue(state)

      for (const path of DATA_PATHS) {
        await expect(runBeforeLoad(path)).resolves.toBeUndefined()
      }
    },
  )

  it('does not redirect when the vault state check fails', async () => {
    vi.mocked(getVaultState).mockRejectedValue(new Error('idb unavailable'))

    for (const path of DATA_PATHS) {
      await expect(runBeforeLoad(path)).resolves.toBeUndefined()
    }
  })

  it('returns no auth context', async () => {
    vi.mocked(getVaultState).mockResolvedValue('v2')

    expect(await runBeforeLoad('/transactions')).toBeUndefined()
  })
})

describe('root beforeLoad has no auth requirement', () => {
  it('never calls getServerUser, whatever the route or vault state', async () => {
    for (const state of ['none', 'v2'] as const) {
      vi.mocked(getVaultState).mockResolvedValue(state)
      for (const path of [...DATA_PATHS, ...OPEN_PATHS]) {
        await thrownBy(path)
      }
    }

    expect(getServerUser).not.toHaveBeenCalled()
  })

  it('does not touch the cached offline user key', async () => {
    localStorage.setItem('minima_offline_user', '{"id":"u1"}')
    vi.mocked(getVaultState).mockResolvedValue('v2')

    await runBeforeLoad('/transactions')

    expect(localStorage.getItem('minima_offline_user')).toBe('{"id":"u1"}')
  })
})
