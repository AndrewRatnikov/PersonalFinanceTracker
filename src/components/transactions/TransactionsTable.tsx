import dayjs from 'dayjs'
import { Edit2, Loader2, Trash2 } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface TransactionsTableProps {
  transactions: Array<any>
  isLoading: boolean
  isError: boolean
  isDeleting: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  UAH: '₴',
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
    <Table>
      <TableHeader>
        <TableRow className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900/50">
          <TableHead className="pl-6 text-gray-500 dark:text-gray-400 font-semibold">Date</TableHead>
          <TableHead className="text-gray-500 dark:text-gray-400 font-semibold">Category</TableHead>
          <TableHead className="hidden md:table-cell text-gray-500 dark:text-gray-400 font-semibold">Description</TableHead>
          <TableHead className="text-right text-gray-500 dark:text-gray-400 font-semibold">Amount</TableHead>
          <TableHead className="pr-6 text-right text-gray-500 dark:text-gray-400 font-semibold">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <TableRow>
            <TableCell colSpan={5} className="p-8 text-center text-gray-500">
              <Loader2 className="w-6 h-6 animate-spin mx-auto text-cyan-500" />
            </TableCell>
          </TableRow>
        ) : isError ? (
          <TableRow>
            <TableCell colSpan={5} className="p-8 text-center text-red-500">
              Failed to load transactions.
            </TableCell>
          </TableRow>
        ) : transactions.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={5}
              className="p-12 text-center text-gray-500 dark:text-gray-400"
            >
              <div className="flex flex-col items-center justify-center space-y-3">
                <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-full">
                  <Trash2 className="w-6 h-6 text-gray-400" />
                </div>
                <p>No transactions found.</p>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          transactions.map((tx) => (
            <TableRow
              key={tx.id}
              className="hover:bg-gray-50 dark:hover:bg-gray-700/50 group"
            >
              <TableCell className="pl-6 text-sm text-gray-600 dark:text-gray-300">
                {dayjs(tx.createdAt).format('MMM D, YYYY')}
              </TableCell>
              <TableCell className="text-sm font-medium text-gray-900 dark:text-white">
                {tx.category ? (
                  <Badge
                    variant="secondary"
                    className="gap-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    {tx.category.icon && <span>{tx.category.icon}</span>}
                    {tx.category.name}
                  </Badge>
                ) : (
                  <span className="text-gray-400 italic">Uncategorized</span>
                )}
              </TableCell>
              <TableCell className="hidden md:table-cell text-sm text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
                {tx.description || '-'}
              </TableCell>
              <TableCell className="text-sm font-bold text-gray-900 dark:text-white text-right">
                {CURRENCY_SYMBOL[tx.currency] ?? tx.currency}
                {tx.amount.toFixed(2)}
              </TableCell>
              <TableCell className="pr-6 text-right">
                <div className="flex items-center justify-end gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEdit(tx.id)}
                    className="h-8 w-8 text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-900/30"
                    title="Edit transaction"
                  >
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(tx.id)}
                    disabled={isDeleting}
                    className="h-8 w-8 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                    title="Delete transaction"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
