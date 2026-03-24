import { useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import dayjs from 'dayjs'
import { formatRangeLabel, toDateInputValue } from '../../lib/analyticsUtils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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

    const fromDate = dayjs(nextFrom)
    const toDate = dayjs(nextTo)
    if (!fromDate.isValid() || !toDate.isValid()) {
      setValidationError('Dates are invalid.')
      return
    }

    if (fromDate.isAfter(toDate, 'day')) {
      setValidationError('Start date must be before end date.')
      return
    }

    if (toDate.isAfter(dayjs(), 'day')) {
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
    const end = dayjs()
    const start = dayjs().subtract(days - 1, 'day')

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="px-2 py-1 h-auto text-xs border-slate-600 text-slate-200 bg-transparent hover:bg-slate-700 hover:text-slate-100"
            onClick={() => applyPreset(7)}
          >
            7d
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="px-2 py-1 h-auto text-xs border-slate-600 text-slate-200 bg-transparent hover:bg-slate-700 hover:text-slate-100"
            onClick={() => applyPreset(30)}
          >
            30d
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="px-2 py-1 h-auto text-xs border-slate-600 text-slate-200 bg-transparent hover:bg-slate-700 hover:text-slate-100"
            onClick={() => applyPreset(90)}
          >
            90d
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label className="text-xs font-medium text-slate-400">From</Label>
          <Input
            type="date"
            value={fromValue}
            max={toValue || undefined}
            onChange={(e) => handleDateChange(e.target.value, toValue)}
            className="bg-slate-900/60 border-slate-700 text-white text-sm focus-visible:ring-cyan-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs font-medium text-slate-400">To</Label>
          <Input
            type="date"
            value={toValue}
            max={toDateInputValue(dayjs().toISOString())}
            onChange={(e) => handleDateChange(fromValue, e.target.value)}
            className="bg-slate-900/60 border-slate-700 text-white text-sm focus-visible:ring-cyan-500"
          />
        </div>
      </div>

      {validationError && (
        <p className="text-xs text-red-400 mt-1">{validationError}</p>
      )}
    </section>
  )
}
