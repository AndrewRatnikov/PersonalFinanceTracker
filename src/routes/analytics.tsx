import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { computeRangeAnalytics } from '../lib/localAnalytics'
import CategoryDonutChart from '../components/analytics/CategoryDonutChart'
import TimelineBarChart from '../components/analytics/TimelineBarChart'
import BudgetVarianceBarChart from '../components/analytics/BudgetVarianceBarChart'
import PageShell from '../components/PageShell'
import AnalyticsFilters from '../components/analytics/AnalyticsFilters'
import type { ExcludedCurrencyTotal } from '@/lib/dashboardSummary'
import type { Currency, Expense, MonthlyExpenseSummary } from '@/lib/domain'
import DashboardStats from '@/components/index/DashboardStats'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CURRENCIES } from '@/lib/domain'
import { getExpensesForRange } from '@/lib/localDb'

export type AnalyticsSearch = {
  from?: string
  to?: string
}

export const Route = createFileRoute('/analytics')({
  validateSearch: (search: Record<string, unknown>): AnalyticsSearch => {
    const result: AnalyticsSearch = {}
    if (typeof search.from === 'string') result.from = search.from
    if (typeof search.to === 'string') result.to = search.to
    return result
  },
  component: AnalyticsPage,
})

function computeMonthlyStats(
  expenses: Array<Expense>,
  now: dayjs.Dayjs,
  currency: Currency,
): Array<MonthlyExpenseSummary> {
  const monthlyMap: Record<string, number> = {}
  for (let i = 11; i >= 0; i--) {
    const d = now.subtract(i, 'month')
    const key = `${d.year()}-${d.format('MMM')}`
    monthlyMap[key] = 0
  }
  for (const e of expenses) {
    if (e.currency !== currency) continue
    const d = dayjs(e.createdAt)
    const key = `${d.year()}-${d.format('MMM')}`
    if (key in monthlyMap) monthlyMap[key] += Number(e.amount)
  }
  return Object.entries(monthlyMap).map(([key, total]) => {
    const [year, month] = key.split('-')
    return { month, year, name: month, total }
  })
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', UAH: '₴' }

function formatExcluded(excluded: Array<ExcludedCurrencyTotal>): string {
  const parts: Array<string> = []
  for (const item of excluded) {
    if (item.expenses !== 0) {
      parts.push(`${item.expenses.toLocaleString()} ${item.currency}`)
    }
    if (item.income !== 0) {
      parts.push(`+${item.income.toLocaleString()} ${item.currency}`)
    }
  }
  return parts.join(', ')
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card className="shadow-sm border">
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  )
}

function AnalyticsPage() {
  const search = Route.useSearch()
  const [currency, setCurrency] = useState<Currency>('UAH')

  const { data: analytics, isLoading } = useQuery({
    queryKey: ['analytics', search.from, search.to, currency],
    queryFn: () =>
      computeRangeAnalytics({ from: search.from, to: search.to }, currency),
  })

  const todayStr = dayjs().format('YYYY-MM-DD')
  const { from, to } = useMemo(
    () => ({
      from: dayjs(todayStr)
        .subtract(11, 'month')
        .startOf('month')
        .toISOString(),
      to: dayjs(todayStr).endOf('day').toISOString(),
    }),
    [todayStr],
  )

  const { data: monthlyExpenses = [] } = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => getExpensesForRange(from, to),
  })

  const monthlyStats = useMemo(
    () => computeMonthlyStats(monthlyExpenses, dayjs(todayStr), currency),
    [monthlyExpenses, todayStr, currency],
  )

  if (isLoading || !analytics) {
    return (
      <PageShell>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PageShell>
    )
  }

  const hasData =
    analytics.categoryBreakdown.length > 0 || analytics.timeline.length > 0

  const totalSpent = analytics.categoryBreakdown.reduce(
    (sum, item) => sum + item.total,
    0,
  )

  const excludedText = formatExcluded(analytics.excluded)

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <AnalyticsFilters analytics={analytics} search={search} />

        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Currency</span>
          <select
            data-testid="analytics-currency-select"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-4">
          <div data-testid="analytics-total-spent">
            <StatCard
              title="Total Spent"
              value={`${CURRENCY_SYMBOL[currency]}${totalSpent.toFixed(2)}`}
            />
          </div>
          <div data-testid="analytics-total-income">
            <StatCard
              title="Total Income"
              value={`${CURRENCY_SYMBOL[currency]}${analytics.totalIncome.toFixed(2)}`}
            />
          </div>
        </div>

        {excludedText !== '' && (
          <p
            data-testid="analytics-excluded"
            className="text-xs text-muted-foreground"
          >
            Not included: {excludedText}
          </p>
        )}

        {hasData ? (
          <>
            <section>
              <h2 className="text-sm font-semibold mb-2">By Category</h2>
              <CategoryDonutChart
                data={analytics.categoryBreakdown}
                currency={currency}
              />
            </section>

            <section>
              <h2 className="text-sm font-semibold mb-2">Over Time</h2>
              <TimelineBarChart data={analytics.timeline} currency={currency} />
            </section>

            {analytics.budgetVariance.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold mb-2">
                  Budget vs. Actual
                </h2>
                <BudgetVarianceBarChart
                  data={analytics.budgetVariance}
                  currency={currency}
                />
              </section>
            )}
          </>
        ) : (
          <section className="mt-4">
            <Card className="border-dashed bg-transparent">
              <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
                No data found for this period. Try expanding the range.
              </CardContent>
            </Card>
          </section>
        )}

        <section>
          <DashboardStats data={monthlyStats} currency={currency} />
        </section>
      </div>
    </PageShell>
  )
}
