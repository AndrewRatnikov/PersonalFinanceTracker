// No CONTRACT_GAPs: SyncIndicator behaviour, attribute values and texts are
// specified in plan section 10 and the Interface Contract (component:
// SyncIndicator). Sync state and availability are fakes; the feature flag is a
// mutable getter.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import type { SyncState, SyncStatusCode } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useSyncAvailable, useSyncState } from '@/lib/sync/react'
import { SyncIndicator } from '@/components/SyncIndicator'

const flags = vi.hoisted(() => ({ sync: true }))

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  get ENABLE_SYNC() {
    return flags.sync
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: Record<string, string>
    children?: ReactNode
    [key: string]: unknown
  }) => (
    <a
      href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}
      {...rest}
    >
      {children}
    </a>
  ),
}))
vi.mock('@/lib/sync/react', () => ({
  useSyncState: vi.fn(),
  useSyncAvailable: vi.fn(),
  OFF_SYNC_STATE: { status: 'off' },
}))

const LANGS: Array<Lang> = ['en', 'uk']

function state(status: SyncStatusCode): SyncState {
  return {
    status,
    lastSyncAt: null,
    progress: null,
    errorCode: null,
    lastError: null,
    deviceId: 'device-1',
  }
}

function show(status: SyncStatusCode, available = true) {
  vi.mocked(useSyncAvailable).mockReturnValue(available)
  vi.mocked(useSyncState).mockReturnValue(state(status))
  return render(<SyncIndicator />)
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  setLang('en', { persist: false })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('when it is hidden', () => {
  it('renders nothing and calls no sync hook with the flag off', () => {
    flags.sync = false
    const { container } = show('synced')
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('header-sync-indicator')).toBeNull()
    expect(useSyncState).not.toHaveBeenCalled()
  })

  it('renders nothing when sync is not available', () => {
    show('synced', false)
    expect(screen.queryByTestId('header-sync-indicator')).toBeNull()
  })

  it('renders nothing while sync is off on this device', () => {
    show('off')
    expect(screen.queryByTestId('header-sync-indicator')).toBeNull()
  })
})

describe('when it is shown', () => {
  const cases: Array<[SyncStatusCode, string]> = [
    ['synced', 'synced'],
    ['syncing', 'syncing'],
    ['offline', 'offline'],
    ['error', 'problem'],
    ['paused', 'problem'],
    ['device-removed', 'problem'],
    ['cloud-deleted', 'problem'],
    ['vault-mismatch', 'problem'],
    ['other-account', 'problem'],
  ]

  it.each(cases)('%s shows as %s', (status, value) => {
    show(status)
    expect(screen.getByTestId('header-sync-indicator').getAttribute('data-sync-indicator')).toBe(value)
  })

  it('is a link to the Sync tab of Settings', () => {
    show('synced')
    const link = screen.getByTestId('header-sync-indicator')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/settings?tab=sync')
  })

  it.each(LANGS)('has an accessible name for every state in %s', (lang) => {
    setLang(lang, { persist: false })
    for (const [status, value] of cases) {
      const view = show(status)
      const link = screen.getByTestId('header-sync-indicator')
      const key = `sync.indicator.${value}` as Parameters<typeof translate>[1]
      expect(link.getAttribute('aria-label'), status).toBe(translate(lang, key))
      expect(link.getAttribute('title'), status).toBe(translate(lang, key))
      view.unmount()
    }
  })

  it('English and Ukrainian names differ, and each state has its own name', () => {
    const names = ['synced', 'syncing', 'offline', 'problem'].map((v) =>
      translate('en', `sync.indicator.${v}` as Parameters<typeof translate>[1]),
    )
    expect(new Set(names).size).toBe(4)
    expect(translate('en', 'sync.indicator.synced')).not.toBe(translate('uk', 'sync.indicator.synced'))
  })

  it('follows the state when it changes', () => {
    const view = show('synced')
    expect(screen.getByTestId('header-sync-indicator').getAttribute('data-sync-indicator')).toBe('synced')
    vi.mocked(useSyncState).mockReturnValue(state('offline'))
    view.rerender(<SyncIndicator />)
    expect(screen.getByTestId('header-sync-indicator').getAttribute('data-sync-indicator')).toBe('offline')
  })
})
