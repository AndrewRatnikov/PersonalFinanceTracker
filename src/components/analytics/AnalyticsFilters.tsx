import { useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { toDateInputValue, formatRangeLabel } from '../../lib/analyticsUtils'

import type { AnalyticsRangeSummary } from '../../lib/domain'
import type { AnalyticsSearch } from '../../routes/analytics'

type AnalyticsFiltersProps = {
  analytics: AnalyticsRangeSummary
  search: AnalyticsSearch
}

export default function AnalyticsFilters({ analytics, search }: AnalyticsFiltersProps) {
  const router = useRouter()

  const [validationError, setValidationError] = useState<string | null>(null)

  const fromValue = useMemo(
    () => search.from || toDateInputValue(analytics.from),
    [search.from, analytics.from],
  )

  const toValue = useMemo(
    () => search.to || toDateInputValue(analytics.to),
    [search.to, analytics.to],
  )

  const handleDateChange = (nextFrom: string, nextTo: string) => {
    setValidationError(null)

    if (!nextFrom || !nextTo) {
      setValidationError('Please provide both start and end dates.')
      return
    }

    const fromDate = new Date(nextFrom)
    const toDate = new Date(nextTo)
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      setValidationError('Dates are invalid.')
      return
    }

    if (fromDate > toDate) {
      setValidationError('Start date must be before end date.')
      return
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (toDate > today) {
      setValidationError('End date cannot be in the future.')
      return
    }

    router.navigate({
      to: '/analytics',
      search: (prev: AnalyticsSearch) => ({
        ...prev,
        from: nextFrom,
        to: nextTo,
      }),
    })
  }

  const applyPreset = (days: number) => {
    const now = new Date()
    const end = new Date(now)
    const start = new Date(now)
    start.setDate(start.getDate() - (days - 1))

    const toStr = toDateInputValue(end.toISOString())
    const fromStr = toDateInputValue(start.toISOString())
    handleDateChange(fromStr, toStr)
  }

  return (
    <section className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-white">Analytics</h1>
          <p className="text-xs text-slate-400 mt-1">
            Showing expenses from {formatRangeLabel(analytics)}
          </p>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className="px-2 py-1 text-xs rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-700"
            onClick={() => applyPreset(7)}
          >
            7d
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-700"
            onClick={() => applyPreset(30)}
          >
            30d
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-700"
            onClick={() => applyPreset(90)}
          >
            90d
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-400">From</label>
          <input
            type="date"
            value={fromValue}
            max={toValue || undefined}
            onChange={(e) => handleDateChange(e.target.value, toValue)}
            className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-400">To</label>
          <input
            type="date"
            value={toValue}
            max={toDateInputValue(new Date().toISOString())}
            onChange={(e) => handleDateChange(fromValue, e.target.value)}
            className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
      </div>

      {validationError && (
        <p className="text-xs text-red-400 mt-1">{validationError}</p>
      )}
    </section>
  )
}
