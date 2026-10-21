// No CONTRACT_GAPs: EntryAmount props, data-testid="entry-amount" and its
// data-state values are fully specified in the Interface Contract. Expected
// texts are built with the @/i18n/format helpers and an explicit language; the
// UI language is pinned in beforeEach. The "rate pending" wording of the
// Ukrainian UI is the Coder's, so those cases assert "Ukrainian, not English".

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EntryConversion } from '@/lib/domain'
import { setLang } from '@/i18n/core'
import { formatAmount, formatDay, formatMoney, formatRate } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import EntryAmount from '@/components/EntryAmount'

const fmt2 = (n: number) => formatAmount(n, 'en')
const fmtRate = (n: number) => formatRate(n, 'en')

function conv(overrides: Partial<EntryConversion> = {}): EntryConversion {
  return {
    mainCurrency: 'UAH',
    rate: 41.52,
    mainAmount: 830.4,
    rateDate: '2026-10-14',
    source: 'nbu',
    ...overrides,
  }
}

function amountEl() {
  return screen.getByTestId('entry-amount')
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('state "main": the entry is in the main currency', () => {
  it('shows just the amount with 2 decimals and the currency, with no title', () => {
    render(
      <EntryAmount
        entry={{ amount: 100, currency: 'UAH' }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('main')
    expect(amountEl().textContent).toBe(`${fmt2(100)} UAH`)
    expect(amountEl().getAttribute('title')).toBeNull()
  })

  it('follows the main currency prop', () => {
    render(
      <EntryAmount entry={{ amount: 7.5, currency: 'EUR' }} mainCurrency="EUR" />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('main')
    expect(amountEl().textContent).toBe(`${fmt2(7.5)} EUR`)
  })

  it('stays "main" even when a stored conversion exists (identity)', () => {
    render(
      <EntryAmount
        entry={{
          amount: 100,
          currency: 'UAH',
          conversion: conv({ rate: 1, mainAmount: 100, source: 'identity' }),
        }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('main')
    expect(amountEl().textContent).not.toContain('≈')
  })
})

describe('state "converted"', () => {
  it('shows the typed amount, then ≈, then the main amount', () => {
    render(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD', conversion: conv() }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('converted')
    expect(amountEl().textContent).toBe(`${fmt2(20)} USD ≈ ${fmt2(830.4)} UAH`)
  })

  it('has the rate, source and day in the title', () => {
    render(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD', conversion: conv() }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('title')).toBe(
      `1 USD = ${fmtRate(41.52)} UAH · NBU · ${formatDay('2026-10-14', 'en')}`,
    )
  })

  it('rounds the stored mainAmount for display only', () => {
    render(
      <EntryAmount
        entry={{
          amount: 1,
          currency: 'EUR',
          conversion: conv({ mainAmount: 33.333333, rate: 33.333333 }),
        }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().textContent).toContain(`≈ ${fmt2(33.33)} UAH`)
    expect(amountEl().textContent).not.toContain('33.3333')
  })

  it('uses the rateDate of the conversion, not the entry date, and up to 4 rate digits', () => {
    render(
      <EntryAmount
        entry={{
          amount: 10,
          currency: 'EUR',
          conversion: conv({ rate: 45.1234567, mainAmount: 451.23, rateDate: '2026-10-09' }),
        }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('title')).toBe(
      `1 EUR = ${fmtRate(45.1234567)} UAH · NBU · ${formatDay('2026-10-09', 'en')}`,
    )
  })

  it.each([
    ['nbu', 'NBU'],
    ['manual', 'Manual rate'],
    ['identity', 'Same currency'],
    ['my-provider', 'my-provider'],
  ])('labels the source %s as %s in the title', (source, label) => {
    render(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD', conversion: conv({ source }) }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('title')).toContain(` · ${label} · `)
  })

  it('converted into another main currency uses that currency in the text and title', () => {
    render(
      <EntryAmount
        entry={{
          amount: 100,
          currency: 'UAH',
          conversion: conv({ mainCurrency: 'EUR', rate: 0.0222, mainAmount: 2.22 }),
        }}
        mainCurrency="EUR"
      />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('converted')
    expect(amountEl().textContent).toBe(`${fmt2(100)} UAH ≈ ${fmt2(2.22)} EUR`)
    expect(amountEl().getAttribute('title')).toContain('1 UAH = ')
    expect(amountEl().getAttribute('title')).toContain(' EUR · ')
  })
})

describe('state "pending"', () => {
  it('shows the typed amount and "rate pending" when there is no conversion', () => {
    render(
      <EntryAmount entry={{ amount: 20, currency: 'USD' }} mainCurrency="UAH" />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('pending')
    expect(amountEl().textContent).toBe(`${fmt2(20)} USD · rate pending`)
    expect(amountEl().getAttribute('title')).toBeNull()
  })

  it('is pending when the stored conversion is for another main currency', () => {
    render(
      <EntryAmount
        entry={{
          amount: 20,
          currency: 'USD',
          conversion: conv({ mainCurrency: 'UAH' }),
        }}
        mainCurrency="EUR"
      />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('pending')
    expect(amountEl().textContent).toContain('rate pending')
    expect(amountEl().textContent).not.toContain('≈')
  })

  it('does not show the main amount while pending', () => {
    render(
      <EntryAmount
        entry={{
          amount: 20,
          currency: 'USD',
          conversion: conv({ mainCurrency: 'UAH', mainAmount: 830.4 }),
        }}
        mainCurrency="EUR"
      />,
    )

    expect(amountEl().textContent).not.toContain(fmt2(830.4))
  })
})

describe('sign and className', () => {
  it('prepends the sign to each state', () => {
    const { rerender } = render(
      <EntryAmount
        entry={{ amount: 100, currency: 'UAH' }}
        mainCurrency="UAH"
        sign="-"
      />,
    )
    expect(amountEl().textContent.trim().startsWith('-')).toBe(true)
    expect(amountEl().textContent).toContain(fmt2(100))

    rerender(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD', conversion: conv() }}
        mainCurrency="UAH"
        sign="+"
      />,
    )
    expect(amountEl().textContent.trim().startsWith('+')).toBe(true)
    expect(amountEl().textContent).toContain('≈')

    rerender(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD' }}
        mainCurrency="UAH"
        sign="-"
      />,
    )
    expect(amountEl().textContent.trim().startsWith('-')).toBe(true)
    expect(amountEl().textContent).toContain('rate pending')
  })

  it('has no sign when none is given', () => {
    render(
      <EntryAmount entry={{ amount: 100, currency: 'UAH' }} mainCurrency="UAH" />,
    )

    expect(amountEl().textContent.trim().startsWith(fmt2(100))).toBe(true)
  })

  it('forwards className to the span', () => {
    render(
      <EntryAmount
        entry={{ amount: 100, currency: 'UAH' }}
        mainCurrency="UAH"
        className="my-extra-class"
      />,
    )

    expect(amountEl().className).toContain('my-extra-class')
  })

  it('renders a single span', () => {
    render(
      <EntryAmount entry={{ amount: 100, currency: 'UAH' }} mainCurrency="UAH" />,
    )

    expect(amountEl().tagName).toBe('SPAN')
    expect(screen.getAllByTestId('entry-amount')).toHaveLength(1)
  })
})

describe('in Ukrainian', () => {
  function renderUk(ui: React.ReactElement) {
    return render(<I18nProvider initialLang="uk">{ui}</I18nProvider>)
  }

  it('shows a main-currency amount with грн and Ukrainian separators', () => {
    renderUk(
      <EntryAmount entry={{ amount: 1234.5, currency: 'UAH' }} mainCurrency="UAH" />,
    )

    expect(amountEl().textContent).toBe(formatMoney(1234.5, 'UAH', 'uk'))
    expect(amountEl().textContent).toMatch(/^1\s234,50 грн$/u)
  })

  it('shows a converted amount as "typed ≈ main" with грн only on the hryvnia', () => {
    renderUk(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD', conversion: conv() }}
        mainCurrency="UAH"
      />,
    )

    expect(amountEl().getAttribute('data-state')).toBe('converted')
    expect(amountEl().textContent).toBe('20,00 USD ≈ 830,40 грн')
  })

  it('formats the rate and the day of the title in Ukrainian', () => {
    renderUk(
      <EntryAmount
        entry={{ amount: 20, currency: 'USD', conversion: conv() }}
        mainCurrency="UAH"
      />,
    )

    const title = amountEl().getAttribute('title') ?? ''
    expect(title).toContain(formatRate(41.52, 'uk'))
    expect(title).toContain(formatDay('2026-10-14', 'uk'))
    expect(title).toContain('14 жовт.')
    expect(title).not.toContain('Oct')
    expect(title).not.toContain(formatRate(41.52, 'en'))
  })

  it('says "rate pending" in Ukrainian', () => {
    renderUk(<EntryAmount entry={{ amount: 20, currency: 'USD' }} mainCurrency="UAH" />)

    expect(amountEl().getAttribute('data-state')).toBe('pending')
    expect(amountEl().textContent).toContain('20,00 USD')
    expect(amountEl().textContent).toMatch(/[Ѐ-ӿ]/)
    expect(amountEl().textContent).not.toContain('rate pending')
  })
})
