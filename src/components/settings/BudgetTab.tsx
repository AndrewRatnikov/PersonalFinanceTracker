import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { BudgetEntry, Category, Currency, Expense } from '@/lib/domain'
import type { MemberDirectory } from '@/lib/memberStats'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { currencyLabel, formatMoney } from '@/i18n/format'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { memberLabel, memberTotals } from '@/lib/memberStats'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { useCurrencySettings } from '@/lib/useCurrencySettings'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { Card, CardContent } from '@/components/ui/card'
import { QueryErrorState } from '@/components/QueryErrorState'
import { SpaceSettingsHeader } from '@/components/space/SpaceSettingsHeader'

interface BudgetRowProps {
  category: Category
  existingBudget:
    | (BudgetEntry & { categoryName: string; categoryIcon: string | null })
    | undefined
  // Budgets are always saved in the main currency.
  mainCurrency: Currency
  settingsReady: boolean
  /** A read-only Family copy: the limit can't be changed. */
  readOnly: boolean
  /** Family only: this month's expenses of this category, for the breakdown. */
  members?: { directory: MemberDirectory; expenses: ReadonlyArray<Expense> }
}

// "By member": what each payer spent this month in the category (Family).
function BudgetMemberBreakdown({
  categoryId,
  directory,
  expenses,
  mainCurrency,
}: {
  categoryId: string
  directory: MemberDirectory
  expenses: ReadonlyArray<Expense>
  mainCurrency: Currency
}) {
  const { t } = useT()
  const { rows } = memberTotals(expenses, mainCurrency)
  if (rows.length === 0) return null
  return (
    <details
      data-testid={`budget-row-members-${categoryId}`}
      className="px-3 pb-2.5 text-xs text-muted-foreground"
    >
      <summary className="cursor-pointer select-none py-1">{t('members.byMember')}</summary>
      <ul className="flex flex-col gap-1 pt-1">
        {rows.map((row) => (
          <li
            key={row.memberId}
            data-testid={`budget-member-${categoryId}-${row.memberId}`}
            className="flex justify-between gap-3"
          >
            {`${memberLabel(directory, row.memberId)} ${formatMoney(row.total, mainCurrency)}`}
          </li>
        ))}
      </ul>
    </details>
  )
}

function BudgetRow({
  category,
  existingBudget,
  mainCurrency,
  settingsReady,
  readOnly,
  members,
}: BudgetRowProps) {
  const queryClient = useQueryClient()
  const db = useSpaceDb()
  const { t } = useT()
  const [limit, setLimit] = useState(
    existingBudget ? String(existingBudget.monthlyLimit) : '',
  )

  const saveMutation = useMutation({
    mutationFn: () =>
      db.upsertBudget({
        categoryId: category.id,
        monthlyLimit: Number(limit),
        currency: mainCurrency,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success(t('toasts.budgetSaved'))
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.budgetSaveFailed', { error: errorMessage(error) }))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => db.deleteBudget(existingBudget!.id),
    onSuccess: () => {
      setLimit('')
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success(t('toasts.budgetRemoved'))
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.budgetRemoveFailed', { error: errorMessage(error) }))
    },
  })

  const isPending = saveMutation.isPending || deleteMutation.isPending
  const canSave =
    settingsReady && limit.trim() !== '' && Number(limit) > 0 && !isPending && !readOnly
  // A budget saved in another currency waits for the one-time conversion.
  const storedElsewhere =
    existingBudget !== undefined && existingBudget.currency !== mainCurrency

  return (
    <Card className="border-border bg-card/40">
      <CardContent className="px-3 py-2.5 flex items-center gap-3">
        {category.icon && (
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary/50 text-base shadow-sm flex-shrink-0">
            {category.icon}
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-sm font-medium text-foreground truncate">
            {category.name}
          </span>
          {storedElsewhere && (
            <span className="text-xs text-muted-foreground">
              {t('settings.budget.savedElsewhere', {
                from: existingBudget.currency,
                to: mainCurrency,
              })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            placeholder={t('settings.budget.limit')}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={isPending || readOnly}
            className="w-28 h-8 text-sm"
          />
          <span
            data-testid="budget-row-currency"
            className="w-10 text-xs font-medium text-muted-foreground"
          >
            {currencyLabel(mainCurrency)}
          </span>

          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!canSave}
            className="h-8 px-3 text-xs"
          >
            {saveMutation.isPending ? t('common.saving') : t('common.save')}
          </Button>

          {existingBudget && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={isPending || readOnly}
                  className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-transparent transition-colors"
                  aria-label={t('settings.budget.remove')}
                >
                  <Trash2 size={14} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('settings.budget.removeTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('settings.budget.removeQuestion', { name: category.name })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t('settings.budget.removeConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
      {members && (
        <BudgetMemberBreakdown
          categoryId={category.id}
          directory={members.directory}
          expenses={members.expenses}
          mainCurrency={mainCurrency}
        />
      )}
    </Card>
  )
}

interface BudgetTabProps {
  categories: Array<Category>
}

export function BudgetTab({ categories }: BudgetTabProps) {
  const { t } = useT()
  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  const budgetsQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'budgets'),
    queryFn: () => db.getAllBudgets(),
  })
  const budgets = budgetsQuery.data ?? []
  const settingsQuery = useCurrencySettings()
  const mainCurrency = settingsQuery.data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY
  const settingsReady = settingsQuery.data !== undefined
  const { isFamily, readOnly, directory } = useSpaceSwitch()

  // Family: this month's expenses, for the per-member breakdown of each row.
  const showMembers = isFamily && directory !== null
  const monthKey = dayjs().format('YYYY-MM')
  const { monthStart, monthEnd } = useMemo(
    () => ({
      monthStart: dayjs(`${monthKey}-01`).startOf('month').toISOString(),
      monthEnd: dayjs(`${monthKey}-01`).endOf('month').toISOString(),
    }),
    [monthKey],
  )
  const monthExpensesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'expenses', monthStart, monthEnd),
    queryFn: () => db.getExpensesForRange(monthStart, monthEnd),
    enabled: showMembers,
  })
  const expensesByCategory = useMemo(() => {
    const map = new Map<string, Array<Expense>>()
    for (const e of monthExpensesQuery.data ?? []) {
      const list = map.get(e.categoryId)
      if (list) list.push(e)
      else map.set(e.categoryId, [e])
    }
    return map
  }, [monthExpensesQuery.data])

  const budgetMap = new Map(budgets.map((b) => [b.categoryId, b]))

  // Never show empty limits for budgets that failed to load.
  if (budgetsQuery.isError) {
    return <QueryErrorState onRetry={() => void budgetsQuery.refetch()} />
  }

  if (budgetsQuery.isLoading) {
    return (
      <p className="text-muted-foreground text-sm text-center py-10 italic">
        {t('settings.budget.loading')}
      </p>
    )
  }

  if (categories.length === 0) {
    return (
      <p
        data-testid="budget-tab"
        className="text-muted-foreground text-sm text-center py-10 italic"
      >
        {t('settings.budget.noCategories')}
      </p>
    )
  }

  return (
    <div data-testid="budget-tab" className="flex flex-col gap-3">
      <SpaceSettingsHeader />
      {categories.map((cat) => (
        <BudgetRow
          key={`${cat.id}-${budgetMap.get(cat.id)?.id ?? 'new'}`}
          category={cat}
          existingBudget={budgetMap.get(cat.id)}
          mainCurrency={mainCurrency}
          settingsReady={settingsReady}
          readOnly={readOnly}
          members={
            showMembers
              ? { directory, expenses: expensesByCategory.get(cat.id) ?? [] }
              : undefined
          }
        />
      ))}
    </div>
  )
}
