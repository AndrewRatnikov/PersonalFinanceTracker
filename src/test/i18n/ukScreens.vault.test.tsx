// CONTRACT_GAP: the Ukrainian wording of these screens is the Coder's, so each
// screen is checked for what must not be there (the English words Save, Cancel,
// Add, Delete, Settings, Income, Expenses, in text and in aria-label /
// placeholder / title / alt attributes) and for what must be there (Cyrillic
// text, the plan's key texts where the plan fixes them).
// Fixture user data (passwords, keys) contains none of the checked words.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { setLang, translate } from '@/i18n/core'
import { I18nProvider } from '@/i18n/react'
import { useAccountsVisible } from '@/lib/accountSession'
import {
  createVault,
  resetPasswordWithRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
} from '@/lib/vault'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import Header from '@/components/Header'
import LandingPage from '@/components/LandingPage'
import { CreateVaultScreen } from '@/components/vault/CreateVaultScreen'
import { RecoverScreen } from '@/components/vault/RecoverScreen'
import { UnlockScreen } from '@/components/vault/UnlockScreen'

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

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children?: ReactNode
    [key: string]: unknown
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/accountSession', () => ({ useAccountsVisible: vi.fn() }))
vi.mock('@/lib/vault', () => ({
  lockVault: vi.fn(),
  createVault: vi.fn(),
  unlockWithPassword: vi.fn(),
  unlockWithRecoveryKey: vi.fn(),
  resetPasswordWithRecoveryKey: vi.fn(),
  VaultError: MockVaultError,
}))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('@/lib/appSettings', () => ({ updateAppSettings: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: () => null,
}))

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'
const CYRILLIC = /[Ѐ-ӿ]/
const FORBIDDEN = /\b(Save|Cancel|Add|Delete|Settings|Income|Expenses)\b/

// Everything a user can see or hear on the page: text plus the accessible
// attributes.
function visibleStrings(): Array<string> {
  const strings = [document.body.textContent]
  for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
    document.body
      .querySelectorAll(`[${attribute}]`)
      .forEach((el) => strings.push(el.getAttribute(attribute) ?? ''))
  }
  return strings
}

function expectUkrainianOnly() {
  const strings = visibleStrings()

  expect(strings.join('\n')).toMatch(CYRILLIC)
  expect(strings.filter((s) => FORBIDDEN.test(s))).toEqual([])
}

function renderUk(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLang="uk">{ui}</I18nProvider>
    </QueryClientProvider>,
  )
}

function submitOf(testId: string) {
  const form = screen.getByTestId(testId).closest('form')
  if (!form) throw new Error(`${testId} is not inside a form`)
  fireEvent.submit(form)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  setLang('en', { persist: false })
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  setVaultPhase('none')
  cancelCreateVault()
  Object.defineProperty(navigator, 'storage', {
    value: { persist: () => Promise.resolve(true) },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'storage')
  setLang('en', { persist: false })
  localStorage.clear()
})

describe('landing page in Ukrainian', () => {
  it('has no English UI words, with the Ukrainian hero and the header toggle on UK', () => {
    renderUk(
      <>
        <Header />
        <LandingPage />
      </>,
    )

    expect(screen.getByTestId('landing-page')).toBeTruthy()
    expect(screen.getByTestId('landing-page').textContent).toContain(
      translate('uk', 'landing.heroTitle'),
    )
    expect(screen.getByTestId('landing-page').textContent).not.toContain(
      'Track your money.',
    )
    expect(screen.getByTestId('landing-language-uk').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expectUkrainianOnly()
  })

  it('translates the call-to-action buttons and the header buttons', () => {
    renderUk(
      <>
        <Header />
        <LandingPage />
      </>,
    )

    for (const id of [
      'landing-start-tracking',
      'landing-restore-backup',
      'header-start-tracking',
    ]) {
      expect(screen.getByTestId(id).textContent, id).toMatch(CYRILLIC)
    }
  })

  it('is English in English', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLang="en">
          <LandingPage />
        </I18nProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByTestId('landing-page').textContent).toContain('Track your money.')
    expect(screen.getByTestId('landing-page').textContent).not.toMatch(CYRILLIC)
  })
})

describe('create vault in Ukrainian', () => {
  it('password step', () => {
    renderUk(<CreateVaultScreen onCreated={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByTestId('create-vault-screen')).toBeTruthy()
    expect(screen.getByTestId('create-vault-submit').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('strength hint and validation errors', () => {
    renderUk(<CreateVaultScreen onCreated={vi.fn()} />)
    const hint = () => screen.getByTestId('create-vault-strength').textContent
    const fill = (password: string, confirm: string) => {
      fireEvent.change(screen.getByTestId('create-vault-password-input'), {
        target: { value: password },
      })
      fireEvent.change(screen.getByTestId('create-vault-confirm-input'), {
        target: { value: confirm },
      })
    }

    fill('short', '')
    expect(hint()).toMatch(CYRILLIC)
    const shortHint = hint()
    fill('a-much-longer-password', '')
    expect(hint()).toMatch(CYRILLIC)
    expect(hint()).not.toBe(shortHint)

    fill('short', 'short')
    submitOf('create-vault-submit')
    expect(screen.getByTestId('create-vault-error').textContent).toMatch(CYRILLIC)
    expect(createVault).not.toHaveBeenCalled()
    const tooShort = screen.getByTestId('create-vault-error').textContent

    fill('long enough 1', 'long enough 2')
    submitOf('create-vault-submit')
    expect(screen.getByTestId('create-vault-error').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('create-vault-error').textContent).not.toBe(tooShort)
    expectUkrainianOnly()
  })

  it('recovery key step', async () => {
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    renderUk(<CreateVaultScreen onCreated={vi.fn()} />)
    fireEvent.change(screen.getByTestId('create-vault-password-input'), {
      target: { value: 'long enough 1' },
    })
    fireEvent.change(screen.getByTestId('create-vault-confirm-input'), {
      target: { value: 'long enough 1' },
    })

    submitOf('create-vault-submit')

    await screen.findByTestId('recovery-key-step')
    expect(screen.getByTestId('recovery-key-value').textContent).toContain(KEY.slice(0, 5))
    for (const id of ['recovery-key-copy', 'recovery-key-download', 'recovery-key-print']) {
      expect(screen.getByTestId(id).textContent, id).toMatch(CYRILLIC)
    }
    expectUkrainianOnly()
  })
})

describe('unlock in Ukrainian', () => {
  it('shows the screen, the forgot-password link and the toggle on UK', () => {
    renderUk(
      <UnlockScreen legacy={false} onUnlocked={vi.fn()} onForgotPassword={vi.fn()} />,
    )

    expect(screen.getByTestId('unlock-screen')).toBeTruthy()
    expect(screen.getByTestId('unlock-submit').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('unlock-forgot-password').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('unlock-language-uk').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expectUkrainianOnly()
  })

  it('the legacy variant has no English words either', () => {
    renderUk(
      <UnlockScreen legacy onUnlocked={vi.fn()} onForgotPassword={vi.fn()} />,
    )

    expectUkrainianOnly()
  })

  it('shows a wrong password in Ukrainian', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    renderUk(
      <UnlockScreen legacy={false} onUnlocked={vi.fn()} onForgotPassword={vi.fn()} />,
    )
    fireEvent.change(screen.getByTestId('unlock-password-input'), {
      target: { value: 'wrong' },
    })

    submitOf('unlock-submit')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toBe('Неправильний пароль')
    })
    expectUkrainianOnly()
  })
})

describe('recover in Ukrainian', () => {
  it('key step', () => {
    renderUk(
      <RecoverScreen onRecovered={vi.fn()} onCancel={vi.fn()} onLostBoth={vi.fn()} />,
    )

    expect(screen.getByTestId('recover-screen')).toBeTruthy()
    expect(screen.getByTestId('recover-key-submit').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('recover-cancel').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('recover-lost-both').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('password step', async () => {
    vi.mocked(unlockWithRecoveryKey).mockResolvedValue(undefined)
    vi.mocked(resetPasswordWithRecoveryKey).mockResolvedValue(undefined)
    renderUk(<RecoverScreen onRecovered={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByTestId('recover-key-input'), { target: { value: KEY } })
    submitOf('recover-key-submit')
    await screen.findByTestId('recover-password-input')

    expect(screen.getByTestId('recover-password-submit').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()

    fireEvent.change(screen.getByTestId('recover-password-input'), {
      target: { value: 'short' },
    })
    fireEvent.change(screen.getByTestId('recover-confirm-input'), {
      target: { value: 'short' },
    })
    submitOf('recover-password-submit')

    expect(screen.getByTestId('recover-error').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('shows a wrong recovery key in Ukrainian', async () => {
    vi.mocked(unlockWithRecoveryKey).mockRejectedValue(
      new MockVaultError('incorrect-recovery-key', 'Incorrect recovery key'),
    )
    renderUk(<RecoverScreen onRecovered={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByTestId('recover-key-input'), {
      target: { value: 'WRONG' },
    })

    submitOf('recover-key-submit')

    const error = await screen.findByTestId('recover-error')
    expect(error.textContent).toMatch(CYRILLIC)
    expect(error.textContent).not.toContain('Incorrect')
  })
})
