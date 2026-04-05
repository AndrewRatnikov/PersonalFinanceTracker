import { createFileRoute } from '@tanstack/react-router'

import { getRangeAnalytics } from '../lib/analytics'
import CategoryDonutChart from '../components/analytics/CategoryDonutChart'
import TimelineBarChart from '../components/analytics/TimelineBarChart'
import PageShell from '../components/PageShell'
import type { AnalyticsRangeSummary } from '../lib/domain'
import AnalyticsFilters from '../components/analytics/AnalyticsFilters'
import { Card, CardContent } from '@/components/ui/card'

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
    const analytics = await (getRangeAnalytics as any)({ from, to })
    return { analytics }
  },
  component: AnalyticsPage,
})


function AnalyticsPage() {
  const { analytics } = Route.useLoaderData()
  const search = Route.useSearch()


  const hasData =
    analytics.categoryBreakdown.length > 0 || analytics.timeline.length > 0

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <AnalyticsFilters analytics={analytics} search={search} />

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
