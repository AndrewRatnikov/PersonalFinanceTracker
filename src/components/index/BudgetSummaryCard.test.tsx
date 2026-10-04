import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import BudgetSummaryCard from '@/components/index/BudgetSummaryCard'

// The component formats with Number.prototype.toLocaleString(), whose separators
// follow the host locale (this repo's dev machine resolves to uk-UA -> "1 234 567";
// CI usually en-US -> "1,234,567"). Assert against the same formatter so the case
// still checks "the value is locale-formatted with thousands separators" on both.
const fmt = (n: number) => n.toLocaleString()

describe('BudgetSummaryCard', () => {
  describe('rendering', () => {
    it('renders without crashing and exposes the root testid', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(screen.getByTestId('budget-summary-card')).toBeTruthy()
    })
  })

  describe('criterion 1 & 7: presentational component using Card primitives, no props beyond contract required', () => {
    it('renders all three value elements from a single prop pass with no network/router context', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(screen.getByTestId('budget-summary-income')).toBeTruthy()
      expect(screen.getByTestId('budget-summary-expenses')).toBeTruthy()
      expect(screen.getByTestId('budget-summary-net-balance')).toBeTruthy()
    })
  })

  describe('criterion 2 & 4: displays income and expenses, formatted with currency', () => {
    it('displays the formatted total income with default currency UAH', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        fmt(1000),
      )
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        'UAH',
      )
    })

    it('displays the formatted total expenses with default currency UAH', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(
        screen.getByTestId('budget-summary-expenses').textContent,
      ).toContain('400')
      expect(
        screen.getByTestId('budget-summary-expenses').textContent,
      ).toContain('UAH')
    })

    it('uses thousands separators via toLocaleString for large values', () => {
      render(<BudgetSummaryCard income={1234567} expenses={89} />)
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        fmt(1234567),
      )
    })

    it('respects an explicit currency prop other than the default', () => {
      render(<BudgetSummaryCard income={500} expenses={200} currency="USD" />)
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        'USD',
      )
      expect(
        screen.getByTestId('budget-summary-expenses').textContent,
      ).toContain('USD')
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain('USD')
    })
  })

  describe('criterion 3: computes net balance internally as income - expenses', () => {
    it('computes a positive net balance correctly', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain('600')
    })

    it('computes a negative net balance correctly', () => {
      render(<BudgetSummaryCard income={300} expenses={500} />)
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain('200')
    })
  })

  describe('criterion 5: net balance styling reflects sign', () => {
    it('applies a positive styling class when net balance is zero or greater', () => {
      const { rerender } = render(
        <BudgetSummaryCard income={1000} expenses={400} />,
      )
      const positiveClass = screen.getByTestId(
        'budget-summary-net-balance',
      ).className

      rerender(<BudgetSummaryCard income={400} expenses={400} />)
      const zeroClass = screen.getByTestId(
        'budget-summary-net-balance',
      ).className

      expect(positiveClass).not.toContain('destructive')
      expect(zeroClass).not.toContain('destructive')
    })

    it('applies a negative/destructive styling class when net balance is negative', () => {
      render(<BudgetSummaryCard income={100} expenses={900} />)
      expect(
        screen.getByTestId('budget-summary-net-balance').className,
      ).toContain('destructive')
    })

    it('produces a different class between a positive and a negative net balance', () => {
      const { rerender } = render(
        <BudgetSummaryCard income={1000} expenses={400} />,
      )
      const positiveClass = screen.getByTestId(
        'budget-summary-net-balance',
      ).className

      rerender(<BudgetSummaryCard income={100} expenses={900} />)
      const negativeClass = screen.getByTestId(
        'budget-summary-net-balance',
      ).className

      expect(positiveClass).not.toEqual(negativeClass)
    })
  })

  describe('criterion 6: zero-value edge case renders without errors', () => {
    it('renders 0 for all three fields when income and expenses are both zero', () => {
      render(<BudgetSummaryCard income={0} expenses={0} />)
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        '0',
      )
      expect(
        screen.getByTestId('budget-summary-expenses').textContent,
      ).toContain('0')
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain('0')
    })

    it('does not throw when rendering with zero values', () => {
      expect(() =>
        render(<BudgetSummaryCard income={0} expenses={0} />),
      ).not.toThrow()
    })
  })
})
