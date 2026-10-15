// No CONTRACT_GAPs: ConversionPendingNote props and the testids
// conversion-pending-note, conversion-pending-settings-link and
// budget-conversion-pending-note are fully specified in the Interface Contract.
// The plural wording of the budget note is not fixed, so only the number and the
// "1 budget" singular text are asserted.

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import ConversionPendingNote from '@/components/ConversionPendingNote'

// The component renders a router Link. Replace it with a plain anchor that
// forwards rest props (so data-testid survives) and exposes `search`.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: unknown
    children?: ReactNode
  } & Record<string, unknown>) => (
    <a href={to} data-search={JSON.stringify(search)} {...rest}>
      {children}
    </a>
  ),
}))

describe('nothing to report', () => {
  it('renders nothing when there are no pending entries and no excluded budgets', () => {
    const { container } = render(
      <ConversionPendingNote count={0} fetchExchangeRates />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for count 0 and 0 excluded budgets, with rates off', () => {
    const { container } = render(
      <ConversionPendingNote count={0} budgetsExcluded={0} fetchExchangeRates={false} />,
    )

    expect(container.firstChild).toBeNull()
  })
})

describe('pending entries', () => {
  it('uses the singular for one entry', () => {
    render(<ConversionPendingNote count={1} fetchExchangeRates />)

    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '1 entry waiting for exchange rates',
    )
  })

  it('uses the plural and the count for several entries', () => {
    render(<ConversionPendingNote count={3} fetchExchangeRates />)

    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '3 entries waiting for exchange rates',
    )
  })

  it('has no settings link while rates are on', () => {
    render(<ConversionPendingNote count={2} fetchExchangeRates />)

    expect(screen.queryByTestId('conversion-pending-settings-link')).toBeNull()
  })

  it('links to Settings → General while rates are off', () => {
    render(<ConversionPendingNote count={2} fetchExchangeRates={false} />)

    const link = screen.getByTestId('conversion-pending-settings-link')
    expect(link.getAttribute('href')).toBe('/settings')
    expect(JSON.parse(link.getAttribute('data-search') ?? 'null')).toEqual({
      tab: 'general',
    })
    expect(link.textContent).toContain('Turn on exchange rates in Settings → General')
  })

  it('shows no budget note without excluded budgets', () => {
    render(<ConversionPendingNote count={2} budgetsExcluded={0} fetchExchangeRates />)

    expect(screen.queryByTestId('budget-conversion-pending-note')).toBeNull()
  })
})

describe('excluded budgets', () => {
  it('explains the singular case', () => {
    render(<ConversionPendingNote count={0} budgetsExcluded={1} fetchExchangeRates />)

    const note = screen.getByTestId('budget-conversion-pending-note')
    expect(note.textContent).toBe(
      "1 budget in another currency isn't compared until today's exchange rate is available",
    )
    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
  })

  it('names the number for several budgets', () => {
    render(<ConversionPendingNote count={0} budgetsExcluded={3} fetchExchangeRates />)

    const note = screen.getByTestId('budget-conversion-pending-note')
    expect(note.textContent).toContain('3 budgets')
    expect(note.textContent).not.toContain('1 budget')
  })

  it('shows no settings link when only budgets are excluded, even with rates off', () => {
    render(
      <ConversionPendingNote count={0} budgetsExcluded={1} fetchExchangeRates={false} />,
    )

    expect(screen.queryByTestId('conversion-pending-settings-link')).toBeNull()
  })

  it('shows both notes together', () => {
    render(<ConversionPendingNote count={2} budgetsExcluded={1} fetchExchangeRates />)

    expect(screen.getByTestId('conversion-pending-note')).toBeTruthy()
    expect(screen.getByTestId('budget-conversion-pending-note')).toBeTruthy()
  })
})
