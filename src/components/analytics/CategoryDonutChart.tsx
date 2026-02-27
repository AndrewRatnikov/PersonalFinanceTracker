import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'

import type { CategoryBreakdownItem } from '../../lib/domain'

const COLORS = ['#06b6d4', '#22c55e', '#f97316', '#eab308', '#a855f7']

interface Props {
  data: Array<CategoryBreakdownItem>
}

export default function CategoryDonutChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="p-6 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700/60 text-center text-slate-400 text-sm">
        No expenses in this period.
      </div>
    )
  }

  const chartData = data.map((item) => ({
    name: item.icon ? `${item.icon} ${item.name}` : item.name,
    value: item.total,
  }))

  return (
    <div className="h-64 w-full bg-slate-800/40 rounded-2xl border border-slate-700/40 px-4 py-3">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={3}
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`cell-${entry.name}-${index}`}
                fill={COLORS[index % COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip
            cursor={{ fill: '#334155', opacity: 0.4 }}
            contentStyle={{
              backgroundColor: '#0f172a',
              border: 'none',
              borderRadius: '8px',
              color: '#e5e7eb',
            }}
            formatter={(value: number, name: string) => [`${value} UAH`, name]}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            wrapperStyle={{ fontSize: 11, color: '#cbd5f5' }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
