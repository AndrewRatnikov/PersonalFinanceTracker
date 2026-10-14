import dayjs from 'dayjs'
import { Pause, Pencil, Play, Trash2 } from 'lucide-react'

import type { Category, RecurringItem } from '@/lib/domain'
import {
  describeFrequency,
  formatRecurringAmount,
  nextUnhandledOccurrence,
} from '@/lib/recurrence'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface RecurringRowProps {
  item: RecurringItem
  /** The item's category (expense or income, by kind); undefined when gone. */
  category: Category | undefined
  onEdit: (item: RecurringItem) => void
  onTogglePaused: (item: RecurringItem) => void
  onDelete: (item: RecurringItem) => void
  isBusy?: boolean
}

export default function RecurringRow({
  item,
  category,
  onEdit,
  onTogglePaused,
  onDelete,
  isBusy,
}: RecurringRowProps) {
  const name = item.description || category?.name || 'Unknown category'
  const next = nextUnhandledOccurrence(item)

  return (
    <Card
      data-testid="recurring-row"
      className="border-border bg-card/40 transition-colors hover:bg-accent/30"
    >
      <CardContent className="px-3 py-3 flex items-start gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-secondary/50 text-base shadow-sm shrink-0">
          {category?.icon ?? '🔁'}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              data-testid="recurring-row-name"
              className="text-sm font-medium text-foreground truncate"
            >
              {name}
            </span>
            <span
              data-testid="recurring-row-amount"
              className={`text-sm font-semibold whitespace-nowrap ${item.kind === 'income' ? 'text-emerald-600' : 'text-foreground'}`}
            >
              {formatRecurringAmount(item.amount, item.currency)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="recurring-row-frequency">
              {describeFrequency(item)}
            </span>
            <span aria-hidden="true">·</span>
            <span data-testid="recurring-row-next">
              {next === null
                ? 'Ended'
                : `Next: ${dayjs(next).format('MMM D, YYYY')}`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge data-testid="recurring-row-mode" variant="secondary">
              {item.mode === 'auto' ? 'Auto' : 'Ask'}
            </Badge>
            {item.paused && (
              <Badge data-testid="recurring-row-paused" variant="outline">
                Paused
              </Badge>
            )}
          </div>

          {category === undefined && (
            <p
              data-testid="recurring-row-category-missing"
              className="text-xs text-destructive"
            >
              Category missing – edit to choose one
            </p>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="recurring-edit-btn"
            aria-label="Edit recurring item"
            onClick={() => onEdit(item)}
            disabled={isBusy}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-transparent"
          >
            <Pencil size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="recurring-pause-btn"
            onClick={() => onTogglePaused(item)}
            disabled={isBusy}
            className="h-8 px-2 text-muted-foreground hover:text-foreground hover:bg-transparent"
          >
            {item.paused ? <Play size={14} /> : <Pause size={14} />}
            {item.paused ? 'Resume' : 'Pause'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="recurring-delete-btn"
                aria-label="Delete recurring item"
                disabled={isBusy}
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-transparent"
              >
                <Trash2 size={14} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete recurring item</AlertDialogTitle>
                <AlertDialogDescription data-testid="recurring-delete-description">
                  Stop repeating <strong>{name}</strong>? Past transactions
                  are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="recurring-delete-confirm"
                  onClick={() => onDelete(item)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  )
}
