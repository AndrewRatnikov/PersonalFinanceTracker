import dayjs from 'dayjs'
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import type { AnalyticsTimelinePoint } from '@/lib/domain'

interface Props {
  data: Array<AnalyticsTimelinePoint>
}

/** Abbreviate large numbers for the Y-axis: 70000 → 70k, 1500000 → 1.5M */
function formatYAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return String(value)
}

/**
 * When the data spans more than 60 days worth of distinct points,
 * collapse daily buckets into monthly buckets for readability.
 */
function maybeGroupByMonth(
  data: Array<AnalyticsTimelinePoint>,
): Array<AnalyticsTimelinePoint> {
  if (data.length <= 60) return data

  const monthMap = new Map<string, { label: string; total: number }>()
  for (const point of data) {
    const d = dayjs(point.date)
    const key = d.format('YYYY-MM')
    const label = d.format("MMM 'YY")
    const existing = monthMap.get(key)
    if (existing) {
      existing.total += point.total
    } else {
      monthMap.set(key, { label, total: point.total })
    }
  }

  return Array.from(monthMap.entries()).map(([key, { label, total }]) => ({
    date: `${key}-01`,
    label,
    total,
  }))
}

export default function TimelineBarChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card className="border-dashed bg-transparent h-56 flex items-center justify-center">
        <CardContent className="text-muted-foreground text-sm">No data found.</CardContent>
      </Card>
    )
  }

  const chartData = maybeGroupByMonth(data)

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm overflow-hidden h-56 py-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
        >
          <XAxis
            dataKey="label"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            dy={10}
          />
          <YAxis
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatYAxis}
            width={40}
          />
          <Tooltip
            cursor={false}
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
              boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
              color: 'hsl(var(--popover-foreground))',
              fontSize: '12px',
            }}
            itemStyle={{ fontWeight: 600, padding: '0 4px' }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
            formatter={(value) => [
              `${Number(value ?? 0).toLocaleString()} UAH`,
              'Spent',
            ]}
          />
          <Bar
            dataKey="total"
            fill="#6366f1"
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
            className="opacity-90 hover:opacity-100 transition-opacity"
          />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  )
}
