import dayjs from 'dayjs'

import type { RecentItem } from '@/lib/dashboardSummary'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface RecentActivityListProps {
  items: Array<RecentItem>
}

export default function RecentActivityList({ items }: RecentActivityListProps) {
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
            const icon = isIncome ? '💰' : item.category?.icon || '🏷️'
            const label = isIncome
              ? item.source
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
                      'font-bold text-lg shrink-0 tabular-nums',
                      isIncome && 'text-emerald-600 dark:text-emerald-400',
                    )}
                    data-testid="recent-activity-amount"
                  >
                    {isIncome ? '+' : '-'}
                    {item.amount.toLocaleString()}{' '}
                    <span className="text-xs text-muted-foreground font-normal ml-1">
                      {item.currency}
                    </span>
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
