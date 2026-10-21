import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import dayjs from 'dayjs'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type * as React from 'react'

import type {
  Category,
  CreateExpenseInput,
  Currency,
  Expense,
  QuickRepeat,
  UpdateExpenseInput,
} from '@/lib/domain'
import type { ExpenseDrawerInitial } from '@/lib/expenseDraft'
import type { DescriptionSuggestion } from '@/lib/suggestions'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { errorMessage, validationMessage } from '@/i18n/errors'
import { formatAmount, formatDay } from '@/i18n/format'
import { currencyForCategory } from '@/lib/categoryCurrency'
import {
  buildCreatedAt,
  createdAtForDate,
  parseDraftAmount,
} from '@/lib/expenseDraft'
import {
  addExpense,
  addRepeatingExpense,
  deleteExpense,
  updateExpense,
} from '@/lib/localDb'
import { formatMoney } from '@/lib/money'
import { createExpenseSchema, updateExpenseSchema } from '@/lib/schemas'
import { cn } from '@/lib/utils'
import { CurrencyPicker } from '@/components/CurrencyPicker'
import { DescriptionSuggestInput } from '@/components/DescriptionSuggestInput'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

export interface ExpenseDrawerProps {
  mode: 'add' | 'edit'
  /** The record being edited (edit mode). */
  expense?: Expense
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill values for add mode. */
  initial?: ExpenseDrawerInitial
  categories: Array<Category>
  mainCurrency: Currency
  /** Expenses the description suggestions are computed from. */
  entries: ReadonlyArray<Expense>
}

// ── Layout: bottom sheet below `sm`, right sheet from `sm` up ────────────────

const SM_QUERY = '(min-width: 640px)'

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function subscribeSm(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {}
  const mql = window.matchMedia(SM_QUERY)
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }
  // Safari < 14.
  mql.addListener(onChange)
  return () => mql.removeListener(onChange)
}

function getSmSnapshot(): boolean {
  return hasMatchMedia() && window.matchMedia(SM_QUERY).matches
}

function getSmServerSnapshot(): boolean {
  return false
}

function useIsSm(): boolean {
  return useSyncExternalStore(subscribeSm, getSmSnapshot, getSmServerSnapshot)
}

// An open suggestion list owns Escape: it closes the list, not the drawer.
function isOpenCombobox(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.getAttribute('role') === 'combobox' &&
    target.getAttribute('aria-expanded') === 'true'
  )
}

/**
 * One drawer for adding and editing an expense. The form state lives in an
 * inner component inside SheetContent, so it starts fresh each time the
 * drawer opens.
 */
export function ExpenseDrawer(props: ExpenseDrawerProps) {
  const { mode, open, onOpenChange } = props
  const isSm = useIsSm()
  const amountRef = useRef<HTMLInputElement>(null)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isSm ? 'right' : 'bottom'}
        data-testid="expense-drawer"
        data-mode={mode}
        className={cn(
          'gap-0 p-0',
          'data-[side=bottom]:max-h-[90dvh] data-[side=bottom]:rounded-t-xl',
          'data-[side=right]:w-full data-[side=right]:sm:max-w-md',
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          amountRef.current?.focus()
        }}
        onEscapeKeyDown={(e) => {
          if (isOpenCombobox(e.target) || isOpenCombobox(document.activeElement)) {
            e.preventDefault()
          }
        }}
      >
        <ExpenseDrawerForm {...props} amountRef={amountRef} />
      </SheetContent>
    </Sheet>
  )
}

// ── The form ─────────────────────────────────────────────────────────────────

type ErrorField = 'amount' | 'categoryId' | 'createdAt'

const LABEL_CLASS =
  'text-xs font-medium text-muted-foreground uppercase tracking-wider'

const SELECT_CLASS =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-10'

const REPEAT_OPTIONS: ReadonlyArray<{ value: QuickRepeat; label: MessageKey }> = [
  { value: 'none', label: 'common.repeat.none' },
  { value: 'week', label: 'common.repeat.week' },
  { value: 'month', label: 'common.repeat.month' },
  { value: 'year', label: 'common.repeat.year' },
]

function todayString(): string {
  return dayjs().format('YYYY-MM-DD')
}

function sourceLabel(source: string, t: (key: MessageKey) => string): string {
  if (source === 'nbu') return t('common.rateSource.nbu')
  if (source === 'manual') return t('common.rateSource.manual')
  return source.toUpperCase()
}

function collectErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  into: Partial<Record<ErrorField, string>>,
) {
  for (const issue of issues) {
    const key = issue.path[0]
    if (key === 'amount' || key === 'categoryId' || key === 'createdAt') {
      if (!into[key]) into[key] = issue.message
    }
  }
}

function FieldError({
  field,
  errors,
}: {
  field: ErrorField
  errors: Partial<Record<ErrorField, string>>
}) {
  const message = errors[field]
  if (!message) return null
  return (
    <p data-testid={`drawer-error-${field}`} className="text-xs text-destructive">
      {validationMessage(message)}
    </p>
  )
}

interface FormProps extends ExpenseDrawerProps {
  amountRef: React.RefObject<HTMLInputElement | null>
}

type AddVariables = {
  input: CreateExpenseInput
  repeat: QuickRepeat
  another: boolean
}

function ExpenseDrawerForm({
  mode,
  expense,
  onOpenChange,
  initial,
  categories,
  mainCurrency,
  entries,
  amountRef,
}: FormProps) {
  const queryClient = useQueryClient()
  const { t } = useT()
  const record = mode === 'edit' ? expense : undefined
  const isEdit = record !== undefined

  const [today] = useState(todayString)
  const initialDate = record
    ? dayjs(record.createdAt).format('YYYY-MM-DD')
    : today

  const [amount, setAmount] = useState(() =>
    record ? String(record.amount) : (initial?.amount ?? ''),
  )
  const [description, setDescription] = useState(() =>
    record ? (record.description ?? '') : (initial?.description ?? ''),
  )
  const [date, setDate] = useState(initialDate)
  const [repeat, setRepeat] = useState<QuickRepeat>('none')
  const [errors, setErrors] = useState<Partial<Record<ErrorField, string>>>({})

  // Category: a chosen id, else the default (initial.categoryId when it
  // exists, else the first category). Derived, so categories that arrive
  // after the drawer opened still end up selected.
  const [chosenCategoryId, setChosenCategoryId] = useState<string | null>(
    record ? record.categoryId : null,
  )
  const [categoryPicked, setCategoryPicked] = useState(isEdit)
  const initialCategoryId =
    !isEdit &&
    initial?.categoryId !== undefined &&
    categories.some((c) => c.id === initial.categoryId)
      ? initial.categoryId
      : undefined
  const categoryId =
    chosenCategoryId !== null &&
    (isEdit || categories.some((c) => c.id === chosenCategoryId))
      ? chosenCategoryId
      : (initialCategoryId ?? categories.at(0)?.id ?? '')
  const category = categories.find((c) => c.id === categoryId)
  // A category from `initial` or the URL counts as the user's choice.
  const categoryTouched = categoryPicked || initialCategoryId !== undefined

  // Currency: a set value, else initial.currency, else the category default.
  const [chosenCurrency, setChosenCurrency] = useState<Currency | null>(
    record ? record.currency : null,
  )
  const [currencyTapped, setCurrencyTapped] = useState(isEdit)
  const currency =
    chosenCurrency ??
    (isEdit ? undefined : initial?.currency) ??
    currencyForCategory(category, mainCurrency)
  const currencyTouched =
    currencyTapped || (!isEdit && initial?.currency !== undefined)

  // Roving tab index of the category chips.
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const checkedIndex = categories.findIndex((c) => c.id === categoryId)
  const tabIndexOwner =
    focusIndex !== null && focusIndex < categories.length
      ? focusIndex
      : Math.max(checkedIndex, 0)

  // Refocus the amount input after "Save & add another".
  const [refocus, setRefocus] = useState(0)
  useEffect(() => {
    if (refocus > 0) amountRef.current?.focus()
  }, [refocus, amountRef])

  const busyRef = useRef(false)

  const invalidateData = (withRecurring: boolean) => {
    void queryClient.invalidateQueries({ queryKey: ['expenses'] })
    void queryClient.invalidateQueries({ queryKey: ['analytics'] })
    if (withRecurring) {
      void queryClient.invalidateQueries({ queryKey: ['recurring'] })
    }
  }

  const addMutation = useMutation({
    mutationFn: ({ input, repeat: unit }: AddVariables) =>
      unit === 'none' ? addExpense(input) : addRepeatingExpense(input, unit),
    onSuccess: (_saved, { repeat: unit, another }) => {
      invalidateData(unit !== 'none')
      toast.success(t('toasts.expenseSaved'))
      if (another) {
        setAmount('')
        setDescription('')
        setRepeat('none')
        setErrors({})
        setRefocus((n) => n + 1)
      } else {
        onOpenChange(false)
      }
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.saveFailedWith', { error: errorMessage(error) }))
    },
    onSettled: () => {
      busyRef.current = false
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      originalCreatedAt,
      patch,
    }: {
      id: string
      originalCreatedAt: string
      patch: UpdateExpenseInput
    }) => updateExpense(id, originalCreatedAt, patch),
    onSuccess: () => {
      invalidateData(false)
      toast.success(t('toasts.transactionUpdated'))
      onOpenChange(false)
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.updateFailedWith', { error: errorMessage(error) }))
    },
    onSettled: () => {
      busyRef.current = false
    },
  })

  const deleteMutation = useMutation({
    mutationFn: ({ id, createdAt }: { id: string; createdAt: string }) =>
      deleteExpense(id, createdAt),
    onSuccess: () => {
      invalidateData(false)
      toast.success(t('toasts.transactionDeleted'))
      onOpenChange(false)
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.deleteFailedWith', { error: errorMessage(error) }))
    },
    onSettled: () => {
      busyRef.current = false
    },
  })

  const busy =
    addMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  // ── Field handlers ─────────────────────────────────────────────────────────

  const pickCategory = (id: string) => {
    setChosenCategoryId(id)
    setCategoryPicked(true)
    // Follow the new category's default unless the user tapped a currency.
    if (!currencyTouched) setChosenCurrency(null)
  }

  const tapCurrency = (code: Currency) => {
    setChosenCurrency(code)
    setCurrencyTapped(true)
  }

  const pickSuggestion = (
    s: DescriptionSuggestion,
    { withAmount }: { withAmount: boolean },
  ) => {
    setDescription(s.description)
    if (!categoryTouched && categories.some((c) => c.id === s.categoryId)) {
      setChosenCategoryId(s.categoryId)
    }
    if (!currencyTouched) setChosenCurrency(s.currency)
    if (withAmount) setAmount(String(s.amount))
  }

  const changeRepeat = (next: QuickRepeat) => {
    setRepeat(next)
    // Repeating entries start today (same as Quick Add).
    if (next !== 'none') setDate(todayString())
  }

  const handleChipKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const n = categories.length
    if (n === 0) return
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % n
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (index - 1 + n) % n
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pickCategory(categories[index].id)
      setFocusIndex(index)
      return
    }
    if (next === null) return
    e.preventDefault()
    setFocusIndex(next)
    chipRefs.current[next]?.focus()
  }

  // ── Save / delete ──────────────────────────────────────────────────────────

  const saveAdd = (another: boolean) => {
    const found: Partial<Record<ErrorField, string>> = {}
    const result = createExpenseSchema.safeParse({
      amount: parseDraftAmount(amount),
      currency,
      categoryId,
      description: description.trim() || undefined,
    })
    if (!result.success) collectErrors(result.error.issues, found)
    if (repeat === 'none') {
      if (date === '') found.createdAt = 'errors.validation.dateRequired'
      else if (!dayjs(date).isValid()) found.createdAt = 'errors.validation.invalidDate'
    }
    setErrors(found)
    if (!result.success || Object.keys(found).length > 0) return

    const input: CreateExpenseInput = { ...result.data }
    if (repeat === 'none') {
      const createdAt = createdAtForDate(date, todayString())
      if (createdAt !== undefined) input.createdAt = createdAt
    }
    busyRef.current = true
    addMutation.mutate({ input, repeat, another })
  }

  const saveEdit = (target: Expense) => {
    const found: Partial<Record<ErrorField, string>> = {}
    const result = updateExpenseSchema.safeParse({
      amount: parseDraftAmount(amount),
      currency,
      categoryId,
      description: description.trim(),
      createdAt: buildCreatedAt(date, initialDate, target.createdAt),
    })
    if (!result.success) collectErrors(result.error.issues, found)
    setErrors(found)
    if (!result.success) return

    busyRef.current = true
    updateMutation.mutate({
      id: target.id,
      originalCreatedAt: target.createdAt,
      patch: result.data,
    })
  }

  const save = (another = false) => {
    if (busyRef.current || busy) return
    if (record) saveEdit(record)
    else saveAdd(another)
  }

  const remove = () => {
    if (!record || busyRef.current || busy) return
    busyRef.current = true
    deleteMutation.mutate({ id: record.id, createdAt: record.createdAt })
  }

  // ── Edit-only information ──────────────────────────────────────────────────

  const conversion = record?.conversion
  const showConversion =
    record !== undefined &&
    conversion !== undefined &&
    record.currency !== mainCurrency &&
    conversion.mainCurrency === mainCurrency
  const willRecalculate =
    showConversion &&
    (parseDraftAmount(amount) !== record.amount ||
      currency !== record.currency ||
      date !== initialDate)

  const repeating = !isEdit && repeat !== 'none'
  const isFuture = !repeating && date !== '' && date > today

  return (
    <>
      <SheetHeader className="border-b border-border pr-12">
        <SheetTitle data-testid="expense-drawer-title" className="text-lg">
          {isEdit ? t('drawer.editTitle') : t('drawer.addTitle')}
        </SheetTitle>
        <SheetDescription className="sr-only">
          {isEdit ? t('drawer.editDescription') : t('drawer.addDescription')}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {record?.recurringId !== undefined && (
          <p
            data-testid="drawer-recurring-note"
            className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
          >
            {t('drawer.recurringNote')}
          </p>
        )}

        {/* a. Amount */}
        <div className="space-y-2">
          <Label htmlFor="drawer-amount" className={LABEL_CLASS}>
            {t('common.amount')}
          </Label>
          <Input
            ref={amountRef}
            id="drawer-amount"
            data-testid="drawer-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder={formatAmount(0)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save(false)
              }
            }}
            aria-invalid={errors.amount ? true : undefined}
            className="h-14 text-3xl font-bold tabular-nums md:text-3xl"
          />
          <FieldError field="amount" errors={errors} />
          {showConversion && (
            <p
              data-testid="drawer-conversion-info"
              className="text-xs text-muted-foreground"
            >
              {`≈ ${formatMoney(conversion.mainAmount, mainCurrency)} · ${sourceLabel(conversion.source, t)} · ${formatDay(conversion.rateDate)}`}
            </p>
          )}
          {willRecalculate && (
            <p
              data-testid="drawer-recalc-note"
              className="text-xs text-muted-foreground"
            >
              {t('drawer.willRecalculate')}
            </p>
          )}
        </div>

        {/* b. Currency */}
        <div className="space-y-2">
          <div className={LABEL_CLASS} aria-hidden="true">
            {t('common.currency')}
          </div>
          <CurrencyPicker
            testIdPrefix="drawer"
            value={currency}
            onChange={tapCurrency}
          />
        </div>

        {/* c. Category */}
        <div className="space-y-2">
          <div className={LABEL_CLASS} aria-hidden="true">
            {t('common.category')}
          </div>
          <div
            role="radiogroup"
            aria-label={t('common.category')}
            data-testid="drawer-category-group"
            className="flex flex-wrap gap-2"
          >
            {categories.map((c, i) => {
              const checked = c.id === categoryId
              return (
                <button
                  key={c.id}
                  ref={(el) => {
                    chipRefs.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={i === tabIndexOwner ? 0 : -1}
                  data-testid={`drawer-category-${c.id}`}
                  onClick={() => {
                    pickCategory(c.id)
                    setFocusIndex(i)
                  }}
                  onKeyDown={(e) => handleChipKeyDown(e, i)}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-9',
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:bg-muted',
                  )}
                >
                  {c.icon && <span aria-hidden="true">{c.icon}</span>}
                  <span>{c.name}</span>
                </button>
              )
            })}
          </div>
          <FieldError field="categoryId" errors={errors} />
        </div>

        {/* d. Date */}
        <div className="space-y-2">
          <Label htmlFor="drawer-date" className={LABEL_CLASS}>
            {t('common.date')}
          </Label>
          <Input
            id="drawer-date"
            data-testid="drawer-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={repeating}
            aria-invalid={errors.createdAt ? true : undefined}
            className="h-11 sm:h-10"
          />
          {isFuture && (
            <p
              data-testid="drawer-future-hint"
              className="text-xs text-muted-foreground"
            >
              {t('drawer.futureDate')}
            </p>
          )}
          {repeating && (
            <p className="text-xs text-muted-foreground">
              {t('drawer.repeatStartsToday')}
            </p>
          )}
          <FieldError field="createdAt" errors={errors} />
        </div>

        {/* e. Description */}
        <div className="space-y-2">
          <Label htmlFor="drawer-description" className={LABEL_CLASS}>
            {t('common.description')}{' '}
            <span className="normal-case font-normal opacity-50">
              {t('common.optional')}
            </span>
          </Label>
          <DescriptionSuggestInput
            id="drawer-description"
            testIdPrefix="drawer"
            value={description}
            onChange={setDescription}
            entries={entries}
            categoryId={categoryId || undefined}
            onPick={pickSuggestion}
            onEnter={() => save(false)}
            placeholder={t('dashboard.quickAdd.descriptionPlaceholder')}
            maxLength={120}
            className="h-11 sm:h-10"
          />
        </div>

        {/* f. Repeat (add mode only) */}
        {!isEdit && (
          <div className="space-y-2">
            <Label htmlFor="drawer-repeat" className={LABEL_CLASS}>
              {t('common.repeat.label')}
            </Label>
            <select
              id="drawer-repeat"
              data-testid="drawer-repeat"
              value={repeat}
              onChange={(e) => changeRepeat(e.target.value as QuickRepeat)}
              className={SELECT_CLASS}
            >
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.label)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-border bg-popover p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button
          type="button"
          data-testid="drawer-save"
          onClick={() => save(false)}
          disabled={busy}
          className="min-h-11 flex-1 sm:min-h-9"
        >
          {t('common.save')}
        </Button>
        {isEdit ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                data-testid="drawer-delete"
                disabled={busy}
                className="min-h-11 sm:min-h-9"
              >
                {t('common.delete')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('drawer.deleteTitle')}</AlertDialogTitle>
                <AlertDialogDescription>{t('drawer.deleteDescription')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="drawer-delete-cancel">
                  {t('common.cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="drawer-delete-confirm"
                  variant="destructive"
                  onClick={remove}
                >
                  {t('common.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button
            type="button"
            variant="secondary"
            data-testid="drawer-save-another"
            onClick={() => save(true)}
            disabled={busy}
            className="min-h-11 flex-1 sm:min-h-9"
          >
            {t('drawer.saveAnother')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          data-testid="drawer-cancel"
          onClick={() => onOpenChange(false)}
          disabled={busy}
          className="min-h-11 sm:min-h-9"
        >
          {t('common.cancel')}
        </Button>
      </div>
    </>
  )
}
