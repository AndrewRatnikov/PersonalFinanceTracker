// CONTRACT_GAP: the catalog keys behind most errorMessage() results
// (errors.vault.*, errors.backup.*, errors.app.*, errors.decrypt) are not in the
// plan's key table, so those cases assert behaviour (English text differs from
// the raw message, the Ukrainian text is Cyrillic and differs from the English
// one, params are interpolated) instead of exact wording. Exact texts are
// pinned only for the keys the plan lists.
// Errors are built from local classes that carry the same name / code fields as
// VaultError, BackupError, MainCurrencyChangeError and DecryptError, because
// src/i18n/errors.ts recognises them by duck typing and must not import them.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AppSettings from '@/lib/appSettings'
import type { CurrencySettings } from '@/lib/appSettings'
import { I18nProvider } from '@/i18n/react'
import { setLang, translate } from '@/i18n/core'
import { errorMessage, validationMessage } from '@/i18n/errors'
import { getCurrencySettings } from '@/lib/appSettings'
import { AppError, isAppError } from '@/lib/appErrors'
import { MainCurrencyChangeError, changeMainCurrency, getConversionStatus } from '@/lib/conversion'
import { recurringInputSchema } from '@/lib/schemas'
import { unlockWithPassword } from '@/lib/vault'
import { GeneralTab } from '@/components/settings/GeneralTab'
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

vi.mock('@/lib/vault', () => ({
  unlockWithPassword: vi.fn(),
  VaultError: MockVaultError,
}))
vi.mock('@/lib/localDb', () => ({}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
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

class NamedError extends Error {
  readonly code: string
  readonly extra: Record<string, unknown>
  constructor(name: string, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = name
    this.code = code
    this.extra = extra
    Object.assign(this, extra)
  }
}

const RAW = 'RAW-TECHNICAL-MESSAGE'
const CYRILLIC = /[Ѐ-ӿ]/

function inEnglish<T>(fn: () => T): T {
  setLang('en', { persist: false })
  return fn()
}

function inUkrainian<T>(fn: () => T): T {
  setLang('uk', { persist: false })
  return fn()
}

beforeEach(() => {
  setLang('en', { persist: false })
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
  vi.clearAllMocks()
})

describe('AppError', () => {
  it('carries a code, params and the English message', () => {
    const err = new AppError('category-exists', 'Category "Food" already exists', {
      name: 'Food',
    })

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AppError')
    expect(err.code).toBe('category-exists')
    expect(err.params).toEqual({ name: 'Food' })
    expect(err.message).toBe('Category "Food" already exists')
  })

  it('params default to an empty object', () => {
    expect(new AppError('invalid-currency', 'Invalid currency').params).toEqual({})
  })

  it('isAppError recognises AppError instances and look-alikes only', () => {
    expect(isAppError(new AppError('invalid-currency', 'x'))).toBe(true)
    expect(isAppError(new NamedError('AppError', 'category-exists', 'x'))).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError(new NamedError('VaultError', 'damaged', 'x'))).toBe(false)
    expect(isAppError({ code: 'category-exists' })).toBe(false)
    expect(isAppError(null)).toBe(false)
    expect(isAppError('category-exists')).toBe(false)
  })
})

describe('validationMessage', () => {
  it.each([
    ['errors.validation.amountPositive', 'Amount must be greater than 0', 'Сума має бути більшою за 0'],
    ['errors.validation.categoryRequired', 'Category is required', undefined],
    ['errors.validation.dateRequired', 'Date is required', undefined],
    ['errors.validation.invalidDate', 'Invalid date', undefined],
    ['errors.validation.intervalRange', 'Interval must be a whole number from 1 to 365', undefined],
    ['errors.validation.wholeNumber', 'Must be a whole number', undefined],
    ['errors.validation.atLeastOne', 'Must be at least 1', undefined],
    ['errors.validation.endBeforeStart', "End date can't be before the start date", undefined],
    ['errors.validation.categoryNotFound', 'Category not found', undefined],
  ])('%s', (key, english, ukrainian) => {
    expect(inEnglish(() => validationMessage(key))).toBe(english)

    const uk = inUkrainian(() => validationMessage(key))
    if (ukrainian !== undefined) expect(uk).toBe(ukrainian)
    expect(uk).not.toBe(english)
    expect(uk).toMatch(CYRILLIC)
  })

  it('leaves a message that is not a validation key unchanged', () => {
    expect(validationMessage('Something custom')).toBe('Something custom')
    expect(inUkrainian(() => validationMessage('Something custom'))).toBe('Something custom')
    expect(validationMessage('errors.validation.doesNotExist')).toBe(
      'errors.validation.doesNotExist',
    )
  })

  it('shows a zod message from the real schema in Ukrainian', () => {
    const result = recurringInputSchema.safeParse({
      kind: 'expense',
      amount: 0,
      currency: 'UAH',
      categoryId: 'c1',
      description: null,
      frequency: { unit: 'month', interval: 1 },
      startDate: '2026-03-01',
      end: { type: 'never' },
      mode: 'auto',
    })
    const issue = result.error?.issues.find((i) => i.path.join('.') === 'amount')

    expect(issue?.message).toBe('errors.validation.amountPositive')
    expect(inUkrainian(() => validationMessage(issue?.message ?? ''))).toBe(
      'Сума має бути більшою за 0',
    )
    expect(inEnglish(() => validationMessage(issue?.message ?? ''))).toBe(
      'Amount must be greater than 0',
    )
  })
})

describe('errorMessage: VaultError', () => {
  it('maps a wrong password in both languages', () => {
    const err = new NamedError('VaultError', 'incorrect-password', RAW)

    expect(inEnglish(() => errorMessage(err))).toBe('Incorrect password')
    expect(inUkrainian(() => errorMessage(err))).toBe('Неправильний пароль')
  })

  it.each(['incorrect-password', 'incorrect-recovery-key', 'damaged', 'throttled', 'invalid-state'])(
    'maps the %s code to a catalog text',
    (code) => {
      const err = new NamedError('VaultError', code, RAW, { retryAfterMs: 5000 })
      const en = inEnglish(() => errorMessage(err))
      const uk = inUkrainian(() => errorMessage(err))

      expect(en).not.toBe(RAW)
      expect(en).not.toBe('')
      expect(uk).toMatch(CYRILLIC)
      expect(uk).not.toBe(en)
    },
  )

  it('different codes give different texts', () => {
    const a = errorMessage(new NamedError('VaultError', 'damaged', RAW))
    const b = errorMessage(new NamedError('VaultError', 'incorrect-password', RAW))

    expect(a).not.toBe(b)
  })

  it('the throttle message carries the wait in whole seconds, rounded up', () => {
    const wait = (ms: number) =>
      errorMessage(new NamedError('VaultError', 'throttled', RAW, { retryAfterMs: ms }))

    expect(wait(5000)).toContain('5')
    expect(wait(5000)).not.toContain('61')
    expect(wait(4500)).toBe(wait(5000))
    expect(wait(61000)).toContain('61')
    expect(wait(61000)).not.toBe(wait(5000))
    expect(inUkrainian(() => wait(61000))).toContain('61')
  })
})

describe('errorMessage: BackupError', () => {
  it.each(['invalid-file', 'unsupported-version', 'wrong-secret', 'damaged', 'invalid-state'])(
    'maps the %s code to a catalog text',
    (code) => {
      const err = new NamedError('BackupError', code, RAW)
      const en = inEnglish(() => errorMessage(err))
      const uk = inUkrainian(() => errorMessage(err))

      expect(en).not.toBe(RAW)
      expect(uk).toMatch(CYRILLIC)
      expect(uk).not.toBe(en)
    },
  )

  it('tells a compressed-backup refusal apart from a plain invalid file', () => {
    const plain = new NamedError('BackupError', 'invalid-file', RAW)
    const compressed = new NamedError('BackupError', 'invalid-file', RAW, {
      reason: 'compression',
    })

    expect(errorMessage(compressed)).not.toBe(errorMessage(plain))
    expect(errorMessage(compressed)).not.toBe(RAW)
    expect(inUkrainian(() => errorMessage(compressed))).toMatch(CYRILLIC)
  })
})

describe('errorMessage: MainCurrencyChangeError', () => {
  it('maps an offline change to the catalog text in both languages', () => {
    const err = new NamedError('MainCurrencyChangeError', 'offline', RAW)

    expect(inEnglish(() => errorMessage(err))).toBe(
      "You're offline. Connect to the internet to change the main currency.",
    )
    expect(inUkrainian(() => errorMessage(err))).toBe(
      'Ви офлайн. Підключіться до інтернету, щоб змінити основну валюту.',
    )
  })

  it.each(['rates-off', 'rates-unavailable'])('maps the %s code', (code) => {
    const err = new NamedError('MainCurrencyChangeError', code, RAW)
    const en = inEnglish(() => errorMessage(err))
    const uk = inUkrainian(() => errorMessage(err))

    expect(en).not.toBe(RAW)
    expect(uk).toMatch(CYRILLIC)
    expect(uk).not.toBe(en)
  })

  it('keeps the English wording of today for the two other refusals', () => {
    expect(
      errorMessage(new NamedError('MainCurrencyChangeError', 'rates-off', RAW)),
    ).toBe(
      'Turn on exchange rates from the National Bank of Ukraine to change the main currency.',
    )
    expect(
      errorMessage(new NamedError('MainCurrencyChangeError', 'rates-unavailable', RAW)),
    ).toBe(
      "Couldn't get today's exchange rates from the National Bank of Ukraine. Try again later.",
    )
  })
})

describe('errorMessage: AppError', () => {
  it('interpolates the category name in both languages', () => {
    const err = new AppError('category-exists', RAW, { name: 'Food' })

    expect(inEnglish(() => errorMessage(err))).toBe('Category "Food" already exists')
    expect(inUkrainian(() => errorMessage(err))).toBe('Категорія «Food» вже існує')
  })

  it('uses the params of each error', () => {
    const a = errorMessage(new AppError('category-exists', RAW, { name: 'Food' }))
    const b = errorMessage(new AppError('category-exists', RAW, { name: 'Rent' }))

    expect(a).toContain('Food')
    expect(b).toContain('Rent')
    expect(b).not.toContain('Food')
  })

  it.each([
    'category-name-required',
    'category-exists',
    'category-not-found',
    'invalid-currency',
    'category-used-by-expenses',
    'category-used-by-income',
    'category-used-by-recurring',
    'recurring-not-found',
    'occurrence-not-due',
    'import-needs-categories',
    'import-empty-file',
    'import-unknown-columns',
  ] as const)('maps the %s code to a catalog text', (code) => {
    const err = new AppError(code, RAW, {
      name: 'Food',
      count: 3,
      id: 'r1',
      file: 'expenses.csv',
      columns: 'a, b',
    })
    const en = inEnglish(() => errorMessage(err))
    const uk = inUkrainian(() => errorMessage(err))

    expect(en).not.toBe(RAW)
    expect(en).not.toBe('')
    expect(uk).toMatch(CYRILLIC)
    expect(uk).not.toBe(en)
  })

  it('the "used by" messages carry the count', () => {
    const used = (count: number) =>
      errorMessage(new AppError('category-used-by-expenses', RAW, { count }))

    expect(used(1)).toContain('1')
    expect(used(3)).toContain('3')
    expect(used(1)).not.toBe(used(3))
    expect(inUkrainian(() => used(5))).toContain('5')
  })

  it('a validation error shows the validation text of its key', () => {
    const err = new AppError('validation', 'Amount must be greater than 0', {
      key: 'errors.validation.amountPositive',
    })

    expect(inEnglish(() => errorMessage(err))).toBe('Amount must be greater than 0')
    expect(inUkrainian(() => errorMessage(err))).toBe('Сума має бути більшою за 0')

    const other = new AppError('validation', 'Invalid date', {
      key: 'errors.validation.invalidDate',
    })
    expect(inEnglish(() => errorMessage(other))).toBe('Invalid date')
  })
})

describe('errorMessage: other errors', () => {
  it('DecryptError maps to a catalog text', () => {
    const err = new NamedError('DecryptError', 'x', RAW)
    const en = inEnglish(() => errorMessage(err))
    const uk = inUkrainian(() => errorMessage(err))

    expect(en).not.toBe(RAW)
    expect(en).not.toBe('')
    expect(uk).toMatch(CYRILLIC)
    expect(uk).not.toBe(en)
  })

  it('a plain Error keeps its own message in any language', () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full')
    expect(inUkrainian(() => errorMessage(new Error('network down')))).toBe('network down')
  })

  it('anything else gives the generic message', () => {
    for (const value of [undefined, null, 42, 'boom', {}, { message: 'x' }, new Error('')]) {
      expect(inEnglish(() => errorMessage(value))).toBe(
        'Something went wrong. Please try again.',
      )
    }
    expect(inUkrainian(() => errorMessage(null))).toBe(
      translate('uk', 'errors.unexpected'),
    )
    expect(inUkrainian(() => errorMessage(null))).toMatch(CYRILLIC)
  })
})

function renderUnlock(lang: 'uk' | 'en') {
  return render(
    <I18nProvider initialLang={lang}>
      <UnlockScreen legacy={false} onUnlocked={vi.fn()} onForgotPassword={vi.fn()} />
    </I18nProvider>,
  )
}

function submitUnlock(password: string) {
  fireEvent.change(screen.getByTestId('unlock-password-input'), {
    target: { value: password },
  })
  const form = screen.getByTestId('unlock-submit').closest('form')
  if (!form) throw new Error('submit button is not inside a form')
  fireEvent.submit(form)
}

describe('UnlockScreen shows the wrong-password error in the UI language', () => {
  it('Ukrainian', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    renderUnlock('uk')

    submitUnlock('wrong')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toBe('Неправильний пароль')
    })
  })

  it('English', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    renderUnlock('en')

    submitUnlock('wrong')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toBe('Incorrect password')
    })
  })
})

function setSettings(settings: Partial<CurrencySettings> = {}) {
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    ...settings,
  })
}

async function openMainCurrencyDialog(lang: 'uk' | 'en') {
  setSettings()
  vi.mocked(getConversionStatus).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    totalEntries: 480,
    pendingEntries: 0,
    pendingBudgets: 0,
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLang={lang}>
        <GeneralTab />
      </I18nProvider>
    </QueryClientProvider>,
  )
  const select = () => screen.getByTestId<HTMLSelectElement>('settings-main-currency')
  await waitFor(() => {
    expect(select().value).toBe('UAH')
  })
  await waitFor(() => {
    expect(screen.getByTestId('settings-conversion-status').textContent.trim()).not.toBe('')
  })
  fireEvent.change(select(), { target: { value: 'EUR' } })
  await screen.findByTestId('main-currency-confirm-dialog')
}

describe('GeneralTab shows an offline main-currency change in the UI language', () => {
  const RefusalError = MainCurrencyChangeError as unknown as new (
    code: string,
    message: string,
  ) => Error

  it('Ukrainian', async () => {
    vi.mocked(changeMainCurrency).mockRejectedValue(
      new RefusalError(
        'offline',
        "You're offline. Connect to the internet to change the main currency.",
      ),
    )
    await openMainCurrencyDialog('uk')

    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))

    const error = await screen.findByTestId('main-currency-error')
    expect(error.textContent).toBe(
      'Ви офлайн. Підключіться до інтернету, щоб змінити основну валюту.',
    )
  })

  it('English', async () => {
    vi.mocked(changeMainCurrency).mockRejectedValue(
      new RefusalError(
        'offline',
        "You're offline. Connect to the internet to change the main currency.",
      ),
    )
    await openMainCurrencyDialog('en')

    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))

    const error = await screen.findByTestId('main-currency-error')
    expect(error.textContent).toBe(
      "You're offline. Connect to the internet to change the main currency.",
    )
  })
})
