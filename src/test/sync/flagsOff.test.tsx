// No CONTRACT_GAPs: with ENABLE_SYNC off nothing of sync runs (criterion 1,
// plan section 0 "Ground rules"). The Supabase client is a spy, so "no cloud
// function is called" is observable; the sync runtime is wrapped so "never
// built" is observable too. The account session says "signed in, accounts
// visible" so only the sync flag is responsible for the silence.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeModule from '@/lib/sync/runtime'
import type { ReactNode } from 'react'

import { SyncAvailable } from '@/components/SyncAvailable'
import { SyncIndicator } from '@/components/SyncIndicator'
import { SyncRunner } from '@/components/SyncRunner'
import { CreateVaultScreen } from '@/components/vault/CreateVaultScreen'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { OFF_SYNC_STATE, useSyncAvailable, useSyncState } from '@/lib/sync/react'
import { consumeSyncRestoreRequest, requestSyncRestoreFromUrl } from '@/lib/sync/restoreRequest'
import { createBrowserSupabaseClient } from '@/lib/supabase'

const { rpc, store } = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: new Map<string, unknown>(),
}))

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: false }))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountsVisible: () => true,
  useAccountSession: () => ({ userId: 'user-1', email: 'ann@example.com' }),
}))
vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: vi.fn(() => ({ rpc })),
}))
vi.mock('@/lib/sync/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>()
  return { ...actual, getSyncRuntime: vi.fn(actual.getSyncRuntime) }
})
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(store.get(key)),
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
  const state = useSyncState()
  const available = useSyncAvailable()
  return <output data-probe-status={state.status} data-probe-available={String(available)} />
}

function renderAll(unlocked = true) {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <SyncRunner unlocked={unlocked} />
      <SyncIndicator />
      <SyncAvailable fallback={<p>shown without sync</p>}>
        <p>shown only with sync</p>
      </SyncAvailable>
      <Probe />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  consumeSyncRestoreRequest()
})

afterEach(() => {
  cleanup()
})

describe('ENABLE_SYNC off', () => {
  it('builds no runtime and makes no cloud call, even signed in and unlocked', async () => {
    renderAll(true)
    await Promise.resolve()

    expect(getSyncRuntime).not.toHaveBeenCalled()
    expect(createBrowserSupabaseClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('renders no sync UI', () => {
    renderAll(true)

    expect(screen.queryByTestId('header-sync-indicator')).toBeNull()
    expect(screen.queryByText('shown only with sync')).toBeNull()
    expect(screen.getByText('shown without sync')).toBeTruthy()
  })

  it('the hooks report sync as off and unavailable without touching the runtime', () => {
    const { container } = renderAll(true)

    const probe = container.querySelector('output')
    expect(probe?.getAttribute('data-probe-status')).toBe('off')
    expect(probe?.getAttribute('data-probe-available')).toBe('false')
    expect(OFF_SYNC_STATE.status).toBe('off')
    expect(getSyncRuntime).not.toHaveBeenCalled()
  })

  it('stays silent when the vault locks and unlocks', () => {
    const view = renderAll(false)
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SyncRunner unlocked />
      </QueryClientProvider>,
    )
    expect(getSyncRuntime).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('the create-vault screen shows no restore-from-sync entry', () => {
    render(<CreateVaultScreen onCreated={vi.fn()} onRestoreFromSync={vi.fn()} />)

    expect(screen.getByTestId('create-vault-screen')).toBeTruthy()
    expect(screen.queryByTestId('create-vault-sync-restore')).toBeNull()
  })

  it('a ?restore=sync link requests nothing', () => {
    expect(requestSyncRestoreFromUrl('?restore=sync')).toBe(false)
    expect(consumeSyncRestoreRequest()).toBe(false)
  })
})

describe('importing the sync modules does no work', () => {
  it('loads against partial vault and localDb mocks without throwing', async () => {
    vi.resetModules()
    vi.doMock('@/lib/vault', () => ({}))
    vi.doMock('@/lib/localDb', () => ({}))

    const loaded = await Promise.all([
      import('@/lib/sync/syncMeta'),
      import('@/lib/sync/ports'),
      import('@/lib/sync/engine'),
      import('@/lib/sync/actions'),
      import('@/lib/sync/runtime'),
      import('@/lib/sync/react'),
      import('@/lib/sync/restoreRequest'),
    ])

    expect(loaded).toHaveLength(7)
    expect(typeof loaded[1].createSyncPorts).toBe('function')
    expect(typeof loaded[2].createSyncEngine).toBe('function')
    expect(rpc).not.toHaveBeenCalled()
    expect(createBrowserSupabaseClient).not.toHaveBeenCalled()
    vi.doUnmock('@/lib/vault')
    vi.doUnmock('@/lib/localDb')
  })
})
