// No CONTRACT_GAPs: container routing and testids are fully specified in the
// Interface Contract (component: PasswordUnlockDialog). This file replaces the
// v1 version: the orphaned-state cases carry over with getVaultState mocked to
// 'orphaned'; the inline create/unlock form tests moved to the screen tests.
// Phase 3 adds the "I've lost both" path (RemoveDataDialog with typed DELETE)
// and the onCancelCreate prop.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearLocalDb } from '@/lib/localDb'
import { reloadToHome, wipeLocalData } from '@/lib/localWipe'
import {
  clearLegacyKeys,
  createVault,
  getVaultState,
  resetPasswordWithRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  verifyPassword,
} from '@/lib/vault'
import { PasswordUnlockDialog } from '@/components/PasswordUnlockDialog'

const { MockVaultError } = vi.hoisted(() => {
  class MockVaultError extends Error {
    code: string
    retryAfterMs: number
    constructor(code: string, message: string, retryAfterMs = 0) {
      super(message)
      this.name = 'VaultError'
      this.code = code
      this.retryAfterMs = retryAfterMs
    }
  }
  return { MockVaultError }
})

vi.mock('@/lib/localDb', () => ({
  clearLocalDb: vi.fn(),
}))

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

vi.mock('@/lib/localWipe', () => ({
  wipeLocalData: vi.fn(),
  reloadToHome: vi.fn(),
}))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('@/lib/storagePersistence', () => ({
  requestPersistentStorage: vi.fn(),
}))

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderDialog(
  onUnlocked = vi.fn(),
  extra: { onCancelCreate?: () => void } = {},
) {
  render(<PasswordUnlockDialog onUnlocked={onUnlocked} {...extra} />)
  return onUnlocked
}

function typeErase(value: string) {
  fireEvent.change(screen.getByTestId('unlock-erase-input'), {
    target: { value },
  })
}

function eraseButton() {
  return screen.getByTestId<HTMLButtonElement>('unlock-erase-button')
}

function submitOf(testId: string) {
  const form = screen.getByTestId(testId).closest('form')
  if (!form) throw new Error(`${testId} is not inside a form`)
  fireEvent.submit(form)
}

function confirmSavedKey(lastGroup: string) {
  fireEvent.click(screen.getByTestId('recovery-key-saved-checkbox'))
  fireEvent.change(screen.getByTestId('recovery-key-last-group-input'), {
    target: { value: lastGroup },
  })
  fireEvent.click(screen.getByTestId('recovery-key-continue'))
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('PasswordUnlockDialog state routing', () => {
  it('shows a checking state, with no screen, while getVaultState is pending', async () => {
    const pending = deferred<'none'>()
    vi.mocked(getVaultState).mockReturnValue(pending.promise)

    renderDialog()

    expect(screen.getByTestId('unlock-checking')).toBeTruthy()
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    expect(screen.queryByTestId('unlock-screen')).toBeNull()
    expect(screen.queryByTestId('unlock-recovery')).toBeNull()

    pending.resolve('none')
    await screen.findByTestId('create-vault-screen')
    expect(screen.queryByTestId('unlock-checking')).toBeNull()
  })

  it("shows the create screen for state 'none'", async () => {
    vi.mocked(getVaultState).mockResolvedValue('none')
    renderDialog()

    await screen.findByTestId('create-vault-screen')

    expect(screen.queryByTestId('unlock-screen')).toBeNull()
    expect(screen.queryByTestId('unlock-recovery')).toBeNull()
  })

  it("shows the unlock screen with 'Forgot password?' for state 'v2'", async () => {
    vi.mocked(getVaultState).mockResolvedValue('v2')
    renderDialog()

    await screen.findByTestId('unlock-screen')

    expect(screen.getByTestId('unlock-forgot-password')).toBeTruthy()
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
  })

  it("shows the unlock screen without 'Forgot password?' for state 'v1'", async () => {
    vi.mocked(getVaultState).mockResolvedValue('v1')
    renderDialog()

    await screen.findByTestId('unlock-screen')

    expect(screen.queryByTestId('unlock-forgot-password')).toBeNull()
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
  })

  it('removed the inline unlock form from the container', async () => {
    vi.mocked(getVaultState).mockResolvedValue('v2')
    renderDialog()

    await screen.findByTestId('unlock-screen')

    expect(screen.queryByTestId('unlock-form')).toBeNull()
  })
})

describe('PasswordUnlockDialog create flow', () => {
  it('creates a vault, shows the key and reports isNewVault true only after continue', async () => {
    vi.mocked(getVaultState).mockResolvedValue('none')
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    const onUnlocked = renderDialog()
    await screen.findByTestId('create-vault-screen')

    fireEvent.change(screen.getByTestId('create-vault-password-input'), {
      target: { value: 'long enough 1' },
    })
    fireEvent.change(screen.getByTestId('create-vault-confirm-input'), {
      target: { value: 'long enough 1' },
    })
    submitOf('create-vault-submit')
    await screen.findByTestId('recovery-key-step')
    expect(onUnlocked).not.toHaveBeenCalled()

    confirmSavedKey('XY')

    expect(onUnlocked).toHaveBeenCalledTimes(1)
    expect(onUnlocked).toHaveBeenCalledWith({ isNewVault: true })
    expect(createVault).toHaveBeenCalledWith('long enough 1')
  })
})

describe('PasswordUnlockDialog onCancelCreate', () => {
  it('shows a Back button on the create screen that calls onCancelCreate', async () => {
    vi.mocked(getVaultState).mockResolvedValue('none')
    const onCancelCreate = vi.fn()
    renderDialog(vi.fn(), { onCancelCreate })
    await screen.findByTestId('create-vault-screen')

    fireEvent.click(screen.getByTestId('create-vault-cancel'))

    expect(onCancelCreate).toHaveBeenCalledTimes(1)
  })

  it('shows no Back button without onCancelCreate', async () => {
    vi.mocked(getVaultState).mockResolvedValue('none')
    renderDialog()
    await screen.findByTestId('create-vault-screen')

    expect(screen.queryByTestId('create-vault-cancel')).toBeNull()
  })
})

describe('PasswordUnlockDialog unlock flow', () => {
  it('reports isNewVault false right away after a normal v2 unlock', async () => {
    vi.mocked(getVaultState).mockResolvedValue('v2')
    vi.mocked(unlockWithPassword).mockResolvedValue({ recoveryKey: null })
    const onUnlocked = renderDialog()
    await screen.findByTestId('unlock-screen')

    fireEvent.change(screen.getByTestId('unlock-password-input'), {
      target: { value: 'my password' },
    })
    submitOf('unlock-submit')

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({ isNewVault: false })
    })
    expect(screen.queryByTestId('unlock-migrated-key')).toBeNull()
    expect(clearLegacyKeys).not.toHaveBeenCalled()
  })

  it('after a v1 migration shows the recovery key first and holds onUnlocked back', async () => {
    vi.mocked(getVaultState).mockResolvedValue('v1')
    vi.mocked(unlockWithPassword).mockResolvedValue({ recoveryKey: KEY })
    vi.mocked(clearLegacyKeys).mockResolvedValue(undefined)
    const onUnlocked = renderDialog()
    await screen.findByTestId('unlock-screen')

    fireEvent.change(screen.getByTestId('unlock-password-input'), {
      target: { value: 'old password' },
    })
    submitOf('unlock-submit')

    const card = await screen.findByTestId('unlock-migrated-key')
    expect(card.querySelector('[data-testid="recovery-key-step"]')).toBeTruthy()
    expect(screen.getByTestId('recovery-key-value').textContent).toBe(KEY)
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(clearLegacyKeys).not.toHaveBeenCalled()
  })

  it('clears the legacy keys before reporting unlocked once the key is confirmed', async () => {
    vi.mocked(getVaultState).mockResolvedValue('v1')
    vi.mocked(unlockWithPassword).mockResolvedValue({ recoveryKey: KEY })
    vi.mocked(clearLegacyKeys).mockResolvedValue(undefined)
    const onUnlocked = renderDialog()
    await screen.findByTestId('unlock-screen')
    fireEvent.change(screen.getByTestId('unlock-password-input'), {
      target: { value: 'old password' },
    })
    submitOf('unlock-submit')
    await screen.findByTestId('unlock-migrated-key')

    confirmSavedKey('xy')

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({ isNewVault: false })
    })
    expect(clearLegacyKeys).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(clearLegacyKeys).mock.invocationCallOrder[0],
    ).toBeLessThan(onUnlocked.mock.invocationCallOrder[0])
  })

  it('does not report unlocked while clearLegacyKeys is still pending', async () => {
    const pending = deferred<undefined>()
    vi.mocked(getVaultState).mockResolvedValue('v1')
    vi.mocked(unlockWithPassword).mockResolvedValue({ recoveryKey: KEY })
    vi.mocked(clearLegacyKeys).mockReturnValue(pending.promise)
    const onUnlocked = renderDialog()
    await screen.findByTestId('unlock-screen')
    fireEvent.change(screen.getByTestId('unlock-password-input'), {
      target: { value: 'old password' },
    })
    submitOf('unlock-submit')
    await screen.findByTestId('unlock-migrated-key')

    confirmSavedKey('XY')

    await waitFor(() => {
      expect(clearLegacyKeys).toHaveBeenCalledTimes(1)
    })
    expect(onUnlocked).not.toHaveBeenCalled()
    pending.resolve(undefined)
    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({ isNewVault: false })
    })
  })
})

describe('PasswordUnlockDialog forgot-password flow', () => {
  async function openRecover() {
    vi.mocked(getVaultState).mockResolvedValue('v2')
    const onUnlocked = renderDialog()
    await screen.findByTestId('unlock-screen')
    fireEvent.click(screen.getByTestId('unlock-forgot-password'))
    await screen.findByTestId('recover-screen')
    return onUnlocked
  }

  it('switches to the recover screen and back on cancel', async () => {
    await openRecover()
    expect(screen.queryByTestId('unlock-screen')).toBeNull()

    fireEvent.click(screen.getByTestId('recover-cancel'))

    await screen.findByTestId('unlock-screen')
    expect(screen.queryByTestId('recover-screen')).toBeNull()
  })

  it('recovers with the key, sets a new password and reports isNewVault false', async () => {
    vi.mocked(unlockWithRecoveryKey).mockResolvedValue(undefined)
    vi.mocked(resetPasswordWithRecoveryKey).mockResolvedValue(undefined)
    const onUnlocked = await openRecover()

    fireEvent.change(screen.getByTestId('recover-key-input'), {
      target: { value: KEY },
    })
    submitOf('recover-key-submit')
    await screen.findByTestId('recover-password-input')
    fireEvent.change(screen.getByTestId('recover-password-input'), {
      target: { value: 'long enough 1' },
    })
    fireEvent.change(screen.getByTestId('recover-confirm-input'), {
      target: { value: 'long enough 1' },
    })
    submitOf('recover-password-submit')

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({ isNewVault: false })
    })
    expect(resetPasswordWithRecoveryKey).toHaveBeenCalledWith(
      KEY,
      'long enough 1',
    )
  })

  describe("the 'I've lost both' path", () => {
    async function openLostBoth() {
      const onUnlocked = await openRecover()
      fireEvent.click(screen.getByTestId('recover-lost-both'))
      await screen.findByTestId('remove-data-dialog')
      return onUnlocked
    }

    it('opens the remove-data dialog in typed DELETE mode', async () => {
      await openLostBoth()

      expect(screen.getByTestId('remove-data-delete-input')).toBeTruthy()
      expect(screen.queryByTestId('remove-data-password-input')).toBeNull()
      expect(screen.queryByTestId('remove-data-backup-btn')).toBeNull()
    })

    it('wipes only after DELETE is typed, never verifying a password', async () => {
      await openLostBoth()
      vi.mocked(wipeLocalData).mockResolvedValue(undefined)
      const confirm = screen.getByTestId<HTMLButtonElement>(
        'remove-data-confirm-btn',
      )
      expect(confirm.disabled).toBe(true)

      fireEvent.change(screen.getByTestId('remove-data-delete-input'), {
        target: { value: 'delete' },
      })
      expect(confirm.disabled).toBe(true)
      fireEvent.change(screen.getByTestId('remove-data-delete-input'), {
        target: { value: 'DELETE' },
      })
      expect(confirm.disabled).toBe(false)
      fireEvent.click(confirm)

      await waitFor(() => {
        expect(reloadToHome).toHaveBeenCalledTimes(1)
      })
      expect(wipeLocalData).toHaveBeenCalledTimes(1)
      expect(verifyPassword).not.toHaveBeenCalled()
    })

    it('returns to the recover screen when the dialog is cancelled', async () => {
      await openLostBoth()

      fireEvent.click(screen.getByTestId('remove-data-cancel-btn'))

      await screen.findByTestId('recover-screen')
      expect(screen.queryByTestId('remove-data-dialog')).toBeNull()
      expect(wipeLocalData).not.toHaveBeenCalled()
    })
  })
})

describe('PasswordUnlockDialog orphaned state', () => {
  it('shows the recovery state, never the create screen, when the vault is orphaned', async () => {
    vi.mocked(getVaultState).mockResolvedValue('orphaned')

    renderDialog()

    await screen.findByTestId('unlock-recovery')
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    expect(screen.queryByTestId('unlock-screen')).toBeNull()
    expect(screen.queryByTestId('unlock-checking')).toBeNull()
    expect(document.querySelector('#password')).toBeNull()
    expect(document.body.textContent).not.toContain('Create password')
    expect(eraseButton().textContent).toContain(
      'Erase local data and start fresh',
    )
  })

  it('falls back to the recovery state when getVaultState rejects', async () => {
    vi.mocked(getVaultState).mockRejectedValue(new Error('idb unavailable'))

    renderDialog()

    await screen.findByTestId('unlock-recovery')
    expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    expect(screen.queryByTestId('unlock-screen')).toBeNull()
  })

  describe('erase confirmation', () => {
    beforeEach(() => {
      vi.mocked(getVaultState).mockResolvedValue('orphaned')
    })

    it('keeps the erase button disabled until the input is exactly DELETE', async () => {
      renderDialog()
      await screen.findByTestId('unlock-recovery')
      expect(eraseButton().disabled).toBe(true)

      for (const wrong of ['delete', 'DELET', 'DELETE ', 'Delete', 'XDELETE']) {
        typeErase(wrong)
        expect(eraseButton().disabled).toBe(true)
      }

      typeErase('DELETE')
      expect(eraseButton().disabled).toBe(false)

      typeErase('DELETE!')
      expect(eraseButton().disabled).toBe(true)
    })

    it('does not erase when clicked while the confirmation is wrong', async () => {
      renderDialog()
      await screen.findByTestId('unlock-recovery')
      typeErase('delete')

      fireEvent.click(eraseButton())

      expect(clearLocalDb).not.toHaveBeenCalled()
      expect(screen.getByTestId('unlock-recovery')).toBeTruthy()
      expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    })

    it('clears the local store and only then continues to the create screen', async () => {
      const pending = deferred<undefined>()
      vi.mocked(clearLocalDb).mockReturnValue(pending.promise)
      renderDialog()
      await screen.findByTestId('unlock-recovery')
      typeErase('DELETE')

      fireEvent.click(eraseButton())

      await waitFor(() => {
        expect(clearLocalDb).toHaveBeenCalledTimes(1)
      })
      expect(screen.queryByTestId('create-vault-screen')).toBeNull()

      pending.resolve(undefined)
      await screen.findByTestId('create-vault-screen')
      expect(screen.queryByTestId('unlock-recovery')).toBeNull()
    })

    it('stays in recovery and shows an error when clearing fails', async () => {
      vi.mocked(clearLocalDb).mockRejectedValue(new Error('blocked'))
      renderDialog()
      await screen.findByTestId('unlock-recovery')
      typeErase('DELETE')

      fireEvent.click(eraseButton())

      await screen.findByTestId('unlock-erase-error')
      expect(screen.getByTestId('unlock-recovery')).toBeTruthy()
      expect(screen.queryByTestId('create-vault-screen')).toBeNull()
    })
  })
})
