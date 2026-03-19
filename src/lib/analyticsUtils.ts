import type { AnalyticsRangeSummary } from './domain'

export type RangeInput = {
  from?: string
  to?: string
}

export function getDefaultRange(): { from: string; to: string } {
  const now = new Date()
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)

  const from = new Date(now)
  from.setDate(from.getDate() - 29)
  from.setHours(0, 0, 0, 0)

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

  let fromDate = input.from ? new Date(input.from) : new Date(fallback.from)
  let toDate = input.to ? new Date(input.to) : new Date(fallback.to)

  if (Number.isNaN(fromDate.getTime())) {
    fromDate = new Date(fallback.from)
  }
  if (Number.isNaN(toDate.getTime())) {
    toDate = new Date(fallback.to)
  }

  if (fromDate > toDate) {
    const tmp = fromDate
    fromDate = toDate
    toDate = tmp
  }

  fromDate.setHours(0, 0, 0, 0)
  toDate.setHours(23, 59, 59, 999)

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  }
}

export function toDateInputValue(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatRangeLabel(range: AnalyticsRangeSummary): string {
  const from = new Date(range.from)
  const to = new Date(range.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return ''

  const fromStr = from.toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
  })
  const toStr = to.toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
  })

  return `${fromStr} – ${toStr}`
}
