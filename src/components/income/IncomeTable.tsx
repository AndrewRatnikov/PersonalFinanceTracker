import dayjs from 'dayjs'
import { Loader2, Search, Trash2 } from 'lucide-react'

import type { IncomeEntry } from '@/lib/domain'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
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

interface IncomeTableProps {
  income: Array<IncomeEntry>
  isLoading: boolean
  isError: boolean
  isDeleting: boolean
  onDelete: (id: string) => void
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  UAH: '₴',
}

export function IncomeTable({
  income,
  isLoading,
  isError,
  isDeleting,
  onDelete,
}: IncomeTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
          <TableHead className="pl-6 font-semibold">Date</TableHead>
          <TableHead className="font-semibold">Source</TableHead>
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
              Failed to load income. Please try again later.
            </TableCell>
          </TableRow>
        ) : income.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="p-16 text-center text-muted-foreground">
              <div className="flex flex-col items-center justify-center space-y-4">
                <div className="p-4 bg-muted rounded-full">
                  <Search className="w-8 h-8 text-muted-foreground opacity-50" />
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-foreground">No income recorded yet</p>
                  <p className="text-sm">Add your first income entry using the form.</p>
                </div>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          income.map((entry) => (
            <TableRow
              key={entry.id}
              className="hover:bg-muted/30 transition-colors group"
            >
              <TableCell className="pl-6 text-sm text-muted-foreground">
                {dayjs(entry.createdAt).format('MMM D, YYYY')}
              </TableCell>
              <TableCell className="text-sm font-medium">
                {entry.source}
              </TableCell>
              <TableCell className="hidden md:table-cell text-sm text-muted-foreground truncate max-w-[240px]">
                {entry.description || <span className="opacity-30">-</span>}
              </TableCell>
              <TableCell className="text-sm font-bold text-right tabular-nums">
                {CURRENCY_SYMBOL[entry.currency] ?? entry.currency}
                {entry.amount.toFixed(2)}
              </TableCell>
              <TableCell className="pr-6 text-right">
                <div className="flex items-center justify-end opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isDeleting}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete income"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete this income entry. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onDelete(entry.id)}
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
