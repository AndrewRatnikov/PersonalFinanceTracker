// No CONTRACT_GAPs: useSyncStatus / hasFeature / FeatureGate and their
// dependencies are specified in plan section 8 and the Interface Contract
// (module: entitlements). FeatureGate output is found by text (no testids are
// declared for it): the children render "gate-child", the fallback "gate-fallback".

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as Api from '@/lib/cloud/api'

import type { SyncStatus } from '@/lib/cloud/types'
import { useAccountSession } from '@/lib/accountSession'
import { toCloudError } from '@/lib/cloud/api'
import {
  FeatureGate,
  SYNC_STATUS_QUERY_KEY,
  hasFeature,
  useSyncStatus,
} from '@/lib/cloud/entitlements'
import { useOnlineStatus } from '@/lib/useOnlineStatus'

const { getSyncStatus } = vi.hoisted(() => ({ getSyncStatus: vi.fn() }))

vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/useOnlineStatus', () => ({ useOnlineStatus: vi.fn() }))
vi.mock('@/lib/cloud/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  createCloudApi: () => ({
    getSyncStatus: (...args: Array<unknown>) => getSyncStatus(...args) as unknown,
  }),
}))

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    plan_id: 'beta',
    has_sync: true,
    free_for_all: true,
    granted_by: 'free_for_all',
    beta_joined_at: null,
    entitlement_status: null,
    current_period_end: null,
    limits: { sync: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
    vault: null,
    devices_count: 0,
    ...overrides,
  }
}

const FREE = status({
  plan_id: 'free',
  has_sync: false,
  free_for_all: false,
  granted_by: 'default',
  limits: { sync: false, max_devices: 0, max_records: 0, max_bytes: 0 },
})

let client: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const SESSION = { userId: 'user-1', email: 'ann@example.com' }

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(useAccountSession).mockReturnValue(SESSION)
  vi.mocked(useOnlineStatus).mockReturnValue(true)
  getSyncStatus.mockResolvedValue(status())
})

afterEach(() => {
  cleanup()
})

describe('hasFeature', () => {
  it('is true only when limits.sync is true', () => {
    expect(hasFeature(status(), 'sync')).toBe(true)
    expect(hasFeature(FREE, 'sync')).toBe(false)
  })

  it('is false for a missing status', () => {
    expect(hasFeature(null, 'sync')).toBe(false)
    expect(hasFeature(undefined, 'sync')).toBe(false)
  })

  it('reads the feature flag, not the plan id or has_sync', () => {
    const paidButNoSync = status({
      plan_id: 'sync',
      has_sync: true,
      limits: { sync: false, max_devices: 10, max_records: 1, max_bytes: 1 },
    })
    expect(hasFeature(paidButNoSync, 'sync')).toBe(false)

    const freeButFlagged = status({
      plan_id: 'free',
      has_sync: false,
      limits: { sync: true, max_devices: 1, max_records: 1, max_bytes: 1 },
    })
    expect(hasFeature(freeButFlagged, 'sync')).toBe(true)
  })
})

describe('useSyncStatus', () => {
  it('uses the key ["sync-status"]', () => {
    expect(SYNC_STATUS_QUERY_KEY).toEqual(['sync-status'])
  })

  it('is signed-out without a session and never calls the server', async () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    expect(result.current).toEqual({ state: 'signed-out' })
    await Promise.resolve()
    expect(getSyncStatus).not.toHaveBeenCalled()
  })

  it('treats an undefined session as signed-out too', () => {
    vi.mocked(useAccountSession).mockReturnValue(undefined as never)
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    expect(result.current.state).toBe('signed-out')
    expect(getSyncStatus).not.toHaveBeenCalled()
  })

  it('is offline when signed in but offline, and never calls the server', async () => {
    vi.mocked(useOnlineStatus).mockReturnValue(false)
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    expect(result.current).toEqual({ state: 'offline' })
    await Promise.resolve()
    expect(getSyncStatus).not.toHaveBeenCalled()
  })

  it('loads, then is ready with the server status', async () => {
    const beta = status()
    getSyncStatus.mockResolvedValue(beta)
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    expect(result.current.state).toBe('loading')
    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })
    expect(result.current).toEqual({ state: 'ready', status: beta })
    expect(getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('shows a different status when the server returns a different one', async () => {
    getSyncStatus.mockResolvedValue(FREE)
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })
    expect(result.current).toEqual({ state: 'ready', status: FREE })
  })

  it('caches under ["sync-status"] with a 5 minute staleTime', async () => {
    const { result } = renderHook(() => useSyncStatus(), { wrapper })
    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })

    expect(client.getQueryData(['sync-status'])).toEqual(status())
    const query = client.getQueryCache().find({ queryKey: ['sync-status'] })
    expect(query).toBeTruthy()
    expect(query?.observers[0].options.staleTime).toBe(5 * 60_000)
  })

  it('does not refetch when mounted again within 5 minutes', async () => {
    const first = renderHook(() => useSyncStatus(), { wrapper })
    await waitFor(() => {
      expect(first.result.current.state).toBe('ready')
    })
    first.unmount()

    const second = renderHook(() => useSyncStatus(), { wrapper })

    expect(second.result.current.state).toBe('ready')
    await Promise.resolve()
    expect(getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('starts fetching when the device comes back online', async () => {
    vi.mocked(useOnlineStatus).mockReturnValue(false)
    const { result, rerender } = renderHook(() => useSyncStatus(), { wrapper })
    expect(result.current.state).toBe('offline')

    vi.mocked(useOnlineStatus).mockReturnValue(true)
    rerender()

    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })
    expect(getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('reports a CloudError and retry() fetches again', async () => {
    const failure = toCloudError({ message: 'MINIMA:device_limit', code: 'P0001' })
    getSyncStatus.mockRejectedValueOnce(failure)
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    await waitFor(() => {
      expect(result.current.state).toBe('error')
    })
    const view = result.current
    if (view.state !== 'error') throw new Error('expected error state')
    expect(view.error).toBe(failure)
    expect(view.error.code).toBe('device_limit')
    // retry: false, so the failed request is not repeated by itself.
    expect(getSyncStatus).toHaveBeenCalledTimes(1)

    getSyncStatus.mockResolvedValue(FREE)
    view.retry()

    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })
    expect(getSyncStatus).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ state: 'ready', status: FREE })
  })

  it('removes the cached status when the session goes away', async () => {
    const { result, rerender } = renderHook(() => useSyncStatus(), { wrapper })
    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })
    expect(client.getQueryData(['sync-status'])).toBeTruthy()

    vi.mocked(useAccountSession).mockReturnValue(null)
    rerender()

    expect(result.current.state).toBe('signed-out')
    await waitFor(() => {
      expect(client.getQueryData(['sync-status'])).toBeUndefined()
    })
  })

  it('does not show the previous account status to the next signed-in user', async () => {
    getSyncStatus.mockResolvedValue(status())
    const { result, rerender } = renderHook(() => useSyncStatus(), { wrapper })
    await waitFor(() => {
      expect(result.current.state).toBe('ready')
    })

    vi.mocked(useAccountSession).mockReturnValue(null)
    rerender()
    await waitFor(() => {
      expect(client.getQueryData(['sync-status'])).toBeUndefined()
    })

    getSyncStatus.mockResolvedValue(FREE)
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'user-2', email: 'bob@example.com' })
    rerender()

    await waitFor(() => {
      expect(result.current).toEqual({ state: 'ready', status: FREE })
    })
    expect(getSyncStatus).toHaveBeenCalledTimes(2)
  })
})

describe('FeatureGate', () => {
  function gate(fallback?: ReactNode) {
    return render(
      <FeatureGate feature="sync" fallback={fallback}>
        <span>gate-child</span>
      </FeatureGate>,
      { wrapper },
    )
  }

  it('renders the children when the status is ready and has the feature', async () => {
    getSyncStatus.mockResolvedValue(status())
    gate(<span>gate-fallback</span>)

    await waitFor(() => {
      expect(screen.getByText('gate-child')).toBeTruthy()
    })
    expect(screen.queryByText('gate-fallback')).toBeNull()
  })

  it('renders the fallback when the feature is missing', async () => {
    getSyncStatus.mockResolvedValue(FREE)
    gate(<span>gate-fallback</span>)

    await waitFor(() => {
      expect(getSyncStatus).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText('gate-fallback')).toBeTruthy()
    })
    expect(screen.queryByText('gate-child')).toBeNull()
  })

  it('renders the fallback while loading', () => {
    getSyncStatus.mockReturnValue(new Promise(() => {}))
    gate(<span>gate-fallback</span>)

    expect(screen.getByText('gate-fallback')).toBeTruthy()
    expect(screen.queryByText('gate-child')).toBeNull()
  })

  it('renders the fallback when signed out, offline or on error', async () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    const signedOut = gate(<span>gate-fallback</span>)
    expect(screen.getByText('gate-fallback')).toBeTruthy()
    expect(screen.queryByText('gate-child')).toBeNull()
    signedOut.unmount()

    vi.mocked(useAccountSession).mockReturnValue(SESSION)
    vi.mocked(useOnlineStatus).mockReturnValue(false)
    const offline = gate(<span>gate-fallback</span>)
    expect(screen.getByText('gate-fallback')).toBeTruthy()
    expect(screen.queryByText('gate-child')).toBeNull()
    offline.unmount()

    vi.mocked(useOnlineStatus).mockReturnValue(true)
    getSyncStatus.mockRejectedValue(toCloudError({ message: 'MINIMA:no_vault' }))
    gate(<span>gate-fallback</span>)
    await waitFor(() => {
      expect(getSyncStatus).toHaveBeenCalled()
    })
    expect(screen.queryByText('gate-child')).toBeNull()
    await waitFor(() => {
      expect(screen.getByText('gate-fallback')).toBeTruthy()
    })
  })

  it('renders nothing by default when the gate is closed', () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    const { container } = gate()

    expect(container.textContent).toBe('')
  })
})
