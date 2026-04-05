import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import type { CategoryBreakdownItem } from '@/lib/domain'

const COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--secondary-foreground))',
  '#22c55e',
  '#f97316',
  '#a855f7',
  '#ec4899',
]

interface Props {
  data: Array<CategoryBreakdownItem>
}

export default function CategoryDonutChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card className="border-dashed bg-transparent h-64 flex items-center justify-center">
        <CardContent className="text-muted-foreground text-sm">
          No data found.
        </CardContent>
      </Card>
    )
  }

  const chartData = data.map((item) => ({
    name: item.icon ? `${item.icon} ${item.name}` : item.name,
    value: item.total,
  }))

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm overflow-hidden h-64 py-4">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={4}
            stroke="none"
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`cell-${entry.name}-${index}`}
                fill={COLORS[index % COLORS.length]}
                className="opacity-90 hover:opacity-100 transition-opacity outline-none"
              />
            ))}
          </Pie>
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
            formatter={(value: any, name: any) => [
              `${Number(value).toLocaleString()} UAH`,
              name,
            ]}
          />
          <Legend
            verticalAlign="bottom"
            height={40}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{
              fontSize: '11px',
              paddingTop: '10px',
              color: 'hsl(var(--muted-foreground))',
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </Card>
  )
}
