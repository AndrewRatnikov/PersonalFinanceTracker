import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
    <div className="flex items-center justify-between p-4 border-t bg-muted/20">
      <span className="text-sm text-muted-foreground">
        Showing{' '}
        <span className="font-medium text-foreground">
          {pageIndex * pageSize + 1}
        </span>{' '}
        to{' '}
        <span className="font-medium text-foreground">
          {Math.min((pageIndex + 1) * pageSize, totalCount)}
        </span>{' '}
        of <span className="font-medium text-foreground">{totalCount}</span> results
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
          disabled={pageIndex === 0}
          className="h-8 w-8"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="text-sm font-medium">
          Page {pageIndex + 1} of {totalPages}
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(Math.min(totalPages - 1, pageIndex + 1))}
          disabled={pageIndex >= totalPages - 1}
          className="h-8 w-8"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}
