import { createFileRoute } from '@tanstack/react-router'

import { getRangeAnalytics } from '../lib/analytics'
import CategoryDonutChart from '../components/analytics/CategoryDonutChart'
import TimelineBarChart from '../components/analytics/TimelineBarChart'
import PageShell from '../components/PageShell'
import type { AnalyticsRangeSummary } from '../lib/domain'
import AnalyticsFilters from '../components/analytics/AnalyticsFilters'

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
  loader: async ({
    location,
  }): Promise<{ analytics: AnalyticsRangeSummary }> => {
    const url = new URL(location.href, 'http://localhost')
    const from = url.searchParams.get('from') || undefined
    const to = url.searchParams.get('to') || undefined

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
              <h2 className="text-sm font-semibold text-slate-300 mb-2">
                By Category
              </h2>
              <CategoryDonutChart data={analytics.categoryBreakdown} />
            </section>

            <section>
              <h2 className="text-sm font-semibold text-slate-300 mb-2">
                Over Time
              </h2>
              <TimelineBarChart data={analytics.timeline} />
            </section>
          </>
        ) : (
          <section className="mt-4">
            <div className="p-6 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700/60 text-center text-slate-400 text-sm">
              No expenses found in this period. Try expanding the date range.
            </div>
          </section>
        )}
      </div>
    </PageShell>
  )
}
