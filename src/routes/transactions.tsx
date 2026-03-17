import { createFileRoute } from '@tanstack/react-router'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getTransactionsPaginated,
  deleteExpense,
  GetTransactionsPaginatedInput,
} from '../lib/transactions'
import { getUserCategories } from '../lib/categories'
import { Trash2, Edit2, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import PageShell from '@/components/PageShell'

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

  const handleCategoryFilterChange = (
    e: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    setCategoryId(e.target.value === 'all' ? null : e.target.value)
    setPageIndex(0) // Reset to first page when filtering
  }

  return (
    <PageShell>
      <div className="p-4 md:p-8 max-w-6xl mx-auto min-h-screen animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            Transactions
          </h2>

          {/* Filters */}
          <div className="flex items-center gap-2">
            <label
              htmlFor="category-filter"
              className="text-sm font-medium text-gray-600 dark:text-gray-300"
            >
              Category:
            </label>
            <select
              id="category-filter"
              value={categoryId || 'all'}
              onChange={handleCategoryFilterChange}
              className="p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 outline-none transition-shadow text-gray-900 dark:text-gray-100"
            >
              <option value="all">All Categories</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.icon} {cat.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500 dark:text-gray-400">
                  <th className="p-4 pl-6 font-semibold">Date</th>
                  <th className="p-4 font-semibold">Category</th>
                  <th className="p-4 font-semibold hidden md:table-cell">
                    Description
                  </th>
                  <th className="p-4 font-semibold text-right">Amount</th>
                  <th className="p-4 pr-6 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-gray-500">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-cyan-500" />
                    </td>
                  </tr>
                ) : isError ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-red-500">
                      Failed to load transactions.
                    </td>
                  </tr>
                ) : transactions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="p-12 text-center text-gray-500 dark:text-gray-400"
                    >
                      <div className="flex flex-col items-center justify-center space-y-3">
                        <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-full">
                          <Trash2 className="w-6 h-6 text-gray-400" />
                        </div>
                        <p>No transactions found.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx: any) => (
                    <tr
                      key={tx.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group"
                    >
                      <td className="p-4 pl-6 text-sm text-gray-600 dark:text-gray-300">
                        {new Date(tx.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="p-4 text-sm font-medium text-gray-900 dark:text-white">
                        <div className="flex items-center gap-2">
                          {tx.category ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
                              {tx.category.icon && (
                                <span>{tx.category.icon}</span>
                              )}
                              {tx.category.name}
                            </span>
                          ) : (
                            <span className="text-gray-400 italic">
                              Uncategorized
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-4 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell truncate max-w-[200px]">
                        {tx.description || '-'}
                      </td>
                      <td className="p-4 text-sm font-bold text-gray-900 dark:text-white text-right">
                        {tx.currency === 'USD' && '$'}
                        {tx.currency === 'EUR' && '€'}
                        {tx.currency === 'UAH' && '₴'}
                        {tx.amount.toFixed(2)}
                      </td>
                      <td className="p-4 pr-6 text-right">
                        <div className="flex items-center justify-end gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleEdit(tx.id)}
                            className="p-1.5 text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 rounded-md transition-colors"
                            title="Edit transaction"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(tx.id)}
                            disabled={deleteMutation.isPending}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-colors disabled:opacity-50"
                            title="Delete transaction"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {!isLoading && totalPages > 1 && (
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
                  onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                  disabled={pageIndex === 0}
                  className="p-1.5 rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Page {pageIndex + 1} of {totalPages}
                </div>
                <button
                  onClick={() =>
                    setPageIndex((p) => Math.min(totalPages - 1, p + 1))
                  }
                  disabled={pageIndex >= totalPages - 1}
                  className="p-1.5 rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}
