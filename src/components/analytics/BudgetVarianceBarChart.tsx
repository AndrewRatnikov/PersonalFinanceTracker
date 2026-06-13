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

const ROW_HEIGHT = 48
const LEGEND_HEIGHT = 36
const CHART_PADDING = { top: 8, right: 16, bottom: 8, left: 8 }

function formatValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return String(value)
}

const tooltipStyle = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '8px',
  boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
  color: 'hsl(var(--popover-foreground))',
  fontSize: '12px',
}

export default function BudgetVarianceBarChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card className="border-dashed bg-transparent h-24 flex items-center justify-center">
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

  // Chart grows with the number of categories so labels never overlap
  const chartHeight = data.length * ROW_HEIGHT + LEGEND_HEIGHT

  // Longest label determines left axis width (cap at 160px)
  const yAxisWidth = Math.min(
    160,
    Math.max(...chartData.map((d) => d.name.length)) * 7 + 8,
  )

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm overflow-hidden py-4">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={CHART_PADDING}
          barCategoryGap="30%"
          barGap={3}
        >
          <XAxis
            type="number"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatValue}
          />
          <YAxis
            type="category"
            dataKey="name"
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={yAxisWidth}
          />
          <Tooltip
            cursor={false}
            contentStyle={tooltipStyle}
            itemStyle={{ fontWeight: 600, padding: '0 4px' }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
            formatter={(value: any, name: string) => [
              `${Number(value).toLocaleString()} UAH`,
              name,
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
          />
          <Bar dataKey="Budget" fill="#6366f1" radius={[0, 4, 4, 0]} maxBarSize={16} />
          <Bar dataKey="Actual" radius={[0, 4, 4, 0]} maxBarSize={16}>
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
