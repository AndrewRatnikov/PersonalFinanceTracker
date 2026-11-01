// No CONTRACT_GAPs: TimelineBarChart's default export, its props ({ data,
// currency }) and the Bar fill token come from the Interface Contract (Chart
// components). recharts is replaced by components that capture their props, the
// same way DashboardStats.test.tsx does.

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { AnalyticsTimelinePoint } from '@/lib/domain'
import TimelineBarChart from '@/components/analytics/TimelineBarChart'

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

const data: Array<AnalyticsTimelinePoint> = [
  { date: '2026-10-01', label: '01 Oct', total: 120 },
  { date: '2026-10-02', label: '02 Oct', total: 80 },
]

beforeEach(() => {
  captured.props = {}
})

afterEach(() => {
  cleanup()
})

describe('TimelineBarChart colours', () => {
  it('fills the bars with the shared chart accent token', () => {
    render(<TimelineBarChart data={data} currency="UAH" />)

    expect(captured.props.Bar.fill).toBe('var(--chart-accent)')
  })

  it('does not use the old hard-coded violet or the primary token', () => {
    render(<TimelineBarChart data={data} currency="UAH" />)

    expect(captured.props.Bar.fill).not.toBe('#6366f1')
    expect(captured.props.Bar.fill).not.toBe('var(--primary)')
  })

  it('has no hex literal in any chart prop', () => {
    render(<TimelineBarChart data={data} currency="UAH" />)

    for (const name of ['Bar', 'XAxis', 'YAxis', 'Tooltip']) {
      expect(JSON.stringify(captured.props[name])).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })

  it('keeps the accent when the data changes', () => {
    render(
      <TimelineBarChart
        data={[{ date: '2026-11-01', label: '01 Nov', total: 5 }]}
        currency="EUR"
      />,
    )

    expect(captured.props.Bar.fill).toBe('var(--chart-accent)')
    expect(captured.props.Bar.dataKey).toBe('total')
  })

  it('renders no Bar for empty data', () => {
    render(<TimelineBarChart data={[]} currency="UAH" />)

    expect(captured.props.Bar).toBeUndefined()
  })
})
