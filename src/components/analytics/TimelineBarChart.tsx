import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { AnalyticsTimelinePoint } from '../../lib/domain'

interface Props {
  data: Array<AnalyticsTimelinePoint>
}

export default function TimelineBarChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="p-6 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700/60 text-center text-slate-400 text-sm">
        No daily activity in this period.
      </div>
    )
  }

  return (
    <div className="h-56 w-full bg-slate-800/40 rounded-2xl border border-slate-700/40 px-4 py-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 0, left: -20, bottom: 0 }}
        >
          <XAxis
            dataKey="label"
            stroke="#64748b"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            dy={10}
          />
          <YAxis
            stroke="#64748b"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `${value}`}
          />
          <Tooltip
            cursor={{ fill: '#334155', opacity: 0.4 }}
            contentStyle={{
              backgroundColor: '#0f172a',
              border: 'none',
              borderRadius: '8px',
              color: '#e5e7eb',
            }}
            labelFormatter={(label: any) => `Date: ${label}`}
            formatter={(value: any) => [`${value} UAH`, 'Spent']}
          />
          <Bar
            dataKey="total"
            fill="#06b6d4"
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
