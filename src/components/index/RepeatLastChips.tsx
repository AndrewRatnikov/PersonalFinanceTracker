import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { Category, Expense } from '@/lib/domain'
import type { ExpenseDrawerInitial } from '@/lib/expenseDraft'
import type { RepeatCandidate } from '@/lib/repeatLast'
import { useT } from '@/i18n'
import { useSpaceDb } from '@/lib/spaces/react'
import { useSpaceAccess } from '@/lib/spaces/switcher'
import {
  repeatLastCandidates,
  repeatLastLabel,
  repeatLastText,
} from '@/lib/repeatLast'

/** Holding a chip this long opens the drawer instead of adding. */
export const LONG_PRESS_MS = 500

const UNDO_MS = 5000

interface RepeatLastChipsProps {
  expenses: ReadonlyArray<Expense>
  categories: Array<Category>
  /** Opens the expense drawer prefilled with the candidate. */
  onCustomize: (initial: ExpenseDrawerInitial) => void
}

function initialFor(c: RepeatCandidate): ExpenseDrawerInitial {
  const initial: ExpenseDrawerInitial = {
    categoryId: c.categoryId,
    amount: String(c.amount),
    currency: c.currency,
  }
  if (c.description) initial.description = c.description
  return initial
}

// Up to 3 one-tap chips for the most recent distinct expenses (dashboard,
// above Quick Add). A tap adds the expense today with a 5 s Undo; a long press
// or the "…" button opens the drawer prefilled instead.
export function RepeatLastChips({
  expenses,
  categories,
  onCustomize,
}: RepeatLastChipsProps) {
  const queryClient = useQueryClient()
  const db = useSpaceDb()
  const { t } = useT()
  // A read-only Family copy can be browsed but not added to.
  const { readOnly } = useSpaceAccess()
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set when a long press fired, so the click that follows doesn't add.
  const longPressed = useRef(false)

  const items = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    return repeatLastCandidates(expenses).flatMap((candidate) => {
      const category = byId.get(candidate.categoryId)
      return category ? [{ candidate, category }] : []
    })
  }, [expenses, categories])

  useEffect(
    () => () => {
      if (pressTimer.current !== null) clearTimeout(pressTimer.current)
    },
    [],
  )

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['expenses'] })
    void queryClient.invalidateQueries({ queryKey: ['analytics'] })
  }

  const undo = async (saved: Expense) => {
    try {
      await db.deleteExpense(saved.id, saved.createdAt)
      invalidate()
      toast.success(t('toasts.removed'))
    } catch {
      toast.error(t('toasts.expenseRemoveFailed'))
    }
  }

  const add = async (candidate: RepeatCandidate, category: Category) => {
    try {
      // No createdAt: the store dates it now (today).
      const saved = await db.addExpense({
        amount: candidate.amount,
        currency: candidate.currency,
        categoryId: candidate.categoryId,
        description: candidate.description || undefined,
      })
      invalidate()
      toast.success(t('toasts.addedItem', { item: repeatLastText(candidate, category) }), {
        duration: UNDO_MS,
        action: {
          label: t('toasts.undo'),
          onClick: () => {
            void undo(saved)
          },
        },
      })
    } catch {
      toast.error(t('toasts.expenseAddFailed'))
    }
  }

  const clearPress = () => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  const startPress = (candidate: RepeatCandidate) => {
    clearPress()
    longPressed.current = false
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      longPressed.current = true
      onCustomize(initialFor(candidate))
    }, LONG_PRESS_MS)
  }

  if (items.length === 0) return null

  return (
    <div
      role="group"
      aria-label={t('dashboard.repeatLast')}
      data-testid="repeat-last-row"
      className="flex flex-wrap gap-2"
    >
      {items.map(({ candidate, category }) => (
        <div
          key={candidate.key}
          className="inline-flex items-stretch overflow-hidden rounded-full border border-border bg-background text-foreground"
        >
          <button
            type="button"
            data-testid="repeat-last-chip"
            disabled={readOnly}
            onClick={() => {
              if (longPressed.current) {
                longPressed.current = false
                return
              }
              void add(candidate, category)
            }}
            onPointerDown={() => startPress(candidate)}
            onPointerUp={clearPress}
            onPointerLeave={clearPress}
            onPointerCancel={clearPress}
            onContextMenu={(e) => e.preventDefault()}
            className="min-h-11 px-3 text-sm font-medium select-none hover:bg-muted disabled:opacity-50 sm:min-h-9"
          >
            {repeatLastLabel(candidate, category)}
          </button>
          <button
            type="button"
            data-testid="repeat-last-more"
            aria-label={t('dashboard.editBeforeAdding', {
              item: repeatLastText(candidate, category),
            })}
            disabled={readOnly}
            onClick={() => onCustomize(initialFor(candidate))}
            className="min-h-11 min-w-11 border-l border-border px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 sm:min-h-9 sm:min-w-9"
          >
            …
          </button>
        </div>
      ))}
    </div>
  )
}
