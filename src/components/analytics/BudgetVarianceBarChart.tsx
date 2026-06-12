import {
  Bar,
  BarChart,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import type { BudgetVarianceItem } from '@/lib/domain'

interface Props {
  data: Array<BudgetVarianceItem>
}

function formatYAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return String(value)
}

export default function BudgetVarianceBarChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card className="border-dashed bg-transparent h-[260px] flex items-center justify-center">
        <CardContent className="text-muted-foreground text-sm">No budget data found.</CardContent>
      </Card>
    )
  }

  const chartData = data.map((item) => ({
    name: item.icon ? `${item.icon} ${item.name}` : item.name,
    Budget: item.budget,
    Actual: item.actual,
    overBudget: item.overBudget,
  }))

  const tooltipStyle = {
    backgroundColor: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '8px',
    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    color: 'hsl(var(--popover-foreground))',
    fontSize: '12px',
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm overflow-hidden py-4">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
          <XAxis
            dataKey="name"
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
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
            contentStyle={tooltipStyle}
            itemStyle={{ fontWeight: 600, padding: '0 4px' }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
            formatter={(value: any, name: any) => [
              `${Number(value).toLocaleString()} UAH`,
              name,
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
          />
          <Bar dataKey="Budget" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={40} />
          <Bar dataKey="Actual" radius={[4, 4, 0, 0]} maxBarSize={40}>
            {chartData.map((entry, index) => (
              <Cell
                key={`actual-cell-${index}`}
                fill={entry.overBudget ? '#ef4444' : '#22c55e'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  )
}
