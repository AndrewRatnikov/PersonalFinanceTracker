// No CONTRACT_GAPs: GeneralTab's selectors, texts and dependencies are fully
// specified in the Interface Contract (component: GeneralTab) and plan section
// 10. '@/lib/conversion' and the settings writer are mocked; the mocked
// MainCurrencyChangeError is a plain Error subclass with a code, which is all
// the component relies on (an instanceof check against the mocked module).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChangeMainCurrencyResult, ConvertOptions } from '@/lib/conversion'
import type { CurrencySettings } from '@/lib/appSettings'
import {
  MainCurrencyChangeError,
  changeMainCurrency,
  getConversionStatus,
  requestConversion,
} from '@/lib/conversion'
import { DecryptError } from '@/lib/dataErrors'
import { clearDataProblem, getDataProblem } from '@/lib/dataProblem'
import { getCurrencySettings, updateCurrencySettings } from '@/lib/appSettings'
import { GeneralTab } from '@/components/settings/GeneralTab'

vi.mock('@/lib/localDb', () => ({}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/appSettings')>()),
  getCurrencySettings: vi.fn(),
  updateCurrencySettings: vi.fn(),
}))
vi.mock('@/lib/conversion', () => {
  class MainCurrencyChangeError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'MainCurrencyChangeError'
      this.code = code
    }
  }
  return {
    CONVERSION_STATUS_QUERY_KEY: ['conversion-status'],
    MainCurrencyChangeError,
    getConversionStatus: vi.fn(),
    changeMainCurrency: vi.fn(),
    requestConversion: vi.fn(),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// The mocked module's class takes (code, message); the real one is only used
// for its type, so the constructor is cast to that shape.
const RefusalError = MainCurrencyChangeError as unknown as new (
  code: string,
  message: string,
) => Error

const OFFLINE_MESSAGE =
  "You're offline. Connect to the internet to change the main currency."
const RATES_OFF_MESSAGE =
  'Turn on exchange rates from the National Bank of Ukraine to change the main currency.'

function setSettings(settings: Partial<CurrencySettings> = {}) {
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    ...settings,
  })
}

function setStatus(overrides: Partial<Awaited<ReturnType<typeof getConversionStatus>>> = {}) {
  vi.mocked(getConversionStatus).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    totalEntries: 480,
    pendingEntries: 0,
    pendingBudgets: 0,
    ...overrides,
  })
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = render(
    <QueryClientProvider client={client}>
      <GeneralTab />
    </QueryClientProvider>,
  )
  return { ...view, client, invalidate }
}

function invalidatedKeys(invalidate: ReturnType<typeof renderTab>['invalidate']) {
  return invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
}

const select = () =>
  screen.getByTestId<HTMLSelectElement>('settings-main-currency')
const toggle = () => screen.getByTestId<HTMLInputElement>('settings-fetch-rates')

// Renders, waits for the settings and the status, then picks `next` in the
// select (which opens the confirm dialog).
async function openDialogFor(next: string, totalEntries = 480) {
  setStatus({ totalEntries })
  const view = renderTab()
  await waitFor(() => {
    expect(screen.getByTestId('settings-conversion-status').textContent).toContain(
      'All entries converted',
    )
  })
  await waitFor(() => {
    expect(select().value).toBe('UAH')
  })
  fireEvent.change(select(), { target: { value: next } })
  await screen.findByTestId('main-currency-confirm-dialog')
  return view
}

// A changeMainCurrency the test resolves or rejects by hand.
function holdChange() {
  let options: ConvertOptions | undefined
  let resolve: ((r: ChangeMainCurrencyResult) => void) | undefined
  let reject: ((e: unknown) => void) | undefined
  vi.mocked(changeMainCurrency).mockImplementation((_next, opts) => {
    options = opts
    return new Promise<ChangeMainCurrencyResult>((res, rej) => {
      resolve = res
      reject = rej
    })
  })
  return {
    options: () => options,
    resolve: (r: ChangeMainCurrencyResult) => resolve?.(r),
    reject: (e: unknown) => reject?.(e),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  setSettings()
  setStatus()
  vi.mocked(updateCurrencySettings).mockResolvedValue(undefined)
  vi.mocked(requestConversion).mockResolvedValue(undefined)
})

afterEach(() => {
  clearDataProblem()
})

describe('GeneralTab: layout', () => {
  it('renders the root, the main currency select and the rates switch', () => {
    renderTab()

    expect(screen.getByTestId('general-tab')).toBeTruthy()
    expect(select()).toBeTruthy()
    expect(toggle().getAttribute('role')).toBe('switch')
    expect(toggle().type).toBe('checkbox')
  })

  it('offers every currency in the select and shows the stored main currency', async () => {
    setSettings({ mainCurrency: 'EUR' })
    renderTab()

    await waitFor(() => {
      expect(select().value).toBe('EUR')
    })
    expect(Array.from(select().options).map((o) => o.value)).toEqual([
      'UAH',
      'USD',
      'EUR',
    ])
  })

  it('explains what is sent, and labels the switch', () => {
    renderTab()

    expect(screen.getByTestId('settings-fetch-rates-help').textContent).toBe(
      "Only dates are sent, never amounts. When off, entries in other currencies aren't included in totals.",
    )
    expect(screen.getByTestId('general-tab').textContent).toContain(
      'Fetch exchange rates from the National Bank of Ukraine',
    )
  })

  it('reflects the stored switch value', async () => {
    setSettings({ fetchExchangeRates: false })
    renderTab()

    await waitFor(() => {
      expect(toggle().checked).toBe(false)
    })
  })

  it('shows the switch on when rates are on', async () => {
    renderTab()

    await waitFor(() => {
      expect(toggle().checked).toBe(true)
    })
  })
})

describe('GeneralTab: conversion status line', () => {
  it('says all entries are converted when none is pending', async () => {
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('settings-conversion-status').textContent).toBe(
        'All entries converted',
      )
    })
  })

  it('counts the pending entries', async () => {
    setStatus({ pendingEntries: 3 })
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('settings-conversion-status').textContent).toBe(
        '3 entries waiting for exchange rates',
      )
    })
  })

  it('uses the singular for one pending entry', async () => {
    setStatus({ pendingEntries: 1 })
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('settings-conversion-status').textContent).toBe(
        '1 entry waiting for exchange rates',
      )
    })
  })
})

describe('GeneralTab: fetch switch', () => {
  it('turning it off saves false, refreshes the settings and does not start a conversion', async () => {
    const { invalidate } = renderTab()
    await waitFor(() => {
      expect(toggle().checked).toBe(true)
    })

    fireEvent.click(toggle())

    await waitFor(() => {
      expect(updateCurrencySettings).toHaveBeenCalledWith({
        fetchExchangeRates: false,
      })
    })
    await waitFor(() => {
      expect(invalidatedKeys(invalidate)).toEqual(
        expect.arrayContaining([
          JSON.stringify(['settings']),
          JSON.stringify(['conversion-status']),
        ]),
      )
    })
    expect(requestConversion).not.toHaveBeenCalled()
  })

  it('turning it on saves true and starts a conversion run', async () => {
    setSettings({ fetchExchangeRates: false })
    renderTab()
    await waitFor(() => {
      expect(toggle().checked).toBe(false)
    })

    fireEvent.click(toggle())

    await waitFor(() => {
      expect(updateCurrencySettings).toHaveBeenCalledWith({
        fetchExchangeRates: true,
      })
    })
    await waitFor(() => {
      expect(requestConversion).toHaveBeenCalledTimes(1)
    })
  })
})

describe('GeneralTab: changing the main currency', () => {
  it('opens the confirm dialog with the entry count and the new currency, without changing anything yet', async () => {
    await openDialogFor('EUR', 480)

    expect(screen.getByTestId('main-currency-confirm-text').textContent).toBe(
      "Recalculate 480 entries in EUR. Budgets will be converted at today's NBU rate.",
    )
    expect(changeMainCurrency).not.toHaveBeenCalled()
    expect(select().value).toBe('UAH')
  })

  it('names the chosen currency and the current entry count', async () => {
    await openDialogFor('USD', 12)

    expect(screen.getByTestId('main-currency-confirm-text').textContent).toBe(
      "Recalculate 12 entries in USD. Budgets will be converted at today's NBU rate.",
    )
  })

  it('Cancel closes the dialog and changes nothing', async () => {
    await openDialogFor('EUR')

    fireEvent.click(screen.getByTestId('main-currency-cancel-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('main-currency-confirm-dialog')).toBeNull()
    })
    expect(changeMainCurrency).not.toHaveBeenCalled()
    expect(select().value).toBe('UAH')
  })

  it('Confirm runs changeMainCurrency with the chosen currency and a progress callback', async () => {
    const held = holdChange()
    await openDialogFor('EUR')

    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))

    await waitFor(() => {
      expect(changeMainCurrency).toHaveBeenCalledTimes(1)
    })
    const [next, options] = vi.mocked(changeMainCurrency).mock.calls[0]
    expect(next).toBe('EUR')
    expect(typeof options?.onProgress).toBe('function')
    expect(held.options()).toBe(options)
    // The dialog stays open while it runs.
    expect(screen.getByTestId('main-currency-confirm-dialog')).toBeTruthy()
  })

  it('shows the progress and disables Confirm and Cancel while it runs', async () => {
    const held = holdChange()
    await openDialogFor('EUR')
    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))
    await waitFor(() => {
      expect(held.options()).toBeDefined()
    })

    act(() => {
      held.options()?.onProgress?.({ done: 120, total: 480 })
    })

    expect(screen.getByTestId('main-currency-progress').textContent).toBe(
      'Converting… 120 / 480',
    )
    expect(
      screen.getByTestId<HTMLButtonElement>('main-currency-confirm-btn').disabled,
    ).toBe(true)
    expect(
      screen.getByTestId<HTMLButtonElement>('main-currency-cancel-btn').disabled,
    ).toBe(true)

    act(() => {
      held.options()?.onProgress?.({ done: 300, total: 480 })
    })
    expect(screen.getByTestId('main-currency-progress').textContent).toBe(
      'Converting… 300 / 480',
    )
  })

  it('when done, notes how many budgets were converted at which rate date, and Done closes the dialog', async () => {
    const held = holdChange()
    await openDialogFor('EUR')
    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))
    await waitFor(() => {
      expect(held.options()).toBeDefined()
    })
    setSettings({ mainCurrency: 'EUR' })

    await act(async () => {
      held.resolve({
        converted: 480,
        stillPending: 0,
        budgetsConverted: 3,
        rateDate: '2026-10-15',
      })
    })

    const note = await screen.findByTestId('main-currency-budgets-note')
    expect(note.textContent).toBe(
      '3 budgets converted to EUR at the NBU rate of 2026-10-15.',
    )
    fireEvent.click(screen.getByTestId('main-currency-done-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('main-currency-confirm-dialog')).toBeNull()
    })
    await waitFor(() => {
      expect(select().value).toBe('EUR')
    })
  })

  it('says there were no budgets to convert', async () => {
    const held = holdChange()
    await openDialogFor('USD')
    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))
    await waitFor(() => {
      expect(held.options()).toBeDefined()
    })

    await act(async () => {
      held.resolve({
        converted: 480,
        stillPending: 0,
        budgetsConverted: 0,
        rateDate: null,
      })
    })

    expect((await screen.findByTestId('main-currency-budgets-note')).textContent).toBe(
      'No budgets to convert.',
    )
  })

  it('refreshes the settings, the status and every data query when done', async () => {
    const held = holdChange()
    const { invalidate } = await openDialogFor('EUR')
    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))
    await waitFor(() => {
      expect(held.options()).toBeDefined()
    })

    await act(async () => {
      held.resolve({
        converted: 480,
        stillPending: 0,
        budgetsConverted: 1,
        rateDate: '2026-10-15',
      })
    })

    await screen.findByTestId('main-currency-done-btn')
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        JSON.stringify(['settings']),
        JSON.stringify(['conversion-status']),
        JSON.stringify(['expenses']),
        JSON.stringify(['income']),
        JSON.stringify(['analytics']),
        JSON.stringify(['budgets']),
      ]),
    )
  })
})

describe('GeneralTab: refusals and failures', () => {
  it.each([
    ['offline', OFFLINE_MESSAGE],
    ['rates-off', RATES_OFF_MESSAGE],
  ])('shows the %s refusal message, keeps the dialog open and the old currency', async (code, message) => {
    vi.mocked(changeMainCurrency).mockRejectedValue(
      new RefusalError(code, message),
    )
    await openDialogFor('EUR')

    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))

    const error = await screen.findByTestId('main-currency-error')
    expect(error.textContent).toBe(message)
    expect(screen.getByTestId('main-currency-confirm-dialog')).toBeTruthy()
    expect(select().value).toBe('UAH')
    expect(screen.queryByTestId('main-currency-budgets-note')).toBeNull()
    expect(screen.queryByTestId('main-currency-progress')).toBeNull()
  })

  it('lets the user cancel after a refusal', async () => {
    vi.mocked(changeMainCurrency).mockRejectedValue(
      new RefusalError('offline', OFFLINE_MESSAGE),
    )
    await openDialogFor('EUR')
    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))
    await screen.findByTestId('main-currency-error')

    expect(
      screen.getByTestId<HTMLButtonElement>('main-currency-cancel-btn').disabled,
    ).toBe(false)
    fireEvent.click(screen.getByTestId('main-currency-cancel-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('main-currency-confirm-dialog')).toBeNull()
    })
  })

  it('reports a DecryptError to the data problem screen instead of the dialog', async () => {
    vi.mocked(changeMainCurrency).mockRejectedValue(
      new DecryptError('expenses_2026_10', new Error('bad tag')),
    )
    await openDialogFor('EUR')

    fireEvent.click(screen.getByTestId('main-currency-confirm-btn'))

    await waitFor(() => {
      expect(getDataProblem()?.storageKey).toBe('expenses_2026_10')
    })
    expect(select().value).toBe('UAH')
  })
})
