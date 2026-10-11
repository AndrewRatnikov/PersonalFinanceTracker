// No CONTRACT_GAPs: CategoryDonutChart props and the category-donut-empty
// testid are fully specified in the Interface Contract. Recharts renders
// nothing measurable in jsdom, so only the legend text and the empty card are
// asserted.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { CategoryBreakdownItem } from '@/lib/domain'
import CategoryDonutChart from '@/components/analytics/CategoryDonutChart'

const DATA: Array<CategoryBreakdownItem> = [
  { categoryId: 'a', name: 'Salary', icon: '💼', total: 3000 },
  { categoryId: 'b', name: 'Gifts', icon: null, total: 200 },
]

describe('CategoryDonutChart empty state', () => {
  it('shows the default text when there is no data and no emptyText', () => {
    render(<CategoryDonutChart data={[]} currency="UAH" />)

    expect(screen.getByTestId('category-donut-empty').textContent).toBe(
      'No data found.',
    )
  })

  it('shows the given emptyText instead of the default', () => {
    render(
      <CategoryDonutChart
        data={[]}
        currency="UAH"
        emptyText="No income in this period."
      />,
    )

    const empty = screen.getByTestId('category-donut-empty')
    expect(empty.textContent).toBe('No income in this period.')
    expect(empty.textContent).not.toContain('No data found.')
  })

  it('a different emptyText renders a different text', () => {
    render(<CategoryDonutChart data={[]} currency="USD" emptyText="Nothing here" />)

    expect(screen.getByTestId('category-donut-empty').textContent).toBe(
      'Nothing here',
    )
  })

  it('does not show the empty card when there is data, even with emptyText', () => {
    render(
      <CategoryDonutChart data={DATA} currency="UAH" emptyText="Nothing here" />,
    )

    expect(screen.queryByTestId('category-donut-empty')).toBeNull()
    expect(screen.queryByText('Nothing here')).toBeNull()
  })
})

describe('CategoryDonutChart legend', () => {
  it('lists each category name, with its icon when it has one', () => {
    render(<CategoryDonutChart data={DATA} currency="UAH" />)

    expect(screen.getByText(/Salary/).textContent).toContain('💼')
    const gifts = screen.getByText(/Gifts/)
    expect(gifts.textContent).toContain('Gifts')
    expect(gifts.textContent).not.toContain('💼')
  })

  it('collapses categories beyond the 10th into Other', () => {
    const many: Array<CategoryBreakdownItem> = Array.from(
      { length: 12 },
      (_, i) => ({
        categoryId: `c${i}`,
        name: `Cat${i}`,
        icon: null,
        total: 100 - i,
      }),
    )

    render(<CategoryDonutChart data={many} currency="UAH" />)

    expect(screen.getByText(/Cat0/)).toBeTruthy()
    expect(screen.queryByText(/Cat11/)).toBeNull()
    expect(screen.getByText(/Other/)).toBeTruthy()
  })
})

describe('CategoryDonutChart ariaLabel', () => {
  it('puts role=figure and aria-label on the root when there is data', () => {
    render(
      <CategoryDonutChart
        data={DATA}
        currency="UAH"
        ariaLabel="Income by category"
      />,
    )

    const figure = screen.getByRole('figure')
    expect(figure.getAttribute('aria-label')).toBe('Income by category')
  })

  it('puts role=figure and aria-label on the empty card too', () => {
    render(
      <CategoryDonutChart
        data={[]}
        currency="UAH"
        ariaLabel="Spending by category"
      />,
    )

    const figure = screen.getByRole('figure')
    expect(figure.getAttribute('aria-label')).toBe('Spending by category')
    expect(figure.textContent).toContain('No data found.')
  })

  it('has no figure role without an ariaLabel', () => {
    render(<CategoryDonutChart data={DATA} currency="UAH" />)

    expect(screen.queryByRole('figure')).toBeNull()
  })
})
