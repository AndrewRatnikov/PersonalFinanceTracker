// No CONTRACT_GAPs: SyncTab selectors, states and actions are fully specified in
// plan section 10 and the Interface Contract (component: SyncTab). The engine
// state, the runtime actions, the plan status and the session are fakes; the
// child dialogs and the devices list are replaced by fake-* markers. Texts are
// compared with translate(lang, key) so they do not depend on the wording, and
// every state is checked in English and Ukrainian.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as Entitlements from '@/lib/cloud/entitlements'

import type { Lang } from '@/i18n/lang'
import type { CloudVault, SyncStatus } from '@/lib/cloud/types'
import type { SyncState, SyncStatusCode } from '@/lib/sync/types'
import { formatFullDate, formatNumber, formatTime } from '@/i18n/format'
import { setLang, translate, translatePlural } from '@/i18n/core'
import { useAccountSession } from '@/lib/accountSession'
import { useSyncStatus } from '@/lib/cloud/entitlements'
import { formatBytes } from '@/lib/storagePersistence'
import { useSyncState } from '@/lib/sync/react'
import { SyncTab } from '@/components/settings/SyncTab'

const { toastSuccess, toastError, actions, engine } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  actions: {
    turnOn: vi.fn(),
    uploadAgain: vi.fn(),
    turnOff: vi.fn(),
    syncNow: vi.fn(),
    listDevices: vi.fn(),
    deleteCloudData: vi.fn(),
  },
  engine: { getState: vi.fn(), subscribe: vi.fn(), refreshFromMeta: vi.fn() },
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
    'data-testid'?: string
  }) => (
    <a
      href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}
      data-testid={rest['data-testid']}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountSession: vi.fn(),
  useAccountsVisible: vi.fn(() => true),
}))
vi.mock('@/lib/cloud/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof Entitlements>()),
  useSyncStatus: vi.fn(),
}))
vi.mock('@/lib/sync/react', () => ({
  useSyncState: vi.fn(),
  useSyncAvailable: vi.fn(() => true),
  OFF_SYNC_STATE: { status: 'off' },
}))
vi.mock('@/lib/sync/runtime', () => ({
  getSyncRuntime: () => ({ engine, actions, setUserId: vi.fn() }),
}))
vi.mock('@/components/settings/SyncDevicesList', () => ({
  SyncDevicesList: ({ thisDeviceId }: { thisDeviceId: string | null }) => (
    <div data-testid="fake-sync-devices" data-this-device={thisDeviceId ?? ''} />
  ),
}))
vi.mock('@/components/settings/SyncLinkDialog', () => ({
  SyncLinkDialog: ({
    open,
    cloud,
    onOpenChange,
    onLinked,
  }: {
    open: boolean
    cloud: CloudVault | null
    onOpenChange: (open: boolean) => void
    onLinked: () => void
  }) =>
    open ? (
      <div data-testid="fake-sync-link-dialog" data-cloud-id={cloud?.vault_id ?? ''}>
        <button type="button" onClick={onLinked}>
          fake-linked
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          fake-close
        </button>
      </div>
    ) : null,
}))
vi.mock('@/components/settings/DeleteCloudDataDialog', () => ({
  DeleteCloudDataDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-delete-cloud-dialog" /> : null,
}))

const LANGS: Array<Lang> = ['en', 'uk']
const NOW_ISO = '2026-10-24T09:05:00.000Z'

function plan(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    plan_id: 'beta',
    has_sync: true,
    free_for_all: true,
    granted_by: 'free_for_all',
    beta_joined_at: null,
    entitlement_status: null,
    current_period_end: null,
    limits: { sync: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
    vault: {
      vault_id: 'v1',
      header_rev: 1,
      record_count: 1234,
      total_bytes: 5 * 1024 * 1024,
      last_seq: 1234,
    },
    devices_count: 2,
    ...overrides,
  }
}

const NOT_INCLUDED = plan({
  plan_id: 'free',
  has_sync: false,
  free_for_all: false,
  granted_by: 'default',
  limits: { sync: false, max_devices: 0, max_records: 0, max_bytes: 0 },
  vault: null,
})

function syncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    status: 'synced',
    lastSyncAt: NOW_ISO,
    progress: null,
    errorCode: null,
    lastError: null,
    deviceId: 'device-1',
    ...overrides,
  }
}

function cloudVault(id: string): CloudVault {
  return {
    vault_id: id,
    header_rev: 2,
    header: {
      v: 2,
      vaultId: id,
      createdAt: '2026-10-01T00:00:00.000Z',
      kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==' },
      wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
      recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
      verifier: { iv: 'aXY=', ct: 'Y3Q=' },
    },
  }
}

let client = new QueryClient()

function renderTab() {
  return render(
    <QueryClientProvider client={client}>
      <SyncTab />
    </QueryClientProvider>,
  )
}

function setup(
  state: Partial<SyncState> = {},
  status: SyncStatus | null = plan(),
  signedIn = true,
) {
  vi.mocked(useAccountSession).mockReturnValue(
    signedIn ? { userId: 'user-1', email: 'ann@example.com' } : null,
  )
  vi.mocked(useSyncStatus).mockReturnValue(
    status ? { state: 'ready', status } : { state: 'loading' },
  )
  vi.mocked(useSyncState).mockReturnValue(syncState(state))
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent.trim()
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  setLang('en', { persist: false })
  actions.turnOn.mockResolvedValue({ kind: 'created', pushed: 3 })
  actions.uploadAgain.mockResolvedValue({ kind: 'created', pushed: 3 })
  actions.turnOff.mockResolvedValue(undefined)
  actions.syncNow.mockResolvedValue({ ran: true })
  actions.deleteCloudData.mockResolvedValue(undefined)
  actions.listDevices.mockResolvedValue([])
  engine.refreshFromMeta.mockResolvedValue(syncState())
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('signed out', () => {
  it.each(LANGS)('shows only the sign-in card in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'off' }, null, false)
    renderTab()

    expect(screen.getByTestId('sync-tab')).toBeTruthy()
    expect(screen.getByTestId('sync-sign-in-card')).toBeTruthy()
    expect(screen.getByTestId('sync-sign-in-card').textContent).toContain(
      translate(lang, 'sync.signIn.title'),
    )
    expect(screen.getByTestId('sync-sign-in-card').textContent).toContain(
      translate(lang, 'sync.signIn.body'),
    )
    expect(text('sync-sign-in-link')).toBe(translate(lang, 'settings.account.signInGoogle'))
    expect(screen.queryByTestId('sync-status-card')).toBeNull()
    expect(screen.queryByTestId('sync-turn-on-btn')).toBeNull()
  })

  it('the sign-in link goes to /login and comes back to the Sync tab', () => {
    setup({ status: 'off' }, null, false)
    renderTab()

    const href = screen.getByTestId('sync-sign-in-link').getAttribute('href') ?? ''
    expect(href.startsWith('/login?')).toBe(true)
    expect(new URLSearchParams(href.split('?')[1]).get('redirect')).toBe('/settings?tab=sync')
  })
})

describe('the plan status', () => {
  it('shows a loading marker while the plan is loading', () => {
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'u', email: 'a@b.co' })
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'loading' })
    vi.mocked(useSyncState).mockReturnValue(syncState({ status: 'off' }))
    renderTab()

    expect(screen.getByTestId('sync-plan-loading')).toBeTruthy()
    expect(screen.queryByTestId('sync-turn-on-btn')).toBeNull()
  })

  it('shows an offline marker', () => {
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'u', email: 'a@b.co' })
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'offline' })
    vi.mocked(useSyncState).mockReturnValue(syncState({ status: 'off' }))
    renderTab()

    expect(screen.getByTestId('sync-plan-offline')).toBeTruthy()
    expect(screen.queryByTestId('sync-plan-loading')).toBeNull()
  })

  it('offline with sync on still shows the status card', () => {
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'u', email: 'a@b.co' })
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'offline' })
    vi.mocked(useSyncState).mockReturnValue(syncState({ status: 'offline' }))
    renderTab()

    expect(screen.getByTestId('sync-plan-offline')).toBeTruthy()
    expect(screen.getByTestId('sync-status-card')).toBeTruthy()
  })

  it('shows an error marker with a retry button that retries', () => {
    const retry = vi.fn()
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'u', email: 'a@b.co' })
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'error',
      error: new Error('x') as never,
      retry,
    })
    vi.mocked(useSyncState).mockReturnValue(syncState({ status: 'off' }))
    renderTab()

    expect(screen.getByTestId('sync-plan-error')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sync-plan-retry-btn'))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it.each(LANGS)('not included and sync off shows only the not-included note in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'off' }, NOT_INCLUDED)
    renderTab()

    expect(text('sync-not-included')).toBe(translate(lang, 'cloud.plan.notIncluded'))
    expect(screen.queryByTestId('sync-status-card')).toBeNull()
    expect(screen.queryByTestId('sync-turn-on-btn')).toBeNull()
    expect(screen.queryByTestId('sync-delete-cloud-btn')).toBeNull()
  })

  it('not included but sync still on locally keeps the status card (paused)', () => {
    setup({ status: 'paused' }, NOT_INCLUDED)
    renderTab()

    expect(screen.queryByTestId('sync-not-included')).toBeNull()
    expect(screen.getByTestId('sync-status-card')).toBeTruthy()
    expect(text('sync-status-line')).toBe(translate('en', 'sync.state.paused'))
  })
})

describe('the status line', () => {
  const lines: Array<[SyncStatusCode, Parameters<typeof translate>[1]]> = [
    ['off', 'sync.state.off'],
    ['syncing', 'sync.state.syncing'],
    ['synced', 'sync.state.synced'],
    ['offline', 'sync.state.offline'],
    ['paused', 'sync.state.paused'],
    ['device-removed', 'sync.state.deviceRemoved'],
    ['cloud-deleted', 'sync.state.cloudDeleted'],
    ['vault-mismatch', 'sync.state.vaultMismatch'],
    ['other-account', 'sync.state.otherAccount'],
  ]

  it.each(LANGS)('has the right text for every state in %s', (lang) => {
    setLang(lang, { persist: false })
    for (const [status, key] of lines) {
      setup({ status })
      const view = renderTab()
      expect(text('sync-status-line'), status).toBe(translate(lang, key))
      view.unmount()
    }
  })

  it('English and Ukrainian texts differ', () => {
    for (const [status, key] of lines) {
      expect(translate('en', key), status).not.toBe(translate('uk', key))
    }
  })

  it.each(LANGS)('error shows the code in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'error', errorCode: 'network' })
    renderTab()
    expect(text('sync-status-line')).toBe(translate(lang, 'sync.state.error', { code: 'network' }))
    expect(text('sync-status-line')).toContain('network')
  })

  it('a different error code gives a different text', () => {
    setup({ status: 'error', errorCode: 'quota_exceeded' })
    renderTab()
    expect(text('sync-status-line')).toContain('quota_exceeded')
    expect(text('sync-status-line')).not.toContain('network')
  })

  it.each(LANGS)('not_signed_in reads as signed out in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'error', errorCode: 'not_signed_in' })
    renderTab()
    expect(text('sync-status-line')).toBe(translate(lang, 'sync.state.signedOut'))
  })
})

describe('progress, last sync and skipped records', () => {
  it.each(LANGS)('shows the upload progress while syncing in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'syncing', progress: { phase: 'push', done: 5, total: 20 } })
    renderTab()
    expect(text('sync-progress')).toContain(
      translate(lang, 'sync.progress.upload', { done: 5, total: 20 }),
    )
  })

  it('a different progress gives a different text', () => {
    setup({ status: 'syncing', progress: { phase: 'push', done: 9, total: 20 } })
    renderTab()
    expect(text('sync-progress')).toContain(translate('en', 'sync.progress.upload', { done: 9, total: 20 }))
    expect(text('sync-progress')).not.toContain(translate('en', 'sync.progress.upload', { done: 5, total: 20 }))
  })

  it.each(LANGS)('shows the download progress for a pull in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'syncing', progress: { phase: 'pull', done: 7, total: null } })
    renderTab()
    expect(text('sync-progress')).toContain(translate(lang, 'sync.progress.download', { done: 7 }))
  })

  it('shows no progress when not syncing', () => {
    setup({ status: 'synced' })
    renderTab()
    expect(screen.queryByTestId('sync-progress')).toBeNull()
  })

  it.each(LANGS)('shows the last sync time in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ lastSyncAt: NOW_ISO })
    renderTab()
    const when = `${formatFullDate(NOW_ISO, lang)}, ${formatTime(NOW_ISO, lang)}`
    expect(text('sync-last-synced')).toBe(translate(lang, 'sync.lastSynced', { when }))
  })

  it('another time gives another text', () => {
    const other = '2026-03-02T21:40:00.000Z'
    setup({ lastSyncAt: other })
    renderTab()
    expect(text('sync-last-synced')).toBe(
      translate('en', 'sync.lastSynced', {
        when: `${formatFullDate(other, 'en')}, ${formatTime(other, 'en')}`,
      }),
    )
    expect(text('sync-last-synced')).not.toContain(formatFullDate(NOW_ISO, 'en'))
  })

  it.each(LANGS)('says "not synced yet" without a time in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ lastSyncAt: null, status: 'syncing' })
    renderTab()
    expect(screen.queryByTestId('sync-last-synced')).toBeNull()
    expect(screen.getByTestId('sync-status-card').textContent).toContain(
      translate(lang, 'sync.neverSynced'),
    )
  })

  it.each(LANGS)('notes skipped records with the right plural form in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ lastError: { code: 'undecryptable', count: 3, at: NOW_ISO } })
    renderTab()
    expect(text('sync-skipped-note')).toBe(translatePlural(lang, 'sync.skipped', 3))
  })

  it('the skipped note changes with the count', () => {
    setup({ lastError: { code: 'undecryptable', count: 1, at: NOW_ISO } })
    renderTab()
    expect(text('sync-skipped-note')).toBe(translatePlural('en', 'sync.skipped', 1))
    expect(translatePlural('en', 'sync.skipped', 1)).not.toBe(translatePlural('en', 'sync.skipped', 3))
  })

  it('shows no skipped note for another kind of lastError or none', () => {
    setup({ lastError: { code: 'network', at: NOW_ISO } })
    renderTab()
    expect(screen.queryByTestId('sync-skipped-note')).toBeNull()
    cleanup()
    setup({ lastError: null })
    renderTab()
    expect(screen.queryByTestId('sync-skipped-note')).toBeNull()
  })
})

describe('the buttons by state', () => {
  const ids = [
    'sync-turn-on-btn',
    'sync-now-btn',
    'sync-upload-again-btn',
    'sync-reconnect-btn',
    'sync-turn-off-btn',
  ]
  const matrix: Array<[SyncStatusCode, Array<string>]> = [
    ['off', ['sync-turn-on-btn']],
    ['synced', ['sync-now-btn', 'sync-turn-off-btn']],
    ['syncing', ['sync-now-btn', 'sync-turn-off-btn']],
    ['offline', ['sync-now-btn', 'sync-turn-off-btn']],
    ['error', ['sync-now-btn', 'sync-turn-off-btn']],
    ['paused', ['sync-now-btn', 'sync-turn-off-btn']],
    ['cloud-deleted', ['sync-upload-again-btn', 'sync-turn-off-btn']],
    ['device-removed', ['sync-reconnect-btn', 'sync-turn-off-btn']],
    ['other-account', ['sync-turn-off-btn']],
    ['vault-mismatch', ['sync-turn-off-btn']],
  ]

  it.each(matrix)('%s shows exactly the right buttons', (status, shown) => {
    setup({ status })
    renderTab()
    for (const id of ids) {
      expect(screen.queryByTestId(id) !== null, `${status} ${id}`).toBe(shown.includes(id))
    }
  })

  it.each(LANGS)('button labels follow the language (%s)', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'off' })
    renderTab()
    expect(text('sync-turn-on-btn')).toBe(translate(lang, 'sync.turnOn'))
    cleanup()

    setup({ status: 'synced' })
    renderTab()
    expect(text('sync-now-btn')).toBe(translate(lang, 'sync.now'))
    cleanup()

    setup({ status: 'cloud-deleted' })
    renderTab()
    expect(text('sync-upload-again-btn')).toBe(translate(lang, 'sync.uploadAgain'))
    cleanup()

    setup({ status: 'device-removed' })
    renderTab()
    expect(text('sync-reconnect-btn')).toBe(translate(lang, 'sync.turnOn'))
  })

  it('Sync now is enabled when synced and disabled while syncing or offline', () => {
    setup({ status: 'synced' })
    renderTab()
    expect(screen.getByTestId<HTMLButtonElement>('sync-now-btn').disabled).toBe(false)
    cleanup()

    setup({ status: 'syncing' })
    renderTab()
    expect(screen.getByTestId<HTMLButtonElement>('sync-now-btn').disabled).toBe(true)
    cleanup()

    setup({ status: 'offline' })
    renderTab()
    expect(screen.getByTestId<HTMLButtonElement>('sync-now-btn').disabled).toBe(true)
  })

  it('Sync now runs a manual sync', async () => {
    setup({ status: 'synced' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-now-btn'))
    await waitFor(() => {
      expect(actions.syncNow).toHaveBeenCalledTimes(1)
    })
  })
})

describe('plan line, usage, devices and the danger zone', () => {
  it.each(LANGS)('beta shows the beta line in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'synced' }, plan({ granted_by: 'free_for_all' }))
    renderTab()
    expect(text('sync-plan-line')).toBe(translate(lang, 'sync.plan.beta'))
  })

  it('an entitlement shows the included line instead', () => {
    setup({ status: 'synced' }, plan({ granted_by: 'entitlement', plan_id: 'sync' }))
    renderTab()
    expect(text('sync-plan-line')).toBe(translate('en', 'cloud.plan.included'))
    expect(text('sync-plan-line')).not.toBe(translate('en', 'sync.plan.beta'))
  })

  it.each(LANGS)('shows records and storage usage against the limits in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'synced' }, plan())
    renderTab()
    expect(text('sync-usage-records')).toBe(
      translate(lang, 'sync.usage.records', {
        used: formatNumber(1234),
        limit: formatNumber(100000),
      }),
    )
    expect(text('sync-usage-storage')).toBe(
      translate(lang, 'sync.usage.storage', {
        used: formatBytes(5 * 1024 * 1024),
        limit: formatBytes(104857600),
      }),
    )
  })

  it('different usage gives different numbers', () => {
    setup(
      { status: 'synced' },
      plan({
        vault: { vault_id: 'v1', header_rev: 1, record_count: 77, total_bytes: 2048, last_seq: 77 },
      }),
    )
    renderTab()
    expect(text('sync-usage-records')).toContain(formatNumber(77))
    expect(text('sync-usage-records')).not.toContain(formatNumber(1234))
    expect(text('sync-usage-storage')).toContain(formatBytes(2048))
  })

  it('no usage without a cloud vault', () => {
    setup({ status: 'synced' }, plan({ vault: null }))
    renderTab()
    expect(screen.queryByTestId('sync-usage-records')).toBeNull()
    expect(screen.queryByTestId('sync-usage-storage')).toBeNull()
  })

  it('with sync off there is no plan line, usage, devices or danger zone', () => {
    setup({ status: 'off' })
    renderTab()
    expect(screen.queryByTestId('sync-plan-line')).toBeNull()
    expect(screen.queryByTestId('sync-usage-records')).toBeNull()
    expect(screen.queryByTestId('fake-sync-devices')).toBeNull()
    expect(screen.queryByTestId('sync-delete-cloud-btn')).toBeNull()
  })

  it('the devices list gets this device id', () => {
    setup({ status: 'synced', deviceId: 'device-42' })
    renderTab()
    expect(screen.getByTestId('fake-sync-devices').getAttribute('data-this-device')).toBe('device-42')
  })

  it('the devices list is hidden for another account', () => {
    setup({ status: 'other-account' })
    renderTab()
    expect(screen.queryByTestId('fake-sync-devices')).toBeNull()
  })

  it.each(LANGS)('Delete cloud data opens its dialog in %s', (lang) => {
    setLang(lang, { persist: false })
    setup({ status: 'synced' })
    renderTab()
    expect(text('sync-delete-cloud-btn')).toBe(translate(lang, 'sync.deleteCloud.button'))
    expect(screen.queryByTestId('fake-delete-cloud-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('sync-delete-cloud-btn'))
    expect(screen.getByTestId('fake-delete-cloud-dialog')).toBeTruthy()
  })
})

describe('turning sync on', () => {
  it('turns on and says so', async () => {
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(translate('en', 'sync.toast.turnedOn'))
    })
    expect(actions.turnOn).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('sync-action-error')).toBeNull()
  })

  it('a linked result also toasts', async () => {
    actions.turnOn.mockResolvedValue({ kind: 'linked' })
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(translate('en', 'sync.toast.turnedOn'))
    })
  })

  it('opens the link dialog for a different cloud vault and toasts after linking', async () => {
    actions.turnOn.mockResolvedValue({ kind: 'needs-link', cloud: cloudVault('cloud-9') })
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))

    const dialog = await screen.findByTestId('fake-sync-link-dialog')
    expect(dialog.getAttribute('data-cloud-id')).toBe('cloud-9')
    expect(toastSuccess).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('fake-linked'))
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(translate('en', 'sync.toast.turnedOn'))
    })
  })

  it('cancelling the link dialog closes it without a toast', async () => {
    actions.turnOn.mockResolvedValue({ kind: 'needs-link', cloud: cloudVault('cloud-9') })
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))
    await screen.findByTestId('fake-sync-link-dialog')
    fireEvent.click(screen.getByText('fake-close'))
    expect(screen.queryByTestId('fake-sync-link-dialog')).toBeNull()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('Upload again runs uploadAgain and Reconnect runs turnOn', async () => {
    setup({ status: 'cloud-deleted' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-upload-again-btn'))
    await waitFor(() => {
      expect(actions.uploadAgain).toHaveBeenCalledTimes(1)
    })
    expect(actions.turnOn).not.toHaveBeenCalled()
    cleanup()

    setup({ status: 'device-removed' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-reconnect-btn'))
    await waitFor(() => {
      expect(actions.turnOn).toHaveBeenCalledTimes(1)
    })
  })

  it.each(LANGS)('shows the code of a cloud error in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.turnOn.mockRejectedValue(Object.assign(new Error('x'), { name: 'CloudError', code: 'device_limit' }))
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))

    const error = await screen.findByTestId('sync-action-error')
    expect(error.textContent).toBe(translate(lang, 'sync.errors.actionFailed', { code: 'device_limit' }))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('shows the code of an action error', async () => {
    actions.turnOn.mockRejectedValue(Object.assign(new Error('x'), { name: 'SyncActionError', code: 'locked' }))
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))
    const error = await screen.findByTestId('sync-action-error')
    expect(error.textContent).toBe(translate('en', 'sync.errors.actionFailed', { code: 'locked' }))
  })

  it('shows "unknown" for any other error', async () => {
    actions.turnOn.mockRejectedValue(new Error('boom'))
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))
    const error = await screen.findByTestId('sync-action-error')
    expect(error.textContent).toBe(translate('en', 'sync.errors.actionFailed', { code: 'unknown' }))
  })

  it.each(LANGS)('shows a vault error in words in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.turnOn.mockRejectedValue(
      Object.assign(new Error('Incorrect password'), { name: 'VaultError', code: 'incorrect-password' }),
    )
    setup({ status: 'off' })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-on-btn'))
    const error = await screen.findByTestId('sync-action-error')
    expect(error.textContent).toBe(translate(lang, 'errors.vault.incorrectPassword'))
  })
})

describe('turning sync off', () => {
  async function openDialog(status: SyncStatusCode = 'synced') {
    setup({ status })
    renderTab()
    fireEvent.click(screen.getByTestId('sync-turn-off-btn'))
    return screen.findByTestId('sync-turn-off-dialog')
  }

  it.each(LANGS)('asks first, with the remove-device box unticked, in %s', async (lang) => {
    setLang(lang, { persist: false })
    const dialog = await openDialog()

    expect(dialog.textContent).toContain(translate(lang, 'sync.turnOff.body'))
    expect(dialog.textContent).toContain(translate(lang, 'sync.turnOff.alsoRemoveDevice'))
    const box = screen.getByTestId<HTMLInputElement>('sync-turn-off-remove-device')
    expect(box.type).toBe('checkbox')
    expect(box.checked).toBe(false)
    expect(actions.turnOff).not.toHaveBeenCalled()
  })

  it('confirm turns sync off and keeps the device registered', async () => {
    await openDialog()
    fireEvent.click(screen.getByTestId('sync-turn-off-confirm'))

    await waitFor(() => {
      expect(actions.turnOff).toHaveBeenCalledWith({ removeDevice: false })
    })
    expect(toastSuccess).toHaveBeenCalledWith(translate('en', 'sync.toast.turnedOff'))
  })

  it('ticking the box also removes the device', async () => {
    await openDialog()
    fireEvent.click(screen.getByTestId('sync-turn-off-remove-device'))
    fireEvent.click(screen.getByTestId('sync-turn-off-confirm'))

    await waitFor(() => {
      expect(actions.turnOff).toHaveBeenCalledWith({ removeDevice: true })
    })
  })

  it.each(['other-account', 'vault-mismatch', 'device-removed'] as const)(
    'turn off is available in %s',
    async (status) => {
      await openDialog(status)
      fireEvent.click(screen.getByTestId('sync-turn-off-confirm'))
      await waitFor(() => {
        expect(actions.turnOff).toHaveBeenCalledTimes(1)
      })
    },
  )
})
