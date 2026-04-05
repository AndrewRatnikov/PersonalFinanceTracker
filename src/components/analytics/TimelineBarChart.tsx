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

export default function TimelineBarChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card className="border-dashed bg-transparent h-56 flex items-center justify-center">
        <CardContent className="text-muted-foreground text-sm">
          No data found.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm overflow-hidden h-56 py-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
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
            tickFormatter={(value) => `${value}`}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 'var(--radius)',
              boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
              color: 'hsl(var(--popover-foreground))',
              fontSize: '12px',
            }}
            itemStyle={{ fontWeight: 'bold', padding: '0 4px' }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
            labelFormatter={(label: any) => `Date: ${label}`}
            formatter={(value: any) => [`${Number(value).toLocaleString()} UAH`, 'Spent']}
          />
          <Bar
            dataKey="total"
            fill="hsl(var(--primary))"
            radius={[4, 4, 0, 0]}
            maxBarSize={35}
            className="opacity-90 hover:opacity-100 transition-opacity"
          />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  )
}
