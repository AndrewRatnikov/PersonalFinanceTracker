// No CONTRACT_GAPs: with ENABLE_SPACES off nothing of Family runs (plan "Test
// notes": getSyncRuntime().family and .familyActions are null and no *_space*
// or get_my_space rpc is called). ENABLE_SYNC and accounts are ON so only the
// spaces flag is responsible. The Supabase client is a spy.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { JoinPage } from '@/components/JoinPage'
import { SyncRunner } from '@/components/SyncRunner'
import { OFF_FAMILY_STATE, useFamilyAvailable, useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { getSyncRuntime } from '@/lib/sync/runtime'

const { rpc, store } = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: new Map<string, unknown>(),
}))

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: true, ENABLE_SPACES: false }))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountsVisible: () => true,
  useAccountSession: () => ({ userId: 'user-1', email: 'ann@example.com' }),
}))
vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => ({ rpc }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(store.get(key)),
  getMany: (list: Array<string>) => Promise.resolve(list.map((k) => store.get(k))),
  set: (key: string, value: unknown) => {
    store.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    for (const [k, v] of entries) store.set(k, v)
    return Promise.resolve()
  },
  del: (key: string) => {
    store.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    store.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(store.keys())),
}))

function Probe() {
  const family = useFamilySyncState()
  const available = useFamilyAvailable()
  const forSpace = useSyncState('space-1')
  return (
    <output
      data-family-status={family.status}
      data-family-available={String(available)}
      data-for-space={forSpace.status}
    />
  )
}

function renderAll() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <SyncRunner unlocked />
      <Probe />
      <JoinPage />
    </QueryClientProvider>,
  )
}

const SPACE_RPC = /space|get_my_space|invite|join/

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  window.history.replaceState(null, '', '/join#00000000-0000-4000-8000-000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('ENABLE_SPACES off', () => {
  it('the runtime has no Family stream and no Family actions', () => {
    const runtime = getSyncRuntime()

    expect(runtime.family).toBeNull()
    expect(runtime.familyActions).toBeNull()
    expect(runtime.engine).toBeTruthy()
  })

  it('a full cycle calls no space function', async () => {
    const runtime = getSyncRuntime()
    rpc.mockResolvedValue({ data: null, error: { message: 'MINIMA:not_signed_in' }, status: 401 })

    await runtime.engine.runCycle({ reason: 'manual' }).catch(() => undefined)

    const names = rpc.mock.calls.map((c) => String(c[0]))
    expect(names.filter((n) => SPACE_RPC.test(n))).toEqual([])
  })

  it('the hooks report Family as unavailable without touching the runtime', () => {
    const { container } = renderAll()

    const probe = container.querySelector('output')
    expect(probe?.getAttribute('data-family-available')).toBe('false')
    expect(probe?.getAttribute('data-family-status')).toBe(OFF_FAMILY_STATE.status)
    expect(probe?.getAttribute('data-for-space')).toBe(OFF_FAMILY_STATE.status)
    expect(OFF_FAMILY_STATE.status).toBe('none')
  })

  it('/join shows only "Not available", no invite text, no error', () => {
    renderAll()

    expect(screen.getByTestId('join-not-available')).toBeTruthy()
    expect(screen.queryByTestId('join-invalid')).toBeNull()
    expect(screen.queryByTestId('join-error')).toBeNull()
    expect(screen.queryByTestId('join-invite-info')).toBeNull()
    expect(screen.queryByTestId('join-ask-btn')).toBeNull()
  })

  it('/join does not read or consume the address bar fragment and makes no call', () => {
    const before = window.location.hash
    renderAll()

    expect(before.length).toBeGreaterThan(10)
    expect(window.location.hash).toBe(before)
    expect(sessionStorage.getItem('minima_pending_invite')).toBeNull()
    const names = rpc.mock.calls.map((c) => String(c[0]))
    expect(names.filter((n) => SPACE_RPC.test(n))).toEqual([])
  })

  it('the Supabase client is never asked for a space function', () => {
    renderAll()

    const names = rpc.mock.calls.map((c) => String(c[0]))
    expect(names.filter((n) => /_space|get_my_space/.test(n))).toEqual([])
  })
})
