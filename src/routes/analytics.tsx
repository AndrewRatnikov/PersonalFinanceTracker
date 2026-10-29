import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { Loader2 } from 'lucide-react'
import { useMemo } from 'react'

import { computeRangeAnalytics } from '../lib/localAnalytics'
import CategoryDonutChart from '../components/analytics/CategoryDonutChart'
import TimelineBarChart from '../components/analytics/TimelineBarChart'
import BudgetVarianceBarChart from '../components/analytics/BudgetVarianceBarChart'
import PageShell from '../components/PageShell'
import AnalyticsFilters from '../components/analytics/AnalyticsFilters'
import { QueryErrorState } from '../components/QueryErrorState'
import type { Currency, Expense, MonthlyExpenseSummary } from '@/lib/domain'
import { useT } from '@/i18n'
import { formatShortMonth } from '@/i18n/format'
import ConversionPendingNote from '@/components/ConversionPendingNote'
import DashboardStats from '@/components/index/DashboardStats'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { formatMoney, mainAmountOf } from '@/lib/money'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { spaceArgs } from '@/lib/spaces/spaceDb'
import { useCurrencySettings } from '@/lib/useCurrencySettings'

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
  mainCurrency: Currency,
): Array<MonthlyExpenseSummary> {
  // Keyed by the machine month (YYYY-MM); `name` is the display label.
  const monthlyMap: Record<string, number> = {}
  for (let i = 11; i >= 0; i--) {
    const d = now.subtract(i, 'month')
    monthlyMap[d.format('YYYY-MM')] = 0
  }
  for (const e of expenses) {
    // Pending entries (no rate yet) are left out, never mixed in.
    const main = mainAmountOf(e, mainCurrency)
    if (main === null) continue
    const key = dayjs(e.createdAt).format('YYYY-MM')
    if (key in monthlyMap) monthlyMap[key] += main
  }
  return Object.entries(monthlyMap).map(([key, total]) => {
    const [year, month] = key.split('-')
    return { month, year, name: formatShortMonth(`${key}-01`), total }
  })
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
  const { t, lang } = useT()
  const settingsQuery = useCurrencySettings()
  // getCurrencySettings never throws, so this only waits for the first read.
  const settingsReady = !settingsQuery.isLoading
  const mainCurrency = settingsQuery.data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY
  const fetchExchangeRates = settingsQuery.data?.fetchExchangeRates ?? true

  const spaceId = useActiveSpace()
  const db = useSpaceDb()

  const analyticsQuery = useQuery({
    // The language is in the key: the timeline labels are formatted in it.
    queryKey: spaceQueryKey(spaceId, 'analytics', search.from, search.to, mainCurrency, lang),
    queryFn: () =>
      computeRangeAnalytics(
        { from: search.from, to: search.to },
        mainCurrency,
        ...spaceArgs(spaceId),
      ),
    enabled: settingsReady,
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

  const monthlyExpensesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'expenses', from, to),
    queryFn: () => db.getExpensesForRange(from, to),
  })
  const monthlyExpenses = useMemo(
    () => monthlyExpensesQuery.data ?? [],
    [monthlyExpensesQuery.data],
  )
  const analytics = analyticsQuery.data

  const monthlyStats = useMemo(
    () => computeMonthlyStats(monthlyExpenses, dayjs(todayStr), mainCurrency),
    // lang re-labels the months.
    [monthlyExpenses, todayStr, mainCurrency, lang],
  )

  // Check for errors before the spinner: a failed query must never spin forever.
  const failedQueries = [analyticsQuery, monthlyExpensesQuery].filter(
    (q) => q.isError,
  )
  if (failedQueries.length > 0) {
    return (
      <PageShell>
        <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
          <QueryErrorState
            onRetry={() => failedQueries.forEach((q) => void q.refetch())}
          />
        </div>
      </PageShell>
    )
  }

  if (!settingsReady || analyticsQuery.isLoading || !analytics) {
    return (
      <PageShell>
        <div
          data-testid="analytics-loading"
          className="flex items-center justify-center min-h-[60vh]"
        >
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PageShell>
    )
  }

  // A range with income but no expenses still shows the income donut.
  const hasData =
    analytics.categoryBreakdown.length > 0 ||
    analytics.timeline.length > 0 ||
    analytics.incomeBreakdown.length > 0

  const totalSpent = analytics.categoryBreakdown.reduce(
    (sum, item) => sum + item.total,
    0,
  )

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <AnalyticsFilters analytics={analytics} search={search} />

        <div className="grid grid-cols-2 gap-4">
          <div data-testid="analytics-total-spent">
            <StatCard
              title={t('analytics.totalSpent')}
              value={formatMoney(totalSpent, mainCurrency)}
            />
          </div>
          <div data-testid="analytics-total-income">
            <StatCard
              title={t('analytics.totalIncome')}
              value={formatMoney(analytics.totalIncome, mainCurrency)}
            />
          </div>
        </div>

        <ConversionPendingNote
          count={analytics.pendingCount}
          budgetsExcluded={analytics.budgetsExcluded}
          fetchExchangeRates={fetchExchangeRates}
        />

        {hasData ? (
          <>
            <section data-testid="analytics-category-donut">
              <h2 className="text-sm font-semibold mb-2">{t('analytics.byCategory')}</h2>
              <CategoryDonutChart
                data={analytics.categoryBreakdown}
                currency={mainCurrency}
                ariaLabel={t('analytics.spendingByCategory')}
              />
            </section>

            <section data-testid="analytics-income-donut">
              <h2 className="text-sm font-semibold mb-2">{t('analytics.incomeSources')}</h2>
              <CategoryDonutChart
                data={analytics.incomeBreakdown}
                currency={mainCurrency}
                emptyText={t('analytics.noIncome')}
                ariaLabel={t('analytics.incomeByCategory')}
              />
            </section>

            <section>
              <h2 className="text-sm font-semibold mb-2">{t('analytics.overTime')}</h2>
              <TimelineBarChart data={analytics.timeline} currency={mainCurrency} />
            </section>

            {analytics.budgetVariance.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold mb-2">
                  {t('analytics.budgetVsActual')}
                </h2>
                <BudgetVarianceBarChart
                  data={analytics.budgetVariance}
                  currency={mainCurrency}
                />
              </section>
            )}
          </>
        ) : (
          <section data-testid="analytics-no-data" className="mt-4">
            <Card className="border-dashed bg-transparent">
              <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
                {t('analytics.noDataForPeriod')}
              </CardContent>
            </Card>
          </section>
        )}

        <section>
          <DashboardStats data={monthlyStats} currency={mainCurrency} />
        </section>
      </div>
    </PageShell>
  )
}
