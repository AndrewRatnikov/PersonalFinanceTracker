import { createFileRoute } from '@tanstack/react-router'

import { getRangeAnalytics } from '../lib/analytics'
import CategoryDonutChart from '../components/analytics/CategoryDonutChart'
import TimelineBarChart from '../components/analytics/TimelineBarChart'
import BudgetVarianceBarChart from '../components/analytics/BudgetVarianceBarChart'
import PageShell from '../components/PageShell'
import type { AnalyticsRangeSummary } from '../lib/domain'
import AnalyticsFilters from '../components/analytics/AnalyticsFilters'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export type AnalyticsSearch = {
  from?: string
  to?: string
}

export const Route = createFileRoute('/analytics')({
  validateSearch: (search: Record<string, unknown>): AnalyticsSearch => {
    const result: AnalyticsSearch = {}
    if (typeof search.from === 'string') {
      result.from = search.from
    }
    if (typeof search.to === 'string') {
      result.to = search.to
    }
    return result
  },
  loaderDeps: ({ search: { from, to } }) => ({ from, to }),
  loader: async ({
    deps: { from, to },
  }): Promise<{ analytics: AnalyticsRangeSummary }> => {
    const analytics = await getRangeAnalytics({ data: { from, to } })
    return { analytics }
  },
  component: AnalyticsPage,
})


const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', UAH: '₴' }

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
  const { analytics } = Route.useLoaderData()
  const search = Route.useSearch()

  const hasData =
    analytics.categoryBreakdown.length > 0 || analytics.timeline.length > 0

  const totalSpent = analytics.categoryBreakdown.reduce(
    (sum, item) => sum + item.total,
    0,
  )

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <AnalyticsFilters analytics={analytics} search={search} />

        <div className="grid grid-cols-2 gap-4">
          <StatCard title="Total Spent" value={`${CURRENCY_SYMBOL['UAH']}${totalSpent.toFixed(2)}`} />
          <StatCard title="Total Income" value={`${CURRENCY_SYMBOL['UAH']}${analytics.totalIncome.toFixed(2)}`} />
        </div>

        {hasData ? (
          <>
            <section>
              <h2 className="text-sm font-semibold mb-2">
                By Category
              </h2>
              <CategoryDonutChart data={analytics.categoryBreakdown} />
            </section>

            <section>
              <h2 className="text-sm font-semibold mb-2">
                Over Time
              </h2>
              <TimelineBarChart data={analytics.timeline} />
            </section>

            {analytics.budgetVariance.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold mb-2">Budget vs. Actual</h2>
                <BudgetVarianceBarChart data={analytics.budgetVariance} />
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
      </div>
    </PageShell>
  )
}
