import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import type { CategoryBreakdownItem } from '@/lib/domain'

const COLORS = [
  '#6366f1',
  '#22c55e',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#f59e0b',
  '#3b82f6',
  '#ef4444',
  '#84cc16',
  '#06b6d4',
  '#8b5cf6',
  '#f43f5e',
  '#10b981',
  '#fb923c',
  '#a3e635',
]

// Collapse long tail into "Other" so the chart stays readable
const MAX_SLICES = 10

interface Props {
  data: Array<CategoryBreakdownItem>
}

export default function CategoryDonutChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card className="border-dashed bg-transparent h-48 flex items-center justify-center">
        <CardContent className="text-muted-foreground text-sm">No data found.</CardContent>
      </Card>
    )
  }

  const sorted = [...data].sort((a, b) => b.total - a.total)
  const visible = sorted.slice(0, MAX_SLICES)
  const rest = sorted.slice(MAX_SLICES)
  const otherTotal = rest.reduce((sum, item) => sum + item.total, 0)

  const chartData = [
    ...visible.map((item) => ({
      categoryId: item.categoryId,
      name: item.icon ? `${item.icon} ${item.name}` : item.name,
      shortName: item.name,
      icon: item.icon,
      value: item.total,
    })),
    ...(otherTotal > 0
      ? [{ categoryId: 'other', name: 'Other', shortName: 'Other', icon: null, value: otherTotal }]
      : []),
  ]

  const grandTotal = chartData.reduce((sum, d) => sum + d.value, 0)

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm overflow-hidden">
      {/* Donut */}
      <div className="h-52 w-full py-4">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              innerRadius="52%"
              outerRadius="78%"
              paddingAngle={3}
              stroke="none"
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={`cell-${entry.categoryId}`}
                  fill={COLORS[index % COLORS.length]}
                  className="opacity-90 hover:opacity-100 transition-opacity outline-none"
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px',
                boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                color: 'hsl(var(--popover-foreground))',
                fontSize: '12px',
              }}
              itemStyle={{ fontWeight: 600, padding: '0 4px' }}
              formatter={(value, name) => {
                const n = Number(value ?? 0)
                const pct = grandTotal > 0 ? ((n / grandTotal) * 100).toFixed(1) : '0'
                return [`${n.toLocaleString()} UAH (${pct}%)`, name ?? '']
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Custom legend — wraps naturally inside the card, never overflows */}
      <div className="px-4 pb-4 flex flex-wrap gap-x-4 gap-y-2">
        {chartData.map((item, index) => (
          <div key={item.categoryId} className="flex items-center gap-1.5 min-w-0">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: COLORS[index % COLORS.length] }}
            />
            <span className="text-xs text-muted-foreground truncate max-w-[120px]">
              {item.icon ? `${item.icon} ` : ''}
              {item.shortName}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}
