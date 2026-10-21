// CONTRACT_GAP: the aria-label of the LanguageToggle group (t('common.language'))
// and the position of its optional className are not in the plan's key table,
// so only the role, the testids and aria-pressed are asserted.
// CONTRACT_GAP: which visible texts change on a language switch is the Coder's
// wording, so the tests compare a text before and after the switch (it must
// differ) instead of asserting the Ukrainian words.
// Header, UnlockScreen, CreateVaultScreen, RecoverScreen and GeneralTab are
// rendered with the same mocks as their own test files.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type * as AppSettings from '@/lib/appSettings'
import type { Lang } from '@/i18n/lang'
import { setLang, translate } from '@/i18n/core'
import { I18nProvider, useT } from '@/i18n/react'
import { getCurrencySettings } from '@/lib/appSettings'
import { useAccountsVisible } from '@/lib/accountSession'
import { getConversionStatus } from '@/lib/conversion'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import Header from '@/components/Header'
import { LanguageToggle } from '@/components/LanguageToggle'
import { GeneralTab } from '@/components/settings/GeneralTab'
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
vi.mock('@/lib/localDb', () => ({}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  updateAppSettings: vi.fn(),
  getCurrencySettings: vi.fn(),
  updateCurrencySettings: vi.fn(),
}))
vi.mock('@/lib/conversion', () => {
  class FakeMainCurrencyChangeError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'MainCurrencyChangeError'
      this.code = code
    }
  }
  return {
    CONVERSION_STATUS_QUERY_KEY: ['conversion-status'],
    MainCurrencyChangeError: FakeMainCurrencyChangeError,
    getConversionStatus: vi.fn(),
    changeMainCurrency: vi.fn(),
    requestConversion: vi.fn(),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function clearPersistedLang() {
  localStorage.clear()
  document.cookie = 'minima_lang=; Path=/; Max-Age=0'
}

function renderWithProviders(ui: ReactNode, lang: Lang = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLang={lang}>{ui}</I18nProvider>
    </QueryClientProvider>,
  )
}

const pressed = (base: string, lang: Lang) =>
  screen.getByTestId(`${base}-${lang}`).getAttribute('aria-pressed')

// Clicks UK, then EN, on the toggle `base` and checks that `textOf` changes with
// the language each time.
function expectToggleSwitches(base: string, textOf: () => string) {
  const english = textOf()
  expect(pressed(base, 'en')).toBe('true')
  expect(pressed(base, 'uk')).toBe('false')

  fireEvent.click(screen.getByTestId(`${base}-uk`))

  expect(document.documentElement.lang).toBe('uk')
  expect(pressed(base, 'uk')).toBe('true')
  expect(pressed(base, 'en')).toBe('false')
  const ukrainian = textOf()
  expect(ukrainian).not.toBe(english)
  expect(ukrainian).toMatch(/[Ѐ-ӿ]/)
  expect(localStorage.getItem('minima_lang')).toBe('uk')
  expect(document.cookie).toContain('minima_lang=uk')

  fireEvent.click(screen.getByTestId(`${base}-en`))

  expect(document.documentElement.lang).toBe('en')
  expect(pressed(base, 'en')).toBe('true')
  expect(textOf()).toBe(english)
  expect(localStorage.getItem('minima_lang')).toBe('en')
}

beforeEach(() => {
  vi.clearAllMocks()
  clearPersistedLang()
  setLang('en', { persist: false })
  document.documentElement.lang = 'en'
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  setVaultPhase('checking')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
  clearPersistedLang()
  setLang('en', { persist: false })
})

describe('I18nProvider and useT', () => {
  function Switcher() {
    const { lang, setLang: choose, t, plural } = useT()
    return (
      <div>
        <p>{`${lang}|${t('errors.vault.incorrectPassword')}|${plural('records', 2)}`}</p>
        <button type="button" onClick={() => choose('uk')}>
          {'go-uk'}
        </button>
        <button type="button" onClick={() => choose('en')}>
          {'go-en'}
        </button>
      </div>
    )
  }

  it('switches the visible text immediately, without a reload', () => {
    const { container } = renderWithProviders(<Switcher />)
    expect(container.textContent).toContain('en|Incorrect password|2 records')

    fireEvent.click(screen.getByText('go-uk'))

    expect(container.textContent).toContain('uk|Неправильний пароль|2 записи')

    fireEvent.click(screen.getByText('go-en'))

    expect(container.textContent).toContain('en|Incorrect password|2 records')
  })

  it('sets <html lang> and writes localStorage and the cookie', () => {
    renderWithProviders(<Switcher />)

    fireEvent.click(screen.getByText('go-uk'))

    expect(document.documentElement.lang).toBe('uk')
    expect(localStorage.getItem('minima_lang')).toBe('uk')
    expect(document.cookie).toContain('minima_lang=uk')

    fireEvent.click(screen.getByText('go-en'))

    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('minima_lang')).toBe('en')
    expect(document.cookie).toContain('minima_lang=en')
  })
})

describe('LanguageToggle', () => {
  it('is a group with a UK and an EN button, EN pressed in English', () => {
    renderWithProviders(<LanguageToggle testId="landing-language" />)

    const group = screen.getByTestId('landing-language')
    expect(group.getAttribute('role')).toBe('group')
    const uk = screen.getByTestId<HTMLButtonElement>('landing-language-uk')
    const en = screen.getByTestId<HTMLButtonElement>('landing-language-en')
    expect(uk.type).toBe('button')
    expect(en.type).toBe('button')
    expect(uk.textContent).toBe(translate('en', 'common.languageShort.uk'))
    expect(en.textContent).toBe(translate('en', 'common.languageShort.en'))
    expect(uk.textContent).toBe('UK')
    expect(en.textContent).toBe('EN')
    expect(uk.getAttribute('aria-pressed')).toBe('false')
    expect(en.getAttribute('aria-pressed')).toBe('true')
  })

  it('presses UK when the provider starts in Ukrainian', () => {
    renderWithProviders(<LanguageToggle testId="unlock-language" />, 'uk')

    expect(pressed('unlock-language', 'uk')).toBe('true')
    expect(pressed('unlock-language', 'en')).toBe('false')
  })

  it('a click switches the language, <html lang> and persists it', () => {
    renderWithProviders(<LanguageToggle testId="landing-language" />)

    fireEvent.click(screen.getByTestId('landing-language-uk'))

    expect(pressed('landing-language', 'uk')).toBe('true')
    expect(document.documentElement.lang).toBe('uk')
    expect(localStorage.getItem('minima_lang')).toBe('uk')
    expect(document.cookie).toContain('minima_lang=uk')
  })

  it('follows a language change made elsewhere', () => {
    renderWithProviders(<LanguageToggle testId="landing-language" />)

    act(() => {
      setLang('uk', { persist: false })
    })

    expect(pressed('landing-language', 'uk')).toBe('true')
    expect(pressed('landing-language', 'en')).toBe('false')
  })

  it('two toggles on a page stay in sync', () => {
    renderWithProviders(
      <>
        <LanguageToggle testId="landing-language" />
        <LanguageToggle testId="unlock-language" />
      </>,
    )

    fireEvent.click(screen.getByTestId('landing-language-uk'))

    expect(pressed('unlock-language', 'uk')).toBe('true')
  })
})

describe('landing header switcher', () => {
  it('is in the header when the app is locked and switches the visible text', () => {
    setVaultPhase('none')
    renderWithProviders(<Header />)

    expect(screen.getByTestId('landing-language')).toBeTruthy()
    expectToggleSwitches(
      'landing-language',
      () => screen.getByTestId('header-start-tracking').textContent,
    )
  })

  it('is not in the header once the vault is unlocked', () => {
    setVaultPhase('unlocked')
    renderWithProviders(<Header />)

    expect(screen.queryByTestId('landing-language')).toBeNull()
  })
})

describe('vault screen switchers', () => {
  it('the unlock screen has a toggle that switches its text', () => {
    renderWithProviders(
      <UnlockScreen legacy={false} onUnlocked={vi.fn()} onForgotPassword={vi.fn()} />,
    )

    expectToggleSwitches(
      'unlock-language',
      () => screen.getByTestId('unlock-submit').textContent,
    )
  })

  it('the create-vault screen has a toggle that switches its text', () => {
    renderWithProviders(<CreateVaultScreen onCreated={vi.fn()} />)

    expectToggleSwitches(
      'create-vault-language',
      () => screen.getByTestId('create-vault-submit').textContent,
    )
  })

  it('the recover screen has a toggle that switches its text', () => {
    renderWithProviders(<RecoverScreen onRecovered={vi.fn()} onCancel={vi.fn()} />)

    expectToggleSwitches(
      'recover-language',
      () => screen.getByTestId('recover-key-submit').textContent,
    )
  })
})

describe('Settings language select', () => {
  async function renderGeneralTab(lang: Lang = 'en') {
    vi.mocked(getCurrencySettings).mockResolvedValue({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
    vi.mocked(getConversionStatus).mockResolvedValue({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
      totalEntries: 3,
      pendingEntries: 0,
      pendingBudgets: 0,
    })
    const view = renderWithProviders(<GeneralTab />, lang)
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLSelectElement>('settings-main-currency').value,
      ).toBe('UAH')
    })
    return view
  }

  it('is a native select with Ukrainian and English options, labelled "Мова / Language"', async () => {
    await renderGeneralTab()

    const select = screen.getByTestId<HTMLSelectElement>('settings-language')
    expect(select.tagName).toBe('SELECT')
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['uk', translate('en', 'common.languageName.uk')],
      ['en', translate('en', 'common.languageName.en')],
    ])
    expect(select.value).toBe('en')
    expect(screen.getAllByText('Мова / Language').length).toBeGreaterThan(0)
  })

  it('changing it switches the visible text, <html lang> and persists the choice', async () => {
    await renderGeneralTab()
    const helpText = () => screen.getByTestId('settings-fetch-rates-help').textContent
    const english = helpText()

    fireEvent.change(screen.getByTestId('settings-language'), {
      target: { value: 'uk' },
    })

    expect(document.documentElement.lang).toBe('uk')
    expect(helpText()).not.toBe(english)
    expect(helpText()).toMatch(/[Ѐ-ӿ]/)
    expect(screen.getByTestId<HTMLSelectElement>('settings-language').value).toBe('uk')
    expect(localStorage.getItem('minima_lang')).toBe('uk')
    expect(document.cookie).toContain('minima_lang=uk')

    fireEvent.change(screen.getByTestId('settings-language'), {
      target: { value: 'en' },
    })

    expect(document.documentElement.lang).toBe('en')
    expect(helpText()).toBe(english)
    expect(localStorage.getItem('minima_lang')).toBe('en')
  })

  it('keeps the same bilingual label in both languages and shows the stored language', async () => {
    await renderGeneralTab('uk')

    expect(screen.getByTestId<HTMLSelectElement>('settings-language').value).toBe('uk')
    expect(screen.getAllByText('Мова / Language').length).toBeGreaterThan(0)
  })
})
