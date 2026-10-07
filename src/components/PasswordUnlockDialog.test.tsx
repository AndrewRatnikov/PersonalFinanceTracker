// No CONTRACT_GAPs: the PasswordUnlockDialog states and testids are fully
// specified in the Interface Contract.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkKeyVerifier,
  deriveKey,
  getOrCreateDeviceSalt,
  storeKeyVerifier,
} from '@/lib/crypto'
import { clearLocalDb, hasLocalData } from '@/lib/localDb'
import { PasswordUnlockDialog } from '@/components/PasswordUnlockDialog'

vi.mock('@/lib/localDb', () => ({
  hasLocalData: vi.fn(),
  clearLocalDb: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  checkKeyVerifier: vi.fn(),
  deriveKey: vi.fn(),
  getOrCreateDeviceSalt: vi.fn(),
  storeKeyVerifier: vi.fn(),
}))

const USER_ID = 'u1'
const VERIFIER_KEY = 'minima_key_verify_' + USER_ID

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderDialog(onUnlocked = vi.fn()) {
  render(<PasswordUnlockDialog userId={USER_ID} onUnlocked={onUnlocked} />)
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

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
})

describe('PasswordUnlockDialog without a verifier', () => {
  it('shows a checking state, with no form and no "Create password", while hasLocalData is pending', async () => {
    const pending = deferred<boolean>()
    vi.mocked(hasLocalData).mockReturnValue(pending.promise)

    renderDialog()

    expect(screen.getByTestId('unlock-checking')).toBeTruthy()
    expect(screen.queryByTestId('unlock-form')).toBeNull()
    expect(screen.queryByTestId('unlock-recovery')).toBeNull()
    expect(document.body.textContent).not.toContain('Create password')

    pending.resolve(false)
    await screen.findByTestId('unlock-form')
    expect(screen.queryByTestId('unlock-checking')).toBeNull()
  })

  it('offers the create-password flow when the store is empty', async () => {
    vi.mocked(hasLocalData).mockResolvedValue(false)

    renderDialog()

    const form = await screen.findByTestId('unlock-form')
    expect(form).toBeTruthy()
    expect(screen.getByTestId('unlock-submit').textContent).toBe(
      'Create password',
    )
    expect(document.querySelector('#password')).toBeTruthy()
    expect(document.querySelector('#confirm')).toBeTruthy()
    expect(screen.queryByTestId('unlock-recovery')).toBeNull()
  })

  it('shows the recovery state, never "Create password", when data keys exist', async () => {
    vi.mocked(hasLocalData).mockResolvedValue(true)

    renderDialog()

    await screen.findByTestId('unlock-recovery')
    expect(screen.queryByTestId('unlock-form')).toBeNull()
    expect(screen.queryByTestId('unlock-submit')).toBeNull()
    expect(screen.queryByTestId('unlock-checking')).toBeNull()
    expect(document.querySelector('#password')).toBeNull()
    expect(document.body.textContent).not.toContain('Create password')
    expect(eraseButton().textContent).toContain(
      'Erase local data and start fresh',
    )
  })

  it('falls back to the recovery state when the data check fails', async () => {
    vi.mocked(hasLocalData).mockRejectedValue(new Error('idb unavailable'))

    renderDialog()

    await screen.findByTestId('unlock-recovery')
    expect(screen.queryByTestId('unlock-form')).toBeNull()
    expect(document.body.textContent).not.toContain('Create password')
  })

  describe('erase confirmation', () => {
    beforeEach(() => {
      vi.mocked(hasLocalData).mockResolvedValue(true)
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
    })

    it('clears the local store and then continues to the create-password flow', async () => {
      vi.mocked(clearLocalDb).mockResolvedValue(undefined)
      renderDialog()
      await screen.findByTestId('unlock-recovery')
      typeErase('DELETE')

      fireEvent.click(eraseButton())

      const form = await screen.findByTestId('unlock-form')
      expect(clearLocalDb).toHaveBeenCalledTimes(1)
      expect(form).toBeTruthy()
      expect(screen.getByTestId('unlock-submit').textContent).toBe(
        'Create password',
      )
      expect(screen.queryByTestId('unlock-recovery')).toBeNull()
      expect(document.querySelector('#confirm')).toBeTruthy()
    })

    it('stays in recovery and shows an error when clearing fails', async () => {
      vi.mocked(clearLocalDb).mockRejectedValue(new Error('blocked'))
      renderDialog()
      await screen.findByTestId('unlock-recovery')
      typeErase('DELETE')

      fireEvent.click(eraseButton())

      await screen.findByTestId('unlock-erase-error')
      expect(screen.getByTestId('unlock-recovery')).toBeTruthy()
      expect(screen.queryByTestId('unlock-form')).toBeNull()
      expect(document.body.textContent).not.toContain('Create password')
    })
  })

  it('creates the password after an empty-store check: stores the verifier and unlocks as a new user', async () => {
    vi.mocked(hasLocalData).mockResolvedValue(false)
    const key = { fake: 'key' } as unknown as CryptoKey
    vi.mocked(getOrCreateDeviceSalt).mockReturnValue(new Uint8Array(16))
    vi.mocked(deriveKey).mockResolvedValue(key)
    vi.mocked(storeKeyVerifier).mockResolvedValue(undefined)
    const onUnlocked = renderDialog()
    const form = await screen.findByTestId('unlock-form')

    fireEvent.change(document.querySelector('#password') as HTMLInputElement, {
      target: { value: 'correct horse' },
    })
    fireEvent.change(document.querySelector('#confirm') as HTMLInputElement, {
      target: { value: 'correct horse' },
    })
    fireEvent.submit(form)

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith(key, true)
    })
    expect(storeKeyVerifier).toHaveBeenCalledWith(key, USER_ID)
  })
})

describe('PasswordUnlockDialog with a verifier', () => {
  beforeEach(() => {
    localStorage.setItem(VERIFIER_KEY, 'verifier')
  })

  it('shows the unlock form without needing the data check', async () => {
    vi.mocked(hasLocalData).mockResolvedValue(true)

    renderDialog()

    expect(screen.getByTestId('unlock-form')).toBeTruthy()
    expect(screen.getByTestId('unlock-submit').textContent).toBe('Unlock')
    expect(document.querySelector('#password')).toBeTruthy()
    expect(document.querySelector('#confirm')).toBeNull()
    expect(screen.queryByTestId('unlock-recovery')).toBeNull()
    expect(screen.queryByTestId('unlock-checking')).toBeNull()
    expect(document.body.textContent).not.toContain('Create password')
    await waitFor(() => {
      expect(hasLocalData).not.toHaveBeenCalled()
    })
  })

  it('unlocks with the right password and reports isNewUser false', async () => {
    const key = { fake: 'key' } as unknown as CryptoKey
    vi.mocked(getOrCreateDeviceSalt).mockReturnValue(new Uint8Array(16))
    vi.mocked(deriveKey).mockResolvedValue(key)
    vi.mocked(checkKeyVerifier).mockResolvedValue(true)
    const onUnlocked = renderDialog()

    fireEvent.change(document.querySelector('#password') as HTMLInputElement, {
      target: { value: 'correct horse' },
    })
    fireEvent.submit(screen.getByTestId('unlock-form'))

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith(key, false)
    })
  })

  it('does not unlock with the wrong password', async () => {
    vi.mocked(getOrCreateDeviceSalt).mockReturnValue(new Uint8Array(16))
    vi.mocked(deriveKey).mockResolvedValue({} as CryptoKey)
    vi.mocked(checkKeyVerifier).mockResolvedValue(false)
    const onUnlocked = renderDialog()

    fireEvent.change(document.querySelector('#password') as HTMLInputElement, {
      target: { value: 'wrong password' },
    })
    fireEvent.submit(screen.getByTestId('unlock-form'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('Incorrect password')
    })
    expect(onUnlocked).not.toHaveBeenCalled()
  })
})
