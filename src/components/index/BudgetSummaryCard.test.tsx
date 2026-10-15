import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import BudgetSummaryCard from '@/components/index/BudgetSummaryCard'

// The card formats amounts with the shared money format (always 2 decimals).
// Separators follow the host locale (this machine resolves to uk-UA), so the
// expectations are built with the same toLocaleString options, never literals.
const fmt2 = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

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
    it('displays the total income with 2 decimals and the default currency UAH', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(screen.getByTestId('budget-summary-income').textContent).toBe(
        `${fmt2(1000)} UAH`,
      )
    })

    it('displays the total expenses with 2 decimals and the default currency UAH', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(screen.getByTestId('budget-summary-expenses').textContent).toBe(
        `${fmt2(400)} UAH`,
      )
    })

    it('uses thousands separators for large values', () => {
      render(<BudgetSummaryCard income={1234567} expenses={89} />)
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        fmt2(1234567),
      )
    })

    it('rounds unrounded sums only for display (33.333333 shows as 33.33)', () => {
      render(<BudgetSummaryCard income={100} expenses={33.333333} />)
      expect(screen.getByTestId('budget-summary-expenses').textContent).toContain(
        fmt2(33.33),
      )
      expect(screen.getByTestId('budget-summary-net-balance').textContent).toContain(
        fmt2(66.67),
      )
    })

    it('respects an explicit currency prop other than the default', () => {
      render(<BudgetSummaryCard income={500} expenses={200} currency="USD" />)
      expect(screen.getByTestId('budget-summary-income').textContent).toBe(
        `${fmt2(500)} USD`,
      )
      expect(screen.getByTestId('budget-summary-expenses').textContent).toBe(
        `${fmt2(200)} USD`,
      )
      expect(screen.getByTestId('budget-summary-net-balance').textContent).toBe(
        `${fmt2(300)} USD`,
      )
    })
  })

  describe('criterion 3: computes net balance internally as income - expenses', () => {
    it('computes a positive net balance correctly', () => {
      render(<BudgetSummaryCard income={1000} expenses={400} />)
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain(fmt2(600))
    })

    it('computes a negative net balance correctly', () => {
      render(<BudgetSummaryCard income={300} expenses={500} />)
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain(fmt2(-200))
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
    it('renders 0.00 for all three fields when income and expenses are both zero', () => {
      render(<BudgetSummaryCard income={0} expenses={0} />)
      expect(screen.getByTestId('budget-summary-income').textContent).toContain(
        fmt2(0),
      )
      expect(
        screen.getByTestId('budget-summary-expenses').textContent,
      ).toContain(fmt2(0))
      expect(
        screen.getByTestId('budget-summary-net-balance').textContent,
      ).toContain(fmt2(0))
    })

    it('does not throw when rendering with zero values', () => {
      expect(() =>
        render(<BudgetSummaryCard income={0} expenses={0} />),
      ).not.toThrow()
    })
  })
})
