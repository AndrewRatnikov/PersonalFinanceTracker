import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { MonthlyExpenseSummary } from '@/lib/domain'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

interface DashboardStatsProps {
  data: Array<MonthlyExpenseSummary>
}

export default function DashboardStats({ data }: DashboardStatsProps) {
  // If no data, return nothing or empty skeleton
  if (data.length === 0) return null

  // The last item in our data is the current month
  const currentMonthData = data[data.length - 1]
  const currentTotal = currentMonthData.total

  return (
    <Card className="w-full bg-slate-800/40 border-slate-700/50 overflow-hidden">
      <CardHeader className="text-center pb-2">
        <CardDescription className="text-sm font-medium text-slate-400 uppercase tracking-widest">
          Spent This Month ({currentMonthData.name})
        </CardDescription>
        <CardTitle className="mt-2 text-5xl font-black text-white mix-blend-screen">
          {currentTotal} <span className="text-2xl text-cyan-500">UAH</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="h-48 w-full p-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 20, right: 20, left: -20, bottom: 0 }}
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
              formatter={(value: any) => [
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
      </CardContent>
    </Card>
  )
}
