// No CONTRACT_GAPs: EntryAmount props, data-testid="entry-amount" and its
// data-state values are fully specified in the Interface Contract. Expected
// texts are built with toLocaleString / dayjs so they hold in any locale.

import dayjs from 'dayjs'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { EntryConversion } from '@/lib/domain'
import EntryAmount from '@/components/EntryAmount'

const fmt2 = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const fmtRate = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 })

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
      `1 USD = ${fmtRate(41.52)} UAH · NBU · ${dayjs('2026-10-14').format('D MMM')}`,
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
      `1 EUR = ${fmtRate(45.1234567)} UAH · NBU · ${dayjs('2026-10-09').format('D MMM')}`,
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
