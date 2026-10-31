// The dashboard's "This month" by member for a Family (spec §23): the top 3
// members by this local month's live expenses, then "+N" for the rest.

import { Fragment } from 'react'
import dayjs from 'dayjs'

import type { Currency, Expense } from '@/lib/domain'
import type { MemberDirectory } from '@/lib/memberStats'
import { useT } from '@/i18n'
import { formatMoney } from '@/i18n/format'
import { memberLabel, memberTotals, topMembers } from '@/lib/memberStats'

export function MemberSummaryCard({
  expenses,
  directory,
  mainCurrency,
  now,
}: {
  expenses: ReadonlyArray<Expense>
  directory: MemberDirectory
  mainCurrency: Currency
  now?: Date
}) {
  const { t } = useT()
  const month = dayjs(now ?? new Date())
  const thisMonth = expenses.filter((e) => dayjs(e.createdAt).isSame(month, 'month'))
  const { rows } = memberTotals(thisMonth, mainCurrency)
  if (rows.length === 0) return null
  const { top, more } = topMembers(rows, 3)

  return (
    <div
      data-testid="family-month-card"
      className="rounded-xl border bg-card px-4 py-3 text-sm flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span className="font-medium">{t('members.thisMonth')}</span>
      {top.map((row, i) => (
        <Fragment key={row.memberId}>
          {i > 0 && <span className="text-muted-foreground">·</span>}
          <span data-testid={`family-month-member-${row.memberId}`}>
            {`${memberLabel(directory, row.memberId)} ${formatMoney(row.total, mainCurrency)}`}
          </span>
        </Fragment>
      ))}
      {more > 0 && (
        <span data-testid="family-month-more" className="text-muted-foreground">
          {t('members.more', { count: more })}
        </span>
      )}
    </div>
  )
}
