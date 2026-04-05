import dayjs from 'dayjs'
import { Edit2, Loader2, Trash2, Search } from 'lucide-react'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

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
        <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
          <TableHead className="pl-6 font-semibold">Date</TableHead>
          <TableHead className="font-semibold">Category</TableHead>
          <TableHead className="hidden md:table-cell font-semibold">Description</TableHead>
          <TableHead className="text-right font-semibold">Amount</TableHead>
          <TableHead className="pr-6 text-right font-semibold">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <TableRow>
            <TableCell colSpan={5} className="p-12 text-center text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
            </TableCell>
          </TableRow>
        ) : isError ? (
          <TableRow>
            <TableCell colSpan={5} className="p-12 text-center text-destructive">
              Failed to load transactions. Please try again later.
            </TableCell>
          </TableRow>
        ) : transactions.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={5}
              className="p-16 text-center text-muted-foreground"
            >
              <div className="flex flex-col items-center justify-center space-y-4">
                <div className="p-4 bg-muted rounded-full">
                  <Search className="w-8 h-8 text-muted-foreground opacity-50" />
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-foreground">No transactions found</p>
                  <p className="text-sm">Try adjusting your filters or search query.</p>
                </div>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          transactions.map((tx) => (
            <TableRow
              key={tx.id}
              className="hover:bg-muted/30 transition-colors group"
            >
              <TableCell className="pl-6 text-sm text-muted-foreground">
                {dayjs(tx.createdAt).format('MMM D, YYYY')}
              </TableCell>
              <TableCell className="text-sm font-medium">
                {tx.category ? (
                  <Badge
                    variant="secondary"
                    className="gap-1.5 font-medium"
                  >
                    {tx.category.icon && <span>{tx.category.icon}</span>}
                    {tx.category.name}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground italic text-xs">Uncategorized</span>
                )}
              </TableCell>
              <TableCell className="hidden md:table-cell text-sm text-muted-foreground truncate max-w-[240px]">
                {tx.description || <span className="opacity-30">-</span>}
              </TableCell>
              <TableCell className="text-sm font-bold text-right tabular-nums">
                {CURRENCY_SYMBOL[tx.currency] ?? tx.currency}
                {tx.amount.toFixed(2)}
              </TableCell>
              <TableCell className="pr-6 text-right">
                <div className="flex items-center justify-end gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEdit(tx.id)}
                    className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                    title="Edit transaction"
                  >
                    <Edit2 className="w-4 h-4" />
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isDeleting}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete transaction"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete this transaction from your history. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onDelete(tx.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
