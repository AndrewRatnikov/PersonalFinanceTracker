import { createFileRoute } from '@tanstack/react-router'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getTransactionsPaginated,
  deleteExpense,
  GetTransactionsPaginatedInput,
} from '@/lib/transactions'
import { getUserCategories } from '@/lib/categories'
import { toast } from 'sonner'
import PageShell from '@/components/PageShell'
import { CategoryFilter } from '@/components/transactions/CategoryFilter'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'
import { TransactionsPagination } from '@/components/transactions/TransactionsPagination'

export const Route = createFileRoute('/transactions')({
  component: Transactions,
})

function Transactions() {
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 15
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // Fetch Categories for Filter
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => getUserCategories(),
  })

  // Fetch Transactions
  const queryInput: GetTransactionsPaginatedInput = useMemo(
    () => ({
      pageIndex,
      pageSize,
      categoryId,
      dateRange: null, // Date range filter can be added later
    }),
    [pageIndex, pageSize, categoryId],
  )

  const { data, isLoading, isError } = useQuery({
    queryKey: ['transactions', queryInput],
    queryFn: () => getTransactionsPaginated({ data: queryInput }),
  })

  const transactions = data?.transactions || []
  const totalCount = data?.totalCount || 0
  const totalPages = Math.ceil(totalCount / pageSize)

  // Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteExpense({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
      queryClient.invalidateQueries({ queryKey: ['recentExpenses'] })
      toast.success('Transaction deleted')
    },
    onError: (error: any) => {
      toast.error(`Failed to delete: ${error.message}`)
      console.error('Delete error', error)
    },
  })

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this transaction?')) {
      deleteMutation.mutate(id)
    }
  }

  const handleEdit = (id: string) => {
    // Edit functionality will be implemented soon
    alert(`Edit mode for transaction ${id} coming soon!`)
  }

  const handleCategoryFilterChange = (value: string) => {
    setCategoryId(value === 'all' ? null : value)
    setPageIndex(0) // Reset to first page when filtering
  }

  return (
    <PageShell>
      <div className="p-4 md:p-8 max-w-6xl mx-auto min-h-screen animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            Transactions
          </h2>

          <CategoryFilter
            categories={categories}
            value={categoryId}
            onChange={handleCategoryFilterChange}
          />
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 overflow-hidden mb-6">
          <TransactionsTable
            transactions={transactions}
            isLoading={isLoading}
            isError={isError}
            isDeleting={deleteMutation.isPending}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />

          {!isLoading && (
            <TransactionsPagination
              pageIndex={pageIndex}
              pageSize={pageSize}
              totalCount={totalCount}
              totalPages={totalPages}
              onPageChange={setPageIndex}
            />
          )}
        </div>
      </div>
    </PageShell>
  )
}
