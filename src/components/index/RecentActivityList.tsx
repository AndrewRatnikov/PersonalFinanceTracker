import dayjs from 'dayjs'

import type { RecentItem } from '@/lib/dashboardSummary'
import type { Currency } from '@/lib/domain'
import { incomeSourceLabel } from '@/lib/incomeCategories'
import EntryAmount from '@/components/EntryAmount'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface RecentActivityListProps {
  items: Array<RecentItem>
  mainCurrency: Currency
}

export default function RecentActivityList({
  items,
  mainCurrency,
}: RecentActivityListProps) {
  return (
    <div className="flex flex-col gap-4" data-testid="recent-activity">
      <h3 className="text-lg font-semibold tracking-tight">Recent activity</h3>
      {items.length === 0 ? (
        <Card
          className="border-dashed bg-transparent"
          data-testid="recent-activity-empty"
        >
          <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
            No recent activity yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((item) => {
            const date = dayjs(item.createdAt)
            const timeString = date.format('hh:mm A')
            const dateString = date.format('MMM D')
            const isIncome = item.kind === 'income'
            const icon = isIncome
              ? item.category?.icon || '💰'
              : item.category?.icon || '🏷️'
            const label = isIncome
              ? incomeSourceLabel(item)
              : item.category?.name || 'Uncategorized'

            return (
              <Card
                key={`${item.kind}-${item.id}`}
                className="overflow-hidden transition-colors hover:bg-accent/50 group"
                data-testid="recent-activity-item"
                data-kind={item.kind}
              >
                <CardContent className="p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 shrink-0 rounded-full bg-secondary flex items-center justify-center text-xl shadow-sm border border-border">
                      {icon}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium text-foreground truncate">
                        {label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {dateString} • {timeString}
                      </span>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'font-bold text-sm sm:text-base shrink min-w-0 text-right tabular-nums break-words',
                      isIncome && 'text-emerald-600 dark:text-emerald-400',
                    )}
                    data-testid="recent-activity-amount"
                  >
                    <EntryAmount
                      entry={item}
                      mainCurrency={mainCurrency}
                      sign={isIncome ? '+' : '-'}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
