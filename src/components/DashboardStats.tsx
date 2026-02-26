import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

import type { MonthlyExpenseSummary } from '../lib/domain'

interface DashboardStatsProps {
  data: MonthlyExpenseSummary[]
}

export default function DashboardStats({ data }: DashboardStatsProps) {
  // If no data, return nothing or empty skeleton
  if (!data || data.length === 0) return null

  // The last item in our data is the current month
  const currentMonthData = data[data.length - 1]
  const currentTotal = currentMonthData ? currentMonthData.total : 0

  return (
    <div className="w-full flex flex-col gap-6 py-4">
      <div className="text-center">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-widest">
          Spent This Month ({currentMonthData?.name})
        </h2>
        <div className="mt-2 text-5xl font-black text-white mix-blend-screen">
          {currentTotal} <span className="text-2xl text-cyan-500">UAH</span>
        </div>
      </div>

      <div className="h-48 w-full mt-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
          >
            <XAxis
              dataKey="name"
              stroke="#64748b"
              fontSize={12}
              tickLine={false}
              axisLine={false}
              dy={10}
            />
            <YAxis
              stroke="#64748b"
              fontSize={12}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `${value}`}
            />
            <Tooltip
              cursor={{ fill: '#334155', opacity: 0.4 }}
              contentStyle={{
                backgroundColor: '#1e293b',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
              }}
              formatter={(value: string | undefined) => [
                `${value} UAH`,
                'Spent',
              ]}
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
    </div>
  )
}
