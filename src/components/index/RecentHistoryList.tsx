import dayjs from 'dayjs'
import { Card, CardContent } from '@/components/ui/card'
import type { Expense } from '@/lib/domain'

interface RecentHistoryListProps {
  expenses: Array<Expense>
}

export default function RecentHistoryList({
  expenses,
}: RecentHistoryListProps) {
  if (expenses.length === 0) {
    return (
      <Card className="border-dashed bg-transparent">
        <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
          No recent data found.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold tracking-tight">
        Recent History
      </h3>
      <div className="grid gap-3">
        {expenses.map((expense) => {
          const date = dayjs(expense.createdAt)
          const timeString = date.format('hh:mm A')
          const dateString = date.format('MMM D')

          return (
            <Card key={expense.id} className="overflow-hidden transition-colors hover:bg-accent/50 group">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-xl shadow-sm border border-border">
                    {expense.category?.icon || '🏷️'}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">
                      {expense.category?.name || 'Uncategorized'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {dateString} • {timeString}
                    </span>
                  </div>
                </div>
                <div className="font-bold text-lg">
                  -{expense.amount}{' '}
                  <span className="text-xs text-muted-foreground font-normal ml-1">
                    {expense.currency}
                  </span>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
