import { Loader2, Trash2, Edit2 } from 'lucide-react'

interface TransactionsTableProps {
  transactions: any[]
  isLoading: boolean
  isError: boolean
  isDeleting: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function TransactionsTable({
  transactions,
  isLoading,
  isError,
  isDeleting,
  onEdit,
  onDelete,
}: TransactionsTableProps) {
  return (
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
            transactions.map((tx) => (
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
                      onClick={() => onEdit(tx.id)}
                      className="p-1.5 text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 rounded-md transition-colors"
                      title="Edit transaction"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onDelete(tx.id)}
                      disabled={isDeleting}
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
  )
}
