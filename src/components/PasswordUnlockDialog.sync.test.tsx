// No CONTRACT_GAPs: the sync-restore mode, the restore entry and the restore
// request are specified in plan section 10 and the Interface Contract
// (component changes: CreateVaultScreen, PasswordUnlockDialog). Mocks follow
// PasswordUnlockDialog.test.tsx; SyncRestoreScreen is replaced by
// fake-sync-restore-screen and the flags are mutable getters.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { consumeSyncRestoreRequest, requestSyncRestore } from '@/lib/sync/restoreRequest'
import { getVaultState } from '@/lib/vault'
import { PasswordUnlockDialog } from '@/components/PasswordUnlockDialog'

const flags = vi.hoisted(() => ({ sync: true }))
const { MockVaultError } = vi.hoisted(() => {
  class FakeVaultError extends Error {
    code: string
    retryAfterMs: number
    constructor(code: string, message: string, retryAfterMs = 0) {
      super(message)
      this.name = 'VaultError'
      this.code = code
      this.retryAfterMs = retryAfterMs
    }
  }
  return { MockVaultError: FakeVaultError }
})

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  get ENABLE_SYNC() {
    return flags.sync
  },
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/localDb', () => ({ clearLocalDb: vi.fn() }))
vi.mock('@/lib/vault', () => ({
  getVaultState: vi.fn(),
  createVault: vi.fn(),
  unlockWithPassword: vi.fn(),
  unlockWithRecoveryKey: vi.fn(),
  resetPasswordWithRecoveryKey: vi.fn(),
  clearLegacyKeys: vi.fn(),
  verifyPassword: vi.fn(),
  VaultError: MockVaultError,
}))
vi.mock('@/lib/localWipe', () => ({ wipeLocalData: vi.fn(), reloadToHome: vi.fn() }))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('@/lib/storagePersistence', () => ({ requestPersistentStorage: vi.fn() }))
vi.mock('@/lib/appSettings', () => ({ updateAppSettings: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn(), downloadBackup: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: () => null,
}))
vi.mock('@/components/vault/SyncRestoreScreen', () => ({
  SyncRestoreScreen: ({
    onRestored,
    onCancel,
  }: {
    onRestored: () => void
    onCancel: () => void
  }) => (
    <div data-testid="fake-sync-restore-screen">
      <button type="button" onClick={onRestored}>
        fake-restored
      </button>
      <button type="button" onClick={onCancel}>
        fake-cancel
      </button>
    </div>
  ),
}))

function renderDialog() {
  const onUnlocked = vi.fn()
  render(<PasswordUnlockDialog onUnlocked={onUnlocked} />)
  return onUnlocked
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  setLang('en', { persist: false })
  vi.mocked(getVaultState).mockResolvedValue('none')
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  consumeSyncRestoreRequest()
})

afterEach(() => {
  cleanup()
  consumeSyncRestoreRequest()
  setLang('en', { persist: false })
})

describe('the restore entry on the create screen', () => {
  it.each(['en', 'uk'] as const)('is offered with the flag on and accounts visible (%s)', async (lang) => {
    setLang(lang, { persist: false })
    renderDialog()

    const entry = await screen.findByTestId('create-vault-sync-restore')
    expect(entry.textContent.trim()).toBe(translate(lang, 'sync.restore.entry'))
    expect(screen.getByTestId('create-vault-screen')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-restore-screen')).toBeNull()
  })

  it('is not offered with the flag off', async () => {
    flags.sync = false
    renderDialog()
    await screen.findByTestId('create-vault-screen')
    expect(screen.queryByTestId('create-vault-sync-restore')).toBeNull()
  })

  it('is not offered when accounts are hidden', async () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    renderDialog()
    await screen.findByTestId('create-vault-screen')
    expect(screen.queryByTestId('create-vault-sync-restore')).toBeNull()
  })

  it('is not offered when a vault already exists', async () => {
    vi.mocked(getVaultState).mockResolvedValue('v2')
    renderDialog()
    await waitFor(() => {
      expect(screen.queryByTestId('unlock-checking')).toBeNull()
    })
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    expect(screen.queryByTestId('create-vault-sync-restore')).toBeNull()
  })
})

describe('the sync-restore mode', () => {
  it('opens the restore screen from the entry, and Cancel returns to the create screen', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('create-vault-sync-restore'))

    expect(screen.getByTestId('fake-sync-restore-screen')).toBeTruthy()
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()

    fireEvent.click(screen.getByText('fake-cancel'))
    expect(await screen.findByTestId('create-vault-screen')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-restore-screen')).toBeNull()
  })

  it('a finished restore unlocks as an existing vault, not a new one', async () => {
    const onUnlocked = renderDialog()
    fireEvent.click(await screen.findByTestId('create-vault-sync-restore'))
    fireEvent.click(screen.getByText('fake-restored'))

    expect(onUnlocked).toHaveBeenCalledTimes(1)
    expect(onUnlocked).toHaveBeenCalledWith({ isNewVault: false })
  })

  it('a pending restore request opens the restore screen straight away, once', async () => {
    requestSyncRestore()
    renderDialog()

    expect(await screen.findByTestId('fake-sync-restore-screen')).toBeTruthy()
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    expect(consumeSyncRestoreRequest()).toBe(false)

    cleanup()
    renderDialog()
    expect(await screen.findByTestId('create-vault-screen')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-restore-screen')).toBeNull()
  })

  it('without a request the create screen comes first', async () => {
    renderDialog()
    expect(await screen.findByTestId('create-vault-screen')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-restore-screen')).toBeNull()
  })
})
