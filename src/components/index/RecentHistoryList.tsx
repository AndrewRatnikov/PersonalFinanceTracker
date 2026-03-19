import dayjs from 'dayjs'

import type { Expense } from '../../lib/domain'

interface RecentHistoryListProps {
  expenses: Array<Expense>
}

export default function RecentHistoryList({
  expenses,
}: RecentHistoryListProps) {
  if (expenses.length === 0) {
    return (
      <div className="text-center text-slate-400 py-8 bg-slate-800/40 rounded-2xl border border-slate-700/30">
        No recent expenses found.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-bold text-slate-300 mb-1 tracking-wide">
        Recent History
      </h3>
      {expenses.map((expense) => {
        const date = dayjs(expense.createdAt)
        const timeString = date.format('hh:mm A')
        const dateString = date.format('MMM D')

        return (
          <div
            key={expense.id}
            className="flex items-center justify-between p-4 bg-slate-800/40 rounded-xl border border-slate-700/30 hover:border-slate-600 transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-xl shadow-inner">
                {expense.category?.icon || '🏷️'}
              </div>
              <div className="flex flex-col">
                <span className="font-semibold text-white">
                  {expense.category?.name || 'Uncategorized'}
                </span>
                <span className="text-sm text-slate-400">
                  {dateString} • {timeString}
                </span>
              </div>
            </div>
            <div className="font-bold text-white text-lg">
              -{expense.amount}{' '}
              <span className="text-xs text-slate-400 font-normal ml-1">
                {expense.currency}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
