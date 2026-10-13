import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { MonthlyExpenseSummary } from '@/lib/domain'
import DashboardStats from '@/components/index/DashboardStats'

const captured = vi.hoisted(() => ({
  props: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  )
  const capture = (name: string) => (p: Record<string, unknown>) => {
    captured.props[name] = p
    return null
  }
  return {
    ResponsiveContainer: Container,
    BarChart: Container,
    XAxis: capture('XAxis'),
    YAxis: capture('YAxis'),
    Tooltip: capture('Tooltip'),
    Bar: capture('Bar'),
  }
})

const data: Array<MonthlyExpenseSummary> = [
  { month: '10', year: '2026', name: 'Oct', total: 120 },
]

describe('DashboardStats theme colours', () => {
  beforeEach(() => {
    captured.props = {}
    render(<DashboardStats data={data} currency="UAH" />)
  })

  it('renders the component', () => {
    expect(screen.getByTestId('dashboard-stats-total')).toBeTruthy()
  })

  it('fills the Bar with the primary token', () => {
    expect(captured.props.Bar.fill).toBe('var(--primary)')
  })

  it.each(['XAxis', 'YAxis'])(
    '%s uses muted-foreground for tick fill and stroke and keeps fontSize',
    (name) => {
      expect(captured.props[name].tick).toEqual({
        fill: 'var(--muted-foreground)',
      })
      expect(captured.props[name].stroke).toBe('var(--muted-foreground)')
      expect(captured.props[name].fontSize).toBe(12)
    },
  )

  it('themes the Tooltip with var(--token) values', () => {
    const t = captured.props.Tooltip
    expect(t.cursor).toMatchObject({ fill: 'var(--muted)' })
    expect(t.contentStyle).toMatchObject({
      backgroundColor: 'var(--popover)',
      border: '1px solid var(--border)',
      color: 'var(--popover-foreground)',
    })
    expect(t.itemStyle).toMatchObject({ color: 'var(--primary)' })
    expect(t.labelStyle).toMatchObject({ color: 'var(--muted-foreground)' })
  })

  it('has no hsl( wrapper in any chart prop', () => {
    for (const name of ['Bar', 'XAxis', 'YAxis', 'Tooltip']) {
      expect(JSON.stringify(captured.props[name])).not.toContain('hsl(')
    }
  })
})
