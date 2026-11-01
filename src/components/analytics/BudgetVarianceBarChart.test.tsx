// No CONTRACT_GAPs: BudgetVarianceBarChart's default export, its props ({ data,
// currency }), the planned Bar (dataKey "Budget") token and the actual Cell
// tokens come from the Interface Contract (Chart components). recharts is
// replaced by components that capture their props; the mocked Bar renders its
// children so the Cell fills are captured per Bar.

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { BudgetVarianceItem } from '@/lib/domain'
import BudgetVarianceBarChart from '@/components/analytics/BudgetVarianceBarChart'

const captured = vi.hoisted(() => ({
  bars: {} as Record<string, Record<string, unknown>>,
  cellFills: [] as Array<unknown>,
  other: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  )
  const capture = (name: string) => (p: Record<string, unknown>) => {
    captured.other[name] = p
    return null
  }
  return {
    ResponsiveContainer: Container,
    BarChart: Container,
    XAxis: capture('XAxis'),
    YAxis: capture('YAxis'),
    Tooltip: capture('Tooltip'),
    Legend: capture('Legend'),
    Bar: (p: Record<string, unknown> & { children?: ReactNode }) => {
      captured.bars[String(p.dataKey)] = p
      return <div>{p.children}</div>
    },
    Cell: (p: { fill?: unknown }) => {
      captured.cellFills.push(p.fill)
      return null
    },
  }
})

const items: Array<BudgetVarianceItem> = [
  { categoryId: 'c1', name: 'Food', budget: 100, actual: 150, overBudget: true },
  { categoryId: 'c2', name: 'Rent', budget: 500, actual: 300, overBudget: false },
  { categoryId: 'c3', name: 'Fun', budget: 50, actual: 80, overBudget: true },
]

beforeEach(() => {
  captured.bars = {}
  captured.cellFills = []
  captured.other = {}
})

afterEach(() => {
  cleanup()
})

describe('BudgetVarianceBarChart colours', () => {
  it('fills the planned Bar with the shared chart accent token', () => {
    render(<BudgetVarianceBarChart data={items} currency="UAH" />)

    expect(captured.bars.Budget.fill).toBe('var(--chart-accent)')
    expect(captured.bars.Budget.fill).not.toBe('#6366f1')
  })

  it('colours each actual cell negative when over budget and positive otherwise, in row order', () => {
    render(<BudgetVarianceBarChart data={items} currency="UAH" />)

    expect(captured.cellFills).toEqual([
      'var(--chart-negative)',
      'var(--chart-positive)',
      'var(--chart-negative)',
    ])
  })

  it('follows the data: a single under-budget row is positive, a single over-budget row is negative', () => {
    const { unmount } = render(
      <BudgetVarianceBarChart data={[items[1]]} currency="UAH" />,
    )
    expect(captured.cellFills).toEqual(['var(--chart-positive)'])
    unmount()

    captured.cellFills = []
    render(<BudgetVarianceBarChart data={[items[0]]} currency="UAH" />)
    expect(captured.cellFills).toEqual(['var(--chart-negative)'])
  })

  it('does not use the old hard-coded red or green', () => {
    render(<BudgetVarianceBarChart data={items} currency="UAH" />)

    for (const fill of captured.cellFills) {
      expect(fill).not.toBe('#ef4444')
      expect(fill).not.toBe('#22c55e')
    }
  })

  it('has no hex literal in any chart prop or cell fill', () => {
    render(<BudgetVarianceBarChart data={items} currency="UAH" />)

    // The children (React elements) are left out: they are the Cells, whose
    // fills are checked through cellFills.
    const all = JSON.stringify(
      [captured.bars.Budget, captured.bars.Actual, captured.other, captured.cellFills],
      (key, value: unknown) => (key === 'children' ? undefined : value),
    )
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(all).not.toContain('var(--primary)')
  })

  it('renders no Bar for empty data', () => {
    render(<BudgetVarianceBarChart data={[]} currency="UAH" />)

    expect(captured.bars.Budget).toBeUndefined()
    expect(captured.cellFills).toEqual([])
  })
})
