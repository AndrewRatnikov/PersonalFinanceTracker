// Analytics by member (spec §23): total, share and average per month for each
// member, with a bar in the member's colour token.

import type { Currency } from '@/lib/domain'
import type { MemberDirectory, MemberTotal } from '@/lib/memberStats'
import { useT } from '@/i18n'
import { formatMoney } from '@/i18n/format'
import { memberLabel } from '@/lib/memberStats'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function MemberBreakdown({
  kind,
  rows,
  directory,
  mainCurrency,
}: {
  kind: 'expense' | 'income'
  rows: ReadonlyArray<MemberTotal>
  directory: MemberDirectory
  mainCurrency: Currency
}) {
  const { t } = useT()
  return (
    <Card data-testid={`analytics-members-${kind}`}>
      <CardHeader>
        <CardTitle>{t(kind === 'expense' ? 'members.byMember' : 'members.receivedBy')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.map((row) => {
          const percent = Math.round(row.share * 100)
          const color = directory.byId.get(row.memberId)?.color ?? 'var(--muted-foreground)'
          return (
            <div
              key={row.memberId}
              data-testid={`analytics-member-${kind}-${row.memberId}`}
              className="flex flex-col gap-1.5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">{memberLabel(directory, row.memberId)}</span>
                <span className="flex items-baseline gap-3">
                  <span data-testid={`analytics-member-total-${kind}-${row.memberId}`}>
                    {formatMoney(row.total, mainCurrency)}
                  </span>
                  <span
                    data-testid={`analytics-member-share-${kind}-${row.memberId}`}
                    className="text-muted-foreground"
                  >
                    {`${percent}%`}
                  </span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, Math.max(0, row.share * 100))}%`, background: color }}
                />
              </div>
              <span
                data-testid={`analytics-member-average-${kind}-${row.memberId}`}
                className="text-xs text-muted-foreground"
              >
                {t('members.perMonth', { amount: formatMoney(row.averagePerMonth, mainCurrency) })}
              </span>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
