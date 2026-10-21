import { Loader2, Repeat, Search, Trash2 } from 'lucide-react'

import type { Currency, IncomeEntry } from '@/lib/domain'
import { useT } from '@/i18n'
import { formatFullDate } from '@/i18n/format'
import { incomeSourceLabel } from '@/lib/incomeCategories'
import EntryAmount from '@/components/EntryAmount'

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
  /** Amounts in other currencies show their main-currency value or "rate pending". */
  mainCurrency: Currency
  onDelete: (id: string) => void
}

export function IncomeTable({
  income,
  isLoading,
  isError,
  isDeleting,
  mainCurrency,
  onDelete,
}: IncomeTableProps) {
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
              className="p-12 text-center text-destructive"
            >
              {t('income.loadFailed')}
            </TableCell>
          </TableRow>
        ) : income.length === 0 ? (
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
                  <p className="font-medium text-foreground">{t('income.emptyTitle')}</p>
                  <p className="text-sm">{t('income.emptyHint')}</p>
                </div>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          income.map((entry) => (
            <TableRow
              key={entry.id}
              data-testid="income-row"
              className="hover:bg-muted/30 transition-colors group"
            >
              <TableCell className="pl-6 text-sm text-muted-foreground">
                {formatFullDate(entry.createdAt)}
              </TableCell>
              <TableCell
                data-testid="income-row-category"
                className="text-sm font-medium"
              >
                {entry.category?.icon && (
                  <span className="mr-1.5">{entry.category.icon}</span>
                )}
                <span>{incomeSourceLabel(entry)}</span>
                {entry.recurringId && (
                  <span
                    title={t('transactions.fromRecurring')}
                    data-testid="income-recurring-icon"
                    className="ml-1.5 inline-flex align-middle text-muted-foreground"
                  >
                    <Repeat size={12} />
                  </span>
                )}
              </TableCell>
              <TableCell className="hidden md:table-cell text-sm text-muted-foreground truncate max-w-[240px]">
                {entry.description || <span className="opacity-30">-</span>}
              </TableCell>
              <TableCell className="text-sm font-bold text-right tabular-nums whitespace-normal break-words">
                <EntryAmount entry={entry} mainCurrency={mainCurrency} />
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
                        aria-label={t('income.delete')}
                        title={t('income.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('transactions.deleteTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('income.deleteDescription')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onDelete(entry.id)}
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
