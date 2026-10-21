import {
  Edit2,
  Loader2,
  Repeat,
  Search,
  Trash2,
  WifiOff,
} from 'lucide-react'
import type { Category, Currency, Expense } from '@/lib/domain'
import { useT } from '@/i18n'
import { formatFullDate } from '@/i18n/format'
import { useOnlineStatus } from '@/lib/useOnlineStatus'
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
import EntryAmount from '@/components/EntryAmount'

interface TransactionsTableProps {
  transactions: Array<Expense>
  /** Unused since the inline editor moved to the drawer; kept for callers. */
  categories: Array<Category>
  isLoading: boolean
  isError: boolean
  isDeleting: boolean
  /** Amounts in other currencies show their main-currency value or "rate pending". */
  mainCurrency: Currency
  /** The row edit button: the page opens the expense drawer in edit mode. */
  onEdit: (expense: Expense) => void
  onDelete: (id: string, createdAt: string) => void
}

export function TransactionsTable({
  transactions,
  isLoading,
  isError,
  isDeleting,
  mainCurrency,
  onEdit,
  onDelete,
}: TransactionsTableProps) {
  const online = useOnlineStatus()
  const { t } = useT()

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
          <TableHead className="pl-6 font-semibold">{t('common.date')}</TableHead>
          <TableHead className="font-semibold">{t('common.category')}</TableHead>
          <TableHead className="hidden md:table-cell font-semibold">
            {t('common.description')}
          </TableHead>
          <TableHead className="text-right font-semibold">{t('common.amount')}</TableHead>
          <TableHead className="pr-6 text-right font-semibold">
            {t('common.actions')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <TableRow>
            <TableCell
              colSpan={5}
              className="p-12 text-center text-muted-foreground"
            >
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
            </TableCell>
          </TableRow>
        ) : isError ? (
          <TableRow>
            <TableCell
              colSpan={5}
              className="p-12 text-center text-muted-foreground"
            >
              {online ? (
                <span className="text-destructive">
                  {t('transactions.loadFailed')}
                </span>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <WifiOff className="h-5 w-5" />
                  {t('transactions.offline')}
                </div>
              )}
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
                  <p className="font-medium text-foreground">
                    {t('transactions.emptyTitle')}
                  </p>
                  <p className="text-sm">{t('transactions.emptyHint')}</p>
                </div>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          transactions.map((tx) => (
              <TableRow
                key={tx.id}
                data-testid="transaction-row"
                className="hover:bg-muted/30 transition-colors group"
              >
                <TableCell className="pl-6 text-sm text-muted-foreground">
                  {formatFullDate(tx.createdAt)}
                </TableCell>
                <TableCell className="text-sm font-medium">
                  {tx.category ? (
                    <Badge variant="secondary" className="gap-1.5 font-medium">
                      {tx.category.icon && <span>{tx.category.icon}</span>}
                      {tx.category.name}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground italic text-xs">
                      {t('common.uncategorized')}
                    </span>
                  )}
                  {tx.recurringId && (
                    <span
                      title={t('transactions.fromRecurring')}
                      data-testid="transaction-recurring-icon"
                      className="ml-1.5 inline-flex align-middle text-muted-foreground"
                    >
                      <Repeat size={12} />
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell text-sm text-muted-foreground truncate max-w-[240px]">
                  {tx.description || <span className="opacity-30">-</span>}
                </TableCell>
                <TableCell className="text-sm font-bold text-right tabular-nums whitespace-normal break-words">
                  <EntryAmount entry={tx} mainCurrency={mainCurrency} />
                </TableCell>
                <TableCell className="pr-6 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      data-testid="transaction-edit-button"
                      onClick={() => onEdit(tx)}
                      aria-label={t('transactions.edit')}
                      className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                      title={t('transactions.edit')}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid="transaction-delete-button"
                          disabled={isDeleting}
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          aria-label={t('transactions.delete')}
                          title={t('transactions.delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('transactions.deleteTitle')}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t('drawer.deleteDescription')}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => onDelete(tx.id, tx.createdAt)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {t('common.delete')}
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
