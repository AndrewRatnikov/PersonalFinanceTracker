// CONTRACT_GAP: whether the recovery-key path is one screen (key, new password
//   and confirmation together) or two steps (key, then the new password, as
//   RecoverScreen) is not fixed; the helper fills whatever is visible and
//   presses sync-restore-recovery-submit again when the password fields only
//   appear after the first press. Only one submit testid exists for it.
// CONTRACT_GAP: the exact text of sync-restore-progress is not specified; only
//   that it shows the number of downloaded records.
//
// SyncRestoreScreen is specified in plan section 10 and the Interface Contract
// (component: SyncRestoreScreen). The runtime actions, the session and the sync
// state are fakes; errors are recognised by name and code like the app does.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import type { CloudVault } from '@/lib/cloud/types'
import type { SyncState } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useAccountSession } from '@/lib/accountSession'
import { useSyncState } from '@/lib/sync/react'
import { SyncRestoreScreen } from '@/components/vault/SyncRestoreScreen'

const { actions } = vi.hoisted(() => ({
  actions: { fetchCloudVault: vi.fn(), restoreFromCloud: vi.fn() },
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
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountSession: vi.fn(),
  useAccountsVisible: vi.fn(() => true),
}))
vi.mock('@/lib/sync/react', () => ({
  useSyncState: vi.fn(),
  useSyncAvailable: vi.fn(() => true),
  OFF_SYNC_STATE: { status: 'off' },
}))
vi.mock('@/lib/sync/runtime', () => ({
  getSyncRuntime: () => ({ engine: {}, actions, setUserId: vi.fn() }),
}))

const LANGS: Array<Lang> = ['en', 'uk']
const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'

const CLOUD: CloudVault = {
  vault_id: 'cloud-vault',
  header_rev: 3,
  header: {
    v: 2,
    vaultId: 'cloud-vault',
    createdAt: '2026-10-01T00:00:00.000Z',
    kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==' },
    wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
    recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
    verifier: { iv: 'aXY=', ct: 'Y3Q=' },
  },
}

function syncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    status: 'off',
    lastSyncAt: null,
    progress: null,
    errorCode: null,
    lastError: null,
    deviceId: null,
    ...overrides,
  }
}

function named(name: string, code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { name, code, ...extra })
}

function renderScreen() {
  const onRestored = vi.fn()
  const onCancel = vi.fn()
  render(<SyncRestoreScreen onRestored={onRestored} onCancel={onCancel} />)
  return { onRestored, onCancel }
}

function type(id: string, value: string) {
  fireEvent.change(screen.getByTestId(id), { target: { value } })
}

async function readyPasswordStep() {
  const handlers = renderScreen()
  await screen.findByTestId('sync-restore-password')
  return handlers
}

function submitPassword(password: string) {
  type('sync-restore-password', password)
  const form = screen.getByTestId('sync-restore-submit').closest('form')
  if (!form) throw new Error('the submit button is not inside a form')
  fireEvent.submit(form)
}

async function openRecovery() {
  await readyPasswordStep()
  fireEvent.click(screen.getByTestId('sync-restore-use-recovery'))
  await screen.findByTestId('sync-restore-recovery-key')
}

function submitRecovery(key: string, password: string, confirm: string) {
  type('sync-restore-recovery-key', key)
  if (!screen.queryByTestId('sync-restore-new-password')) {
    fireEvent.click(screen.getByTestId('sync-restore-recovery-submit'))
  }
  type('sync-restore-new-password', password)
  type('sync-restore-confirm-password', confirm)
  fireEvent.click(screen.getByTestId('sync-restore-recovery-submit'))
}

beforeEach(() => {
  vi.resetAllMocks()
  setLang('en', { persist: false })
  vi.mocked(useAccountSession).mockReturnValue({ userId: 'user-1', email: 'ann@example.com' })
  vi.mocked(useSyncState).mockReturnValue(syncState())
  actions.fetchCloudVault.mockResolvedValue(CLOUD)
  actions.restoreFromCloud.mockResolvedValue({ ran: true })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('signed out', () => {
  it('asks to sign in and comes back to the restore request', () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    renderScreen()

    expect(screen.getByTestId('sync-restore-screen')).toBeTruthy()
    const href = screen.getByTestId('sync-restore-sign-in').getAttribute('href') ?? ''
    expect(href.startsWith('/login?')).toBe(true)
    expect(new URLSearchParams(href.split('?')[1]).get('redirect')).toBe('/?restore=sync')
    expect(actions.fetchCloudVault).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sync-restore-password')).toBeNull()
  })

  it('Cancel is there and goes back', () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    const { onCancel } = renderScreen()
    fireEvent.click(screen.getByTestId('sync-restore-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('looking up the cloud vault', () => {
  it('shows a loading marker while the vault is fetched', () => {
    actions.fetchCloudVault.mockReturnValue(new Promise(() => undefined))
    renderScreen()
    expect(screen.getByTestId('sync-restore-loading')).toBeTruthy()
    expect(screen.queryByTestId('sync-restore-password')).toBeNull()
    expect(actions.fetchCloudVault).toHaveBeenCalledTimes(1)
  })

  it.each(LANGS)('says there is nothing to restore in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.fetchCloudVault.mockResolvedValue(null)
    renderScreen()

    const note = await screen.findByTestId('sync-restore-no-vault')
    expect(note.textContent).toContain(translate(lang, 'sync.restore.noVault'))
    expect(screen.queryByTestId('sync-restore-password')).toBeNull()
    expect(screen.getByTestId('sync-restore-cancel')).toBeTruthy()
  })

  it.each(LANGS)('says the plan does not include sync in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.fetchCloudVault.mockRejectedValue(named('SyncActionError', 'sync_not_included'))
    renderScreen()

    const note = await screen.findByTestId('sync-restore-not-included')
    expect(note.textContent).toContain(translate(lang, 'cloud.plan.notIncluded'))
    expect(screen.queryByTestId('sync-restore-password')).toBeNull()
  })

  it('any other failure shows an error and no password form', async () => {
    actions.fetchCloudVault.mockRejectedValue(named('CloudError', 'network'))
    renderScreen()

    expect(await screen.findByTestId('sync-restore-error')).toBeTruthy()
    expect(screen.queryByTestId('sync-restore-password')).toBeNull()
    expect(screen.queryByTestId('sync-restore-not-included')).toBeNull()
  })

  it('Cancel works in every state', async () => {
    actions.fetchCloudVault.mockResolvedValue(null)
    const { onCancel } = renderScreen()
    await screen.findByTestId('sync-restore-no-vault')
    fireEvent.click(screen.getByTestId('sync-restore-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('restoring with the password', () => {
  it.each(LANGS)('shows the password step in %s', async (lang) => {
    setLang(lang, { persist: false })
    await readyPasswordStep()

    expect(screen.getByTestId<HTMLInputElement>('sync-restore-password').type).toBe('password')
    expect(screen.getByTestId('sync-restore-use-recovery').textContent.trim()).toBe(
      translate(lang, 'sync.restore.useRecovery'),
    )
    expect(screen.getByTestId('sync-restore-cancel')).toBeTruthy()
    expect(screen.queryByTestId('sync-restore-error')).toBeNull()
    expect(screen.queryByTestId('sync-restore-progress')).toBeNull()
  })

  it('restores with the typed password and lands on success', async () => {
    const { onRestored } = await readyPasswordStep()
    submitPassword('cloud password')

    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    expect(actions.restoreFromCloud).toHaveBeenCalledTimes(1)
    expect(actions.restoreFromCloud).toHaveBeenCalledWith(CLOUD, { password: 'cloud password' })
  })

  it('does not restore before submit', async () => {
    const { onRestored } = await readyPasswordStep()
    type('sync-restore-password', 'typed only')
    expect(actions.restoreFromCloud).not.toHaveBeenCalled()
    expect(onRestored).not.toHaveBeenCalled()
  })

  it.each(LANGS)('refuses a wrong password in words in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.restoreFromCloud.mockRejectedValue(named('VaultError', 'incorrect-password'))
    const { onRestored } = await readyPasswordStep()
    submitPassword('wrong')

    const error = await screen.findByTestId('sync-restore-error')
    expect(error.textContent).toBe(translate(lang, 'errors.vault.incorrectPassword'))
    expect(onRestored).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-restore-password')).toBeTruthy()
  })

  it('shows the wait when throttled', async () => {
    actions.restoreFromCloud.mockRejectedValue(named('VaultError', 'throttled', { retryAfterMs: 5000 }))
    await readyPasswordStep()
    submitPassword('wrong')

    const error = await screen.findByTestId('sync-restore-error')
    expect(error.textContent).toBe(translate('en', 'errors.vault.throttled', { seconds: 5 }))
  })

  it('shows progress while the restore runs, then lands', async () => {
    let finish!: () => void
    actions.restoreFromCloud.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    vi.mocked(useSyncState).mockReturnValue(
      syncState({ status: 'syncing', progress: { phase: 'pull', done: 12, total: 900 } }),
    )
    const { onRestored } = await readyPasswordStep()
    expect(screen.queryByTestId('sync-restore-progress')).toBeNull()
    submitPassword('cloud password')

    const progress = await screen.findByTestId('sync-restore-progress')
    expect(progress.textContent).toContain('12')
    expect(onRestored).not.toHaveBeenCalled()

    finish()
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
  })

  it('a different download count shows a different progress', async () => {
    actions.restoreFromCloud.mockReturnValue(new Promise(() => undefined))
    vi.mocked(useSyncState).mockReturnValue(
      syncState({ status: 'syncing', progress: { phase: 'pull', done: 345, total: null } }),
    )
    await readyPasswordStep()
    submitPassword('cloud password')

    const progress = await screen.findByTestId('sync-restore-progress')
    expect(progress.textContent).toContain('345')
    expect(progress.textContent).not.toContain('12')
  })

  it('Cancel goes back', async () => {
    const { onCancel } = await readyPasswordStep()
    fireEvent.click(screen.getByTestId('sync-restore-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('restoring with the recovery key', () => {
  it.each(LANGS)('shows the recovery fields in %s', async (lang) => {
    setLang(lang, { persist: false })
    await openRecovery()
    expect(screen.getByTestId('sync-restore-recovery-key')).toBeTruthy()
    expect(screen.getByTestId('sync-restore-recovery-submit')).toBeTruthy()
    expect(screen.getByTestId('sync-restore-cancel')).toBeTruthy()
    expect(screen.queryByTestId('sync-restore-password')).toBeNull()
  })

  it('restores with the key and a new password', async () => {
    await openRecovery()
    const onRestored = vi.mocked(actions.restoreFromCloud)
    submitRecovery(KEY, 'a brand new password', 'a brand new password')

    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    expect(actions.restoreFromCloud).toHaveBeenCalledWith(CLOUD, {
      recoveryKey: KEY,
      newPassword: 'a brand new password',
    })
  })

  it('lands on success', async () => {
    const view = renderScreen()
    await screen.findByTestId('sync-restore-password')
    fireEvent.click(screen.getByTestId('sync-restore-use-recovery'))
    await screen.findByTestId('sync-restore-recovery-key')
    submitRecovery(KEY, 'a brand new password', 'a brand new password')
    await waitFor(() => {
      expect(view.onRestored).toHaveBeenCalledTimes(1)
    })
  })

  it('refuses a new password shorter than 8 characters', async () => {
    await openRecovery()
    submitRecovery(KEY, 'short', 'short')

    const error = await screen.findByTestId('sync-restore-error')
    expect(error.textContent).toBe(translate('en', 'vault.passwordTooShort'))
    expect(actions.restoreFromCloud).not.toHaveBeenCalled()
  })

  it('refuses a confirmation that does not match', async () => {
    await openRecovery()
    submitRecovery(KEY, 'a brand new password', 'another new password')

    const error = await screen.findByTestId('sync-restore-error')
    expect(error.textContent).toBe(translate('en', 'vault.passwordsDontMatch'))
    expect(actions.restoreFromCloud).not.toHaveBeenCalled()
  })

  it.each(LANGS)('refuses a wrong recovery key in words in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.restoreFromCloud.mockRejectedValue(named('VaultError', 'incorrect-recovery-key'))
    await openRecovery()
    submitRecovery(KEY, 'a brand new password', 'a brand new password')

    const error = await screen.findByTestId('sync-restore-error')
    expect(error.textContent).toBe(translate(lang, 'errors.vault.incorrectRecoveryKey'))
  })
})
