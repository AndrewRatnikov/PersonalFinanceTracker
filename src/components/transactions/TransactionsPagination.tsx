import { ChevronLeft, ChevronRight } from 'lucide-react'

interface TransactionsPaginationProps {
  pageIndex: number
  pageSize: number
  totalCount: number
  totalPages: number
  onPageChange: (newPageIndex: number) => void
}

export function TransactionsPagination({
  pageIndex,
  pageSize,
  totalCount,
  totalPages,
  onPageChange,
}: TransactionsPaginationProps) {
  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-between p-4 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
      <span className="text-sm text-gray-600 dark:text-gray-400">
        Showing{' '}
        <span className="font-semibold">
          {pageIndex * pageSize + 1}
        </span>{' '}
        to{' '}
        <span className="font-semibold">
          {Math.min((pageIndex + 1) * pageSize, totalCount)}
        </span>{' '}
        of <span className="font-semibold">{totalCount}</span> results
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
          disabled={pageIndex === 0}
          className="p-1.5 rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Page {pageIndex + 1} of {totalPages}
        </div>
        <button
          onClick={() => onPageChange(Math.min(totalPages - 1, pageIndex + 1))}
          disabled={pageIndex >= totalPages - 1}
          className="p-1.5 rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
