import {
  ArrowRightLeft,
  Edit2,
  Loader2,
  Repeat,
  Search,
  Trash2,
  WifiOff,
} from 'lucide-react'
import type { Category, Currency, Expense } from '@/lib/domain'
import type { MemberDirectory } from '@/lib/memberStats'
import { useT } from '@/i18n'
import { formatFullDate } from '@/i18n/format'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { useSpaceAccess } from '@/lib/spaces/switcher'
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
import { MemberChip } from '@/components/members/MemberChip'

interface TransactionsTableProps {
  transactions: Array<Expense>
  /** Unused since the inline editor moved to the drawer; kept for callers. */
  categories?: Array<Category>
  isLoading?: boolean
  isError?: boolean
  isDeleting?: boolean
  /** Amounts in other currencies show their main-currency value or "rate pending". */
  mainCurrency?: Currency
  /** The row edit button: the page opens the expense drawer in edit mode. */
  onEdit: (expense: Expense) => void
  onDelete: (id: string, createdAt: string) => void
  /** Family only: a member chip per row with a payer. */
  members?: MemberDirectory
  /** Row selection for a bulk move (only while a Family is held). */
  selection?: {
    selected: ReadonlySet<string>
    onToggle: (id: string) => void
    onToggleAll: () => void
  }
  /** Per-row "Move to Family / Personal" action. */
  onMove?: (expense: Expense) => void
  moveLabel?: string
  moveDisabled?: boolean
  /** A read-only Family copy: edit, delete, select and move are disabled. */
  readOnly?: boolean
}

export function TransactionsTable({
  transactions,
  isLoading = false,
  isError = false,
  isDeleting = false,
  mainCurrency = DEFAULT_MAIN_CURRENCY,
  onEdit,
  onDelete,
  members,
  selection,
  onMove,
  moveLabel,
  moveDisabled = false,
  readOnly: readOnlyProp = false,
}: TransactionsTableProps) {
  const online = useOnlineStatus()
  const { t } = useT()
  const access = useSpaceAccess()
  const readOnly = readOnlyProp || access.readOnly
  const columns = selection ? 6 : 5
  const allSelected =
    selection !== undefined &&
    transactions.length > 0 &&
    transactions.every((tx) => selection.selected.has(tx.id))
  const moveText = moveLabel ?? t('move.toFamily')

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
          {selection && (
            <TableHead className="w-12 pl-3 pr-0">
              <label className="inline-flex size-11 items-center justify-center sm:size-auto">
                <input
                  type="checkbox"
                  data-testid="transactions-select-all"
                  aria-label={t('move.selectAll')}
                  checked={allSelected}
                  disabled={readOnly || transactions.length === 0}
                  onChange={() => selection.onToggleAll()}
                  className="h-4 w-4"
                />
              </label>
            </TableHead>
          )}
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
              colSpan={columns}
              className="p-12 text-center text-muted-foreground"
            >
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
            </TableCell>
          </TableRow>
        ) : isError ? (
          <TableRow>
            <TableCell
              colSpan={columns}
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
              colSpan={columns}
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
                {selection && (
                  <TableCell className="w-12 pl-3 pr-0">
                    <label className="inline-flex size-11 items-center justify-center sm:size-auto">
                      <input
                        type="checkbox"
                        data-testid="transaction-select"
                        aria-label={t('move.selectRow')}
                        checked={selection.selected.has(tx.id)}
                        disabled={readOnly}
                        onChange={() => selection.onToggle(tx.id)}
                        className="h-4 w-4"
                      />
                    </label>
                  </TableCell>
                )}
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
                  {members && tx.paidBy !== undefined && (
                    <span className="ml-1.5 inline-flex align-middle">
                      <MemberChip memberId={tx.paidBy} directory={members} />
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
                      disabled={readOnly}
                      aria-label={t('transactions.edit')}
                      className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                      title={t('transactions.edit')}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>

                    {onMove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid="transaction-move-button"
                        disabled={readOnly || moveDisabled}
                        onClick={() => onMove(tx)}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted"
                        aria-label={moveText}
                        title={moveText}
                      >
                        <ArrowRightLeft className="w-4 h-4" />
                      </Button>
                    )}

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid="transaction-delete-button"
                          disabled={isDeleting || readOnly}
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
