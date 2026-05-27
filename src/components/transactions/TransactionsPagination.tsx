import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'

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

  const isPrevDisabled = pageIndex === 0
  const isNextDisabled = pageIndex >= totalPages - 1

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

      <Pagination className="w-auto mx-0">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (!isPrevDisabled) onPageChange(pageIndex - 1)
              }}
              aria-disabled={isPrevDisabled}
              className={isPrevDisabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
            />
          </PaginationItem>
          <PaginationItem>
            <span className="text-sm font-medium px-3 tabular-nums">
              {pageIndex + 1} / {totalPages}
            </span>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (!isNextDisabled) onPageChange(pageIndex + 1)
              }}
              aria-disabled={isNextDisabled}
              className={isNextDisabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
