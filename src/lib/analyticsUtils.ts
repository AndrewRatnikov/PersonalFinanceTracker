import dayjs from 'dayjs'
import type { AnalyticsRangeSummary } from './domain'

export type RangeInput = {
  from?: string
  to?: string
}

export function getDefaultRange(): { from: string; to: string } {
  const to = dayjs().endOf('day')
  const from = dayjs().subtract(29, 'day').startOf('day')

  return {
    from: from.toISOString(),
    to: to.toISOString(),
  }
}

export function normalizeRange(input: RangeInput): { from: string; to: string } {
  const fallback = getDefaultRange()

  if (!input.from && !input.to) {
    return fallback
  }

  let fromDate = input.from ? dayjs(input.from) : dayjs(fallback.from)
  let toDate = input.to ? dayjs(input.to) : dayjs(fallback.to)

  if (!fromDate.isValid()) {
    fromDate = dayjs(fallback.from)
  }
  if (!toDate.isValid()) {
    toDate = dayjs(fallback.to)
  }

  if (fromDate.isAfter(toDate)) {
    const tmp = fromDate
    fromDate = toDate
    toDate = tmp
  }

  return {
    from: fromDate.startOf('day').toISOString(),
    to: toDate.endOf('day').toISOString(),
  }
}

export function toDateInputValue(iso: string): string {
  if (!iso) return ''
  const d = dayjs(iso)
  if (!d.isValid()) return ''
  return d.format('YYYY-MM-DD')
}

export function formatRangeLabel(range: AnalyticsRangeSummary): string {
  const from = dayjs(range.from)
  const to = dayjs(range.to)
  if (!from.isValid() || !to.isValid()) return ''

  return `${from.format('MMM DD')} – ${to.format('MMM DD')}`
}
