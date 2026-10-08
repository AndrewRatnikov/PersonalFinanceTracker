// No CONTRACT_GAPs: accountSession exports and test notes are fully specified
// in the Interface Contract (module: accountSession).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import {
  ACCOUNT_SESSION_QUERY_KEY,
  getAccountSession,
  signOutAccount,
  useAccountSession,
  useAccountsVisible,
} from '@/lib/accountSession'

const { mockStore, getSession, signOut, flags } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  getSession: vi.fn(),
  signOut: vi.fn(),
  flags: { enabled: false },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
}))

vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => ({ auth: { getSession, signOut } }),
}))

vi.mock('@/lib/featureFlags', () => ({
  get ENABLE_ACCOUNTS() {
    return flags.enabled
  },
}))

const SESSION = {
  data: {
    session: { user: { id: 'user-1', email: 'ann@example.com' } },
  },
  error: null,
}

let client = new QueryClient()

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.resetAllMocks()
  mockStore.clear()
  localStorage.clear()
  flags.enabled = false
  signOut.mockResolvedValue({ error: null })
})

describe('ACCOUNT_SESSION_QUERY_KEY', () => {
  it("is ['account-session']", () => {
    expect([...ACCOUNT_SESSION_QUERY_KEY]).toEqual(['account-session'])
  })
})

describe('getAccountSession', () => {
  it('maps the local Supabase session to userId and email', async () => {
    getSession.mockResolvedValue(SESSION)

    expect(await getAccountSession()).toEqual({
      userId: 'user-1',
      email: 'ann@example.com',
    })
  })

  it('maps a different session to different values', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-2', email: 'bob@example.com' } } },
      error: null,
    })

    expect(await getAccountSession()).toEqual({
      userId: 'user-2',
      email: 'bob@example.com',
    })
  })

  it('returns null when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })

    expect(await getAccountSession()).toBeNull()
  })

  it('returns null when getSession rejects', async () => {
    getSession.mockRejectedValue(new Error('network down'))

    expect(await getAccountSession()).toBeNull()
  })

  it('returns null when getSession throws synchronously', async () => {
    getSession.mockImplementation(() => {
      throw new Error('no client')
    })

    expect(await getAccountSession()).toBeNull()
  })
})

describe('signOutAccount', () => {
  it('calls supabase signOut', async () => {
    await signOutAccount()

    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('leaves IndexedDB data and minima_ keys intact', async () => {
    mockStore.set('meta:vault', { v: 2 })
    mockStore.set('income', new Uint8Array([1, 2, 3]))
    localStorage.setItem('minima_pref', 'keep')
    localStorage.setItem('minima_offline_user', '{"id":"u1"}')

    await signOutAccount()

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(Array.from(mockStore.keys()).sort()).toEqual(['income', 'meta:vault'])
    expect(mockStore.get('meta:vault')).toEqual({ v: 2 })
    expect(localStorage.getItem('minima_pref')).toBe('keep')
    expect(localStorage.getItem('minima_offline_user')).toBe('{"id":"u1"}')
  })
})

describe('useAccountSession', () => {
  it('returns null until a session loads, then the session', async () => {
    getSession.mockResolvedValue(SESSION)
    const { result } = renderHook(() => useAccountSession(), { wrapper })

    expect(result.current).toBeNull()
    await waitFor(() => {
      expect(result.current).toEqual({
        userId: 'user-1',
        email: 'ann@example.com',
      })
    })
  })

  it('stays null with no session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })
    const { result } = renderHook(() => useAccountSession(), { wrapper })

    await waitFor(() => {
      expect(getSession).toHaveBeenCalled()
    })
    expect(result.current).toBeNull()
  })
})

describe('useAccountsVisible', () => {
  it('is false with the flag off and no session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })
    const { result } = renderHook(() => useAccountsVisible(), { wrapper })

    await waitFor(() => {
      expect(getSession).toHaveBeenCalled()
    })
    expect(result.current).toBe(false)
  })

  it('is true with the flag on and no session', () => {
    flags.enabled = true
    getSession.mockResolvedValue({ data: { session: null }, error: null })
    const { result } = renderHook(() => useAccountsVisible(), { wrapper })

    expect(result.current).toBe(true)
  })

  it('is true with the flag off once a session exists', async () => {
    getSession.mockResolvedValue(SESSION)
    const { result } = renderHook(() => useAccountsVisible(), { wrapper })

    await waitFor(() => {
      expect(result.current).toBe(true)
    })
  })
})
