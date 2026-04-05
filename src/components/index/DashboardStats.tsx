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
    <Card className="w-full overflow-hidden border-border bg-card/50 backdrop-blur-sm">
      <CardHeader className="text-center pb-6">
        <CardDescription className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          Spent This Month ({currentMonthData.name})
        </CardDescription>
        <CardTitle className="mt-2 text-6xl font-black tracking-tighter text-foreground">
          {currentTotal.toLocaleString()} <span className="text-2xl text-primary font-bold">UAH</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="h-56 w-full p-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 20, right: 30, left: -20, bottom: 10 }}
          >
            <XAxis
              dataKey="name"
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
              tickLine={false}
              axisLine={false}
              dy={10}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
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
              }}
              itemStyle={{ color: 'hsl(var(--primary))', fontWeight: 'bold' }}
              labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
              formatter={(value: any) => [
                `${value.toLocaleString()} UAH`,
                'Spent',
              ]}
            />
            <Bar
              dataKey="total"
              fill="hsl(var(--primary))"
              radius={[6, 6, 0, 0]}
              maxBarSize={45}
              className="opacity-90 hover:opacity-100 transition-opacity"
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
