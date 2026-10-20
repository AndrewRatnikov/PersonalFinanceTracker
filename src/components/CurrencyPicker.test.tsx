// No CONTRACT_GAPs: CurrencyPicker props and testids are fully specified in the
// Interface Contract (component: CurrencyPicker).

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Currency } from '@/lib/domain'
import { CurrencyPicker } from '@/components/CurrencyPicker'

function renderPicker(
  props: Partial<{
    value: Currency
    testIdPrefix: string
    disabled: boolean
    label: string
  }> = {},
) {
  const onChange = vi.fn<(currency: Currency) => void>()
  render(
    <CurrencyPicker
      value={props.value ?? 'UAH'}
      onChange={onChange}
      testIdPrefix={props.testIdPrefix ?? 'drawer'}
      disabled={props.disabled}
      label={props.label}
    />,
  )
  return { onChange }
}

describe('CurrencyPicker', () => {
  it('renders a labelled group with one button per currency', () => {
    renderPicker()

    const group = screen.getByTestId('drawer-currency')
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Currency')
    for (const code of ['UAH', 'USD', 'EUR']) {
      const button = screen.getByTestId(`drawer-currency-${code}`)
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
      expect(button.textContent).toBe(code)
    }
    expect(group.querySelectorAll('button')).toHaveLength(3)
  })

  it('uses a custom label when given', () => {
    renderPicker({ label: 'Income currency' })

    expect(screen.getByTestId('drawer-currency').getAttribute('aria-label')).toBe(
      'Income currency',
    )
  })

  it('marks only the current currency as pressed', () => {
    renderPicker({ value: 'USD' })

    expect(screen.getByTestId('drawer-currency-UAH').getAttribute('aria-pressed')).toBe(
      'false',
    )
    expect(screen.getByTestId('drawer-currency-USD').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByTestId('drawer-currency-EUR').getAttribute('aria-pressed')).toBe(
      'false',
    )
  })

  it('follows the value prop', () => {
    renderPicker({ value: 'EUR' })

    expect(screen.getByTestId('drawer-currency-EUR').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByTestId('drawer-currency-USD').getAttribute('aria-pressed')).toBe(
      'false',
    )
  })

  it('calls onChange with the code of the clicked button', () => {
    const { onChange } = renderPicker({ value: 'UAH' })

    fireEvent.click(screen.getByTestId('drawer-currency-USD'))
    fireEvent.click(screen.getByTestId('drawer-currency-EUR'))

    expect(onChange.mock.calls).toEqual([['USD'], ['EUR']])
  })

  it('calls onChange even when the clicked currency is already selected', () => {
    const { onChange } = renderPicker({ value: 'UAH' })

    fireEvent.click(screen.getByTestId('drawer-currency-UAH'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('UAH')
  })

  it('builds the test ids from the prefix', () => {
    renderPicker({ testIdPrefix: 'speed-entry', value: 'EUR' })

    expect(screen.getByTestId('speed-entry-currency')).toBeTruthy()
    expect(
      screen.getByTestId('speed-entry-currency-EUR').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.queryByTestId('drawer-currency')).toBeNull()
  })

  it('disables every button when disabled', () => {
    const { onChange } = renderPicker({ disabled: true })

    for (const code of ['UAH', 'USD', 'EUR']) {
      const button = screen.getByTestId<HTMLButtonElement>(`drawer-currency-${code}`)
      expect(button.disabled).toBe(true)
    }
    fireEvent.click(screen.getByTestId('drawer-currency-USD'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves the buttons enabled by default', () => {
    renderPicker()

    expect(
      screen.getByTestId<HTMLButtonElement>('drawer-currency-USD').disabled,
    ).toBe(false)
  })
})
