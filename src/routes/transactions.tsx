import { createFileRoute } from '@tanstack/react-router'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { getAllCategories, getAllExpenses, deleteExpense } from '@/lib/localDb'
import PageShell from '@/components/PageShell'
import { CategoryFilter } from '@/components/transactions/CategoryFilter'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'
import { TransactionsPagination } from '@/components/transactions/TransactionsPagination'
import { Card } from '@/components/ui/card'

export const Route = createFileRoute('/transactions')({
  component: Transactions,
})

function Transactions() {
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 15
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })

  const { data: allExpenses = [], isLoading, isError } = useQuery({
    queryKey: ['expenses'],
    queryFn: getAllExpenses,
  })

  const filtered = useMemo(() => {
    if (!categoryId) return allExpenses
    return allExpenses.filter((e) => e.categoryId === categoryId)
  }, [allExpenses, categoryId])

  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / pageSize)
  const transactions = useMemo(
    () => filtered.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [filtered, pageIndex, pageSize],
  )

  const deleteMutation = useMutation({
    mutationFn: ({ id, createdAt }: { id: string; createdAt: string }) =>
      deleteExpense(id, createdAt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Transaction deleted')
    },
    onError: (error: any) => {
      toast.error(`Failed to delete: ${error.message}`)
    },
  })

  const handleDelete = (id: string, createdAt: string) => {
    deleteMutation.mutate({ id, createdAt })
  }

  const handleEdit = (id: string) => {
    toast.info(`Edit mode for transaction ${id} coming soon!`)
  }

  const handleCategoryFilterChange = (value: string) => {
    setCategoryId(value === 'all' ? null : value)
    setPageIndex(0)
  }

  return (
    <PageShell>
      <div className="p-4 md:p-8 max-w-6xl mx-auto min-h-screen animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
          <div className="space-y-1">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              Transactions
            </h2>
            <p className="text-muted-foreground">
              Manage and review your recent spending history.
            </p>
          </div>

          <CategoryFilter
            categories={categories}
            value={categoryId}
            onChange={handleCategoryFilterChange}
          />
        </div>

        <Card className="overflow-hidden border shadow-sm">
          <TransactionsTable
            transactions={transactions}
            isLoading={isLoading}
            isError={isError}
            isDeleting={deleteMutation.isPending}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />

          {!isLoading && !isError && transactions.length > 0 && (
            <TransactionsPagination
              pageIndex={pageIndex}
              pageSize={pageSize}
              totalCount={totalCount}
              totalPages={totalPages}
              onPageChange={setPageIndex}
            />
          )}
        </Card>
      </div>
    </PageShell>
  )
}
