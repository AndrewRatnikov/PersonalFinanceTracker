import { useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import dayjs from 'dayjs'
import { formatRangeLabel, toDateInputValue } from '../../lib/analyticsUtils'
import type { AnalyticsRangeSummary } from '../../lib/domain'
import type { AnalyticsSearch } from '../../routes/analytics'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type AnalyticsFiltersProps = {
  analytics: AnalyticsRangeSummary
  search: AnalyticsSearch
}

export default function AnalyticsFilters({
  analytics,
  search,
}: AnalyticsFiltersProps) {
  const router = useRouter()
  const { t } = useT()

  const [validationError, setValidationError] = useState<MessageKey | null>(null)

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
      setValidationError('analytics.filters.bothDates')
      return
    }

    const fromDate = dayjs(nextFrom)
    const toDate = dayjs(nextTo)
    if (!fromDate.isValid() || !toDate.isValid()) {
      setValidationError('analytics.filters.invalidDates')
      return
    }

    if (fromDate.isAfter(toDate, 'day')) {
      setValidationError('analytics.filters.startAfterEnd')
      return
    }

    if (toDate.isAfter(dayjs(), 'day')) {
      setValidationError('analytics.filters.endInFuture')
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
    <Card className="shadow-sm border">
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <div className="space-y-1">
          <CardTitle className="text-xl font-bold tracking-tight">
            {t('analytics.title')}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('analytics.filters.showing', { range: formatRangeLabel(analytics) })}
          </p>
        </div>
        <div className="flex items-center gap-1.5 translate-y-1">
          {[7, 30, 90].map((days) => (
            <Button
              key={days}
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs font-medium"
              onClick={() => applyPreset(days)}
            >
              {t('analytics.filters.presetDays', { days })}
            </Button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">
            {t('analytics.filters.from')}
          </Label>
          <Input
            type="date"
            value={fromValue}
            max={toValue || undefined}
            onChange={(e) => handleDateChange(e.target.value, toValue)}
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">
            {t('analytics.filters.to')}
          </Label>
          <Input
            type="date"
            value={toValue}
            max={toDateInputValue(dayjs().toISOString())}
            onChange={(e) => handleDateChange(fromValue, e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        {validationError && (
          <p className="col-span-2 text-xs font-medium text-destructive mt-1 italic animate-in fade-in slide-in-from-top-1">
            {t(validationError)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
