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
import PageContainer from '../components/PageContainer'
import AnalyticsFilters from '../components/analytics/AnalyticsFilters'
import { QueryErrorState } from '../components/QueryErrorState'
import type { Currency, Expense, MonthlyExpenseSummary } from '@/lib/domain'
import { useT } from '@/i18n'
import { formatShortMonth } from '@/i18n/format'
import { MemberBreakdown } from '@/components/analytics/MemberBreakdown'
import ConversionPendingNote from '@/components/ConversionPendingNote'
import DashboardStats from '@/components/index/DashboardStats'
import { MemberFilter } from '@/components/members/MemberFilter'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { filterByMember, memberFilterOptions } from '@/lib/memberStats'
import { formatMoney, mainAmountOf } from '@/lib/money'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { spaceArgs } from '@/lib/spaces/spaceDb'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
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

// Chart grid cells keep today's DOM order (phones follow it); from lg each cell
// gets a fixed order that pairs them: donut | 12-month, budget-vs-actual | income,
// members | over-time. Class strings are literals so Tailwind sees them.
type ChartCell =
  | 'categoryDonut'
  | 'incomeDonut'
  | 'members'
  | 'timeline'
  | 'budgetVariance'
  | 'monthly'
  | 'noData'

const CHART_CELL_ORDER: Record<ChartCell, number> = {
  categoryDonut: 1,
  noData: 1,
  monthly: 2,
  budgetVariance: 3,
  incomeDonut: 4,
  members: 5,
  timeline: 6,
}

const CHART_CELL_CLASS: Record<ChartCell, string> = {
  categoryDonut: 'flex min-w-0 flex-col lg:[&>[data-slot=card]]:flex-1 lg:order-1',
  noData: 'flex min-w-0 flex-col lg:[&>[data-slot=card]]:flex-1 lg:order-1 mt-4',
  monthly: 'flex min-w-0 flex-col lg:[&>[data-slot=card]]:flex-1 lg:order-2',
  budgetVariance: 'flex min-w-0 flex-col lg:[&>[data-slot=card]]:flex-1 lg:order-3',
  incomeDonut: 'flex min-w-0 flex-col lg:[&>[data-slot=card]]:flex-1 lg:order-4',
  members: 'flex min-w-0 flex-col gap-8 lg:[&>[data-slot=card]]:flex-1 lg:order-5',
  timeline: 'flex min-w-0 flex-col lg:[&>[data-slot=card]]:flex-1 lg:order-6',
}

const CHART_CELL_SPAN_CLASS = 'lg:col-span-2'

/** Class lookup for the visible cells: with an odd count, the last cell in lg order spans both columns. */
function chartCellClasses(visible: Array<ChartCell>): (cell: ChartCell) => string {
  const last =
    visible.length % 2 === 1
      ? visible.reduce((a, b) => (CHART_CELL_ORDER[b] > CHART_CELL_ORDER[a] ? b : a))
      : null
  return (cell) =>
    cell === last ? `${CHART_CELL_CLASS[cell]} ${CHART_CELL_SPAN_CLASS}` : CHART_CELL_CLASS[cell]
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
  // Family: a member filter on every number, and totals by member.
  const { isFamily, directory } = useSpaceSwitch()
  const showMembers = isFamily && directory !== null
  const [memberFilter, setMemberFilter] = useState('all')
  const [shownSpaceId, setShownSpaceId] = useState(spaceId)
  if (shownSpaceId !== spaceId) {
    setShownSpaceId(spaceId)
    setMemberFilter('all')
  }
  const memberId = showMembers && memberFilter !== 'all' ? memberFilter : undefined

  const analyticsQuery = useQuery({
    // The language is in the key: the timeline labels are formatted in it.
    queryKey: spaceQueryKey(
      spaceId,
      'analytics',
      search.from,
      search.to,
      mainCurrency,
      lang,
      ...(showMembers ? ['members', memberId ?? 'all'] : []),
    ),
    queryFn: () =>
      showMembers
        ? computeRangeAnalytics({ from: search.from, to: search.to }, mainCurrency, {
            spaceId,
            byMember: true,
            ...(memberId !== undefined ? { memberId } : {}),
          })
        : computeRangeAnalytics(
            { from: search.from, to: search.to },
            mainCurrency,
            ...spaceArgs(spaceId),
          ),
    enabled: settingsReady,
    // A member filter change keeps the page (and the filter) on screen while
    // it recomputes; another space never shows the previous space's numbers.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === spaceId ? previous : undefined,
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

  const memberOptions = useMemo(
    () => (showMembers ? memberFilterOptions(directory, monthlyExpenses) : []),
    [showMembers, directory, monthlyExpenses],
  )
  // The 12-month chart follows the member filter too (in memory).
  const memberExpenses = useMemo(
    () =>
      memberId !== undefined ? filterByMember(monthlyExpenses, memberId) : monthlyExpenses,
    [monthlyExpenses, memberId],
  )

  const monthlyStats = useMemo(
    () => computeMonthlyStats(memberExpenses, dayjs(todayStr), mainCurrency),
    // lang re-labels the months.
    [memberExpenses, todayStr, mainCurrency, lang],
  )

  // Check for errors before the spinner: a failed query must never spin forever.
  const failedQueries = [analyticsQuery, monthlyExpensesQuery].filter(
    (q) => q.isError,
  )
  if (failedQueries.length > 0) {
    return (
      <PageShell>
        <PageContainer className="flex flex-col gap-8">
          <QueryErrorState
            onRetry={() => failedQueries.forEach((q) => void q.refetch())}
          />
        </PageContainer>
      </PageShell>
    )
  }

  if (!settingsReady || analyticsQuery.isLoading || !analytics) {
    return (
      <PageShell>
        <PageContainer
          data-testid="analytics-loading"
          className="flex items-center justify-center min-h-[60vh]"
        >
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </PageContainer>
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

  const showMembersCell = showMembers && analytics.members !== undefined
  const showBudgetCell = analytics.budgetVariance.length > 0
  const visibleCells: Array<ChartCell> = hasData
    ? [
        'categoryDonut',
        'incomeDonut',
        ...(showMembersCell ? (['members'] as const) : []),
        'timeline',
        ...(showBudgetCell ? (['budgetVariance'] as const) : []),
        'monthly',
      ]
    : ['noData', 'monthly']
  const cellClass = chartCellClasses(visibleCells)

  return (
    <PageShell>
      <PageContainer data-testid="analytics-page" className="flex flex-col gap-8">
        <AnalyticsFilters analytics={analytics} search={search} />

        {showMembers && (
          <MemberFilter
            value={memberFilter}
            onChange={setMemberFilter}
            options={memberOptions}
          />
        )}

        <div data-testid="analytics-summary" className="grid grid-cols-2 gap-4">
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

        <div
          data-testid="analytics-chart-grid"
          className="flex flex-col gap-8 lg:grid lg:grid-cols-2"
        >
          {hasData ? (
            <>
              <section
                data-testid="analytics-category-donut"
                className={cellClass('categoryDonut')}
              >
                <h2 className="text-sm font-semibold mb-2">{t('analytics.byCategory')}</h2>
                <CategoryDonutChart
                  data={analytics.categoryBreakdown}
                  currency={mainCurrency}
                  ariaLabel={t('analytics.spendingByCategory')}
                />
              </section>

              <section data-testid="analytics-income-donut" className={cellClass('incomeDonut')}>
                <h2 className="text-sm font-semibold mb-2">{t('analytics.incomeSources')}</h2>
                <CategoryDonutChart
                  data={analytics.incomeBreakdown}
                  currency={mainCurrency}
                  emptyText={t('analytics.noIncome')}
                  ariaLabel={t('analytics.incomeByCategory')}
                />
              </section>

              {showMembers && analytics.members && (
                <div data-testid="analytics-members" className={cellClass('members')}>
                  <MemberBreakdown
                    kind="expense"
                    rows={analytics.members.expense}
                    directory={directory}
                    mainCurrency={mainCurrency}
                  />
                  <MemberBreakdown
                    kind="income"
                    rows={analytics.members.income}
                    directory={directory}
                    mainCurrency={mainCurrency}
                  />
                </div>
              )}

              <section data-testid="analytics-timeline" className={cellClass('timeline')}>
                <h2 className="text-sm font-semibold mb-2">{t('analytics.overTime')}</h2>
                <TimelineBarChart data={analytics.timeline} currency={mainCurrency} />
              </section>

              {showBudgetCell && (
                <section
                  data-testid="analytics-budget-variance"
                  className={cellClass('budgetVariance')}
                >
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
            <section data-testid="analytics-no-data" className={cellClass('noData')}>
              <Card className="border-dashed bg-transparent">
                <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
                  {t('analytics.noDataForPeriod')}
                </CardContent>
              </Card>
            </section>
          )}

          <section data-testid="analytics-monthly" className={cellClass('monthly')}>
            <DashboardStats data={monthlyStats} currency={mainCurrency} />
          </section>
        </div>
      </PageContainer>
    </PageShell>
  )
}
