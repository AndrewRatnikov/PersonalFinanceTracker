import { useState } from 'react'
import type { SubmitEvent } from 'react'

import type {
  Category,
  CreateRecurringInput,
  Currency,
  RecurrenceUnit,
  RecurringItem,
  RecurringKind,
  RecurringMode,
} from '@/lib/domain'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { validationMessage } from '@/i18n/errors'
import { formatAmount } from '@/i18n/format'
import { currencyForCategory } from '@/lib/categoryCurrency'
import { CURRENCIES, DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { recurringInputSchemaFor } from '@/lib/schemas'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { PaidBySelect } from '@/components/members/PaidBySelect'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface RecurringFormProps {
  expenseCategories: Array<Category>
  incomeCategories: Array<Category>
  /** YYYY-MM-DD */
  today: string
  /** Edit mode when set. */
  initial?: RecurringItem
  /** The preselected currency of a new item (the main currency). */
  defaultCurrency?: Currency
  isPending?: boolean
  onSubmit: (
    input: CreateRecurringInput,
    options: { createThroughToday: boolean },
  ) => Promise<void>
  onCancel: () => void
}

type EndType = 'never' | 'onDate' | 'afterCount'

// The fields that show an error, keyed by the top-level schema path.
type ErrorField = 'amount' | 'categoryId' | 'interval' | 'startDate' | 'end'

const UNIT_OPTIONS: ReadonlyArray<{ value: RecurrenceUnit; label: MessageKey }> = [
  { value: 'day', label: 'recurring.form.units.day' },
  { value: 'week', label: 'recurring.form.units.week' },
  { value: 'month', label: 'recurring.form.units.month' },
  { value: 'year', label: 'recurring.form.units.year' },
]

const END_OPTIONS: ReadonlyArray<{ value: EndType; label: MessageKey }> = [
  { value: 'never', label: 'recurring.form.endNever' },
  { value: 'onDate', label: 'recurring.form.endOnDate' },
  { value: 'afterCount', label: 'recurring.form.endAfterCount' },
]

const MODE_OPTIONS: ReadonlyArray<{ value: RecurringMode; label: MessageKey }> = [
  { value: 'auto', label: 'recurring.form.modeAuto' },
  { value: 'ask', label: 'recurring.form.modeAsk' },
]

// Native selects (not Radix): they can be driven in jsdom and work well on
// mobile.
const SELECT_CLASS =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

const LABEL_CLASS =
  'text-xs font-medium text-muted-foreground uppercase tracking-wider'

function errorFieldFor(path: PropertyKey | undefined): ErrorField | null {
  switch (path) {
    case 'amount':
    case 'categoryId':
    case 'startDate':
    case 'end':
      return path
    case 'frequency':
      return 'interval'
    default:
      return null
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
    <p
      data-testid={`recurring-form-error-${field}`}
      className="text-xs text-destructive"
    >
      {validationMessage(message)}
    </p>
  )
}

export default function RecurringForm({
  expenseCategories,
  incomeCategories,
  today,
  initial,
  defaultCurrency = DEFAULT_MAIN_CURRENCY,
  isPending,
  onSubmit,
  onCancel,
}: RecurringFormProps) {
  const isEdit = initial !== undefined
  const { t } = useT()
  const [kind, setKind] = useState<RecurringKind>(initial?.kind ?? 'expense')
  const [amount, setAmount] = useState(
    initial ? String(initial.amount) : '',
  )
  // A new item follows the chosen category's default currency (else
  // defaultCurrency) until the user picks a currency; editing keeps the
  // stored one.
  const [chosenCurrency, setCurrency] = useState<Currency | null>(
    initial?.currency ?? null,
  )
  const [categoryId, setCategoryId] = useState(
    initial ? initial.categoryId : (expenseCategories[0]?.id ?? ''),
  )
  const [description, setDescription] = useState(initial?.description ?? '')
  const [intervalText, setIntervalText] = useState(
    String(initial?.frequency.interval ?? 1),
  )
  const [unit, setUnit] = useState<RecurrenceUnit>(
    initial?.frequency.unit ?? 'month',
  )
  const [startDate, setStartDate] = useState(initial?.startDate ?? today)
  const initialEnd = initial?.end
  const [endType, setEndType] = useState<EndType>(initialEnd?.type ?? 'never')
  const [endDate, setEndDate] = useState(
    initialEnd?.type === 'onDate' ? initialEnd.date : '',
  )
  const [endCount, setEndCount] = useState(
    initialEnd?.type === 'afterCount' ? String(initialEnd.count) : '',
  )
  const [mode, setMode] = useState<RecurringMode>(initial?.mode ?? 'auto')
  // null until the user toggles it: the default then follows the start date.
  const [backfillChoice, setBackfillChoice] = useState<boolean | null>(null)
  const [errors, setErrors] = useState<Partial<Record<ErrorField, string>>>(
    {},
  )
  // Family only: who pays (default the stored payer, else me). Personal adds
  // no paidBy key.
  const { isFamily, directory, memberId } = useSpaceSwitch()
  const showPaidBy = isFamily && directory !== null
  const [paidBy, setPaidBy] = useState<string | null>(initial?.paidBy ?? null)
  const payer = paidBy ?? memberId ?? ''

  const categories = kind === 'income' ? incomeCategories : expenseCategories
  const categoryKnown = categories.some((c) => c.id === categoryId)
  const currency =
    chosenCurrency ??
    currencyForCategory(
      categories.find((c) => c.id === categoryId),
      defaultCurrency,
    )
  const showBackfill = !isEdit && startDate !== '' && startDate <= today
  const backfill = backfillChoice ?? startDate === today

  const changeKind = (next: RecurringKind) => {
    if (next === kind) return
    setKind(next)
    const list = next === 'income' ? incomeCategories : expenseCategories
    setCategoryId(list[0]?.id ?? '')
  }

  const buildInput = (): CreateRecurringInput => {
    const end: CreateRecurringInput['end'] =
      endType === 'onDate'
        ? { type: 'onDate', date: endDate }
        : endType === 'afterCount'
          ? { type: 'afterCount', count: Number(endCount) }
          : { type: 'never' }
    const trimmed = description.trim()
    return {
      kind,
      amount: Number(amount),
      currency,
      categoryId,
      description: trimmed === '' ? null : trimmed,
      frequency: { unit, interval: Number(intervalText) },
      startDate,
      end,
      mode,
      ...(showPaidBy && payer !== '' ? { paidBy: payer } : {}),
    }
  }

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    const input = buildInput()
    const result = recurringInputSchemaFor(
      categories.map((c) => c.id),
    ).safeParse(input)
    if (!result.success) {
      const next: Partial<Record<ErrorField, string>> = {}
      for (const issue of result.error.issues) {
        const field = errorFieldFor(issue.path[0])
        if (field && !next[field]) next[field] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    try {
      await onSubmit(input, {
        createThroughToday: showBackfill ? backfill : false,
      })
    } catch {
      // The caller shows the error; keep what the user typed.
    }
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm">
      <form
        data-testid="recurring-form"
        onSubmit={(e) => void handleSubmit(e)}
        noValidate
      >
        <CardContent className="pt-5 pb-5 flex flex-col gap-4">
          {/* Kind */}
          <div className="grid grid-cols-2 gap-2" role="group">
            <Button
              type="button"
              data-testid="recurring-form-kind-expense"
              aria-pressed={kind === 'expense'}
              variant={kind === 'expense' ? 'default' : 'outline'}
              onClick={() => changeKind('expense')}
              disabled={isPending}
            >
              {t('recurring.form.kindExpense')}
            </Button>
            <Button
              type="button"
              data-testid="recurring-form-kind-income"
              aria-pressed={kind === 'income'}
              variant={kind === 'income' ? 'default' : 'outline'}
              onClick={() => changeKind('income')}
              disabled={isPending}
            >
              {t('recurring.form.kindIncome')}
            </Button>
          </div>

          {/* Amount + currency */}
          <div className="space-y-2">
            <Label htmlFor="recurring-amount" className={LABEL_CLASS}>
              {t('common.amount')}
            </Label>
            <div className="flex gap-2">
              <Input
                id="recurring-amount"
                data-testid="recurring-form-amount"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                placeholder={formatAmount(0)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isPending}
                className={`h-10 flex-1 ${errors.amount ? 'border-destructive' : ''}`}
              />
              <select
                aria-label={t('common.currency')}
                data-testid="recurring-form-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                disabled={isPending}
                className={`${SELECT_CLASS} w-24`}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <FieldError field="amount" errors={errors} />
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label htmlFor="recurring-category" className={LABEL_CLASS}>
              {t('common.category')}
            </Label>
            <select
              id="recurring-category"
              data-testid="recurring-form-category"
              value={categoryKnown ? categoryId : ''}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={isPending}
              className={SELECT_CLASS}
            >
              {!categoryKnown && (
                <option value="" disabled>
                  {t('recurring.form.chooseCategory')}
                </option>
              )}
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon ? `${c.icon} ${c.name}` : c.name}
                </option>
              ))}
            </select>
            <FieldError field="categoryId" errors={errors} />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="recurring-description" className={LABEL_CLASS}>
              {t('common.description')}{' '}
              <span className="normal-case font-normal opacity-50">
                {t('common.optional')}
              </span>
            </Label>
            <Input
              id="recurring-description"
              data-testid="recurring-form-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('recurring.form.descriptionPlaceholder')}
              maxLength={120}
              disabled={isPending}
              className="h-10"
            />
          </div>

          {/* Frequency */}
          <div className="space-y-2">
            <Label htmlFor="recurring-interval" className={LABEL_CLASS}>
              {t('recurring.form.every')}
            </Label>
            <div className="flex gap-2">
              <Input
                id="recurring-interval"
                data-testid="recurring-form-interval"
                type="number"
                min="1"
                max="365"
                step="1"
                value={intervalText}
                onChange={(e) => setIntervalText(e.target.value)}
                disabled={isPending}
                className={`h-10 w-24 ${errors.interval ? 'border-destructive' : ''}`}
              />
              <select
                aria-label={t('recurring.form.unit')}
                data-testid="recurring-form-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value as RecurrenceUnit)}
                disabled={isPending}
                className={`${SELECT_CLASS} flex-1`}
              >
                {UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
            </div>
            <FieldError field="interval" errors={errors} />
          </div>

          {/* Start date */}
          <div className="space-y-2">
            <Label htmlFor="recurring-start" className={LABEL_CLASS}>
              {t('recurring.form.startsOn')}
            </Label>
            <Input
              id="recurring-start"
              data-testid="recurring-form-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={isPending}
              className={`h-10 ${errors.startDate ? 'border-destructive' : ''}`}
            />
            <FieldError field="startDate" errors={errors} />
          </div>

          {/* End */}
          <div className="space-y-2">
            <Label htmlFor="recurring-end-type" className={LABEL_CLASS}>
              {t('recurring.form.ends')}
            </Label>
            <div className="flex gap-2">
              <select
                id="recurring-end-type"
                data-testid="recurring-form-end-type"
                value={endType}
                onChange={(e) => setEndType(e.target.value as EndType)}
                disabled={isPending}
                className={`${SELECT_CLASS} flex-1`}
              >
                {END_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
              {endType === 'onDate' && (
                <Input
                  aria-label={t('recurring.form.endDate')}
                  data-testid="recurring-form-end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={isPending}
                  className="h-10 flex-1"
                />
              )}
              {endType === 'afterCount' && (
                <Input
                  aria-label={t('recurring.form.endCount')}
                  data-testid="recurring-form-end-count"
                  type="number"
                  min="1"
                  step="1"
                  value={endCount}
                  onChange={(e) => setEndCount(e.target.value)}
                  disabled={isPending}
                  className="h-10 w-24"
                />
              )}
            </div>
            <FieldError field="end" errors={errors} />
          </div>

          {/* Mode */}
          <div className="space-y-2">
            <Label htmlFor="recurring-mode" className={LABEL_CLASS}>
              {t('recurring.form.whenDue')}
            </Label>
            <select
              id="recurring-mode"
              data-testid="recurring-form-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as RecurringMode)}
              disabled={isPending}
              className={SELECT_CLASS}
            >
              {MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.label)}
                </option>
              ))}
            </select>
          </div>

          {showPaidBy && (
            <PaidBySelect
              value={payer}
              onChange={setPaidBy}
              label={t('members.paidBy')}
              directory={directory}
              memberId={memberId}
              disabled={isPending}
            />
          )}

          {showBackfill && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="recurring-form-backfill"
                checked={backfill}
                onChange={(e) => setBackfillChoice(e.target.checked)}
                disabled={isPending}
                className="h-4 w-4"
              />
              {t('recurring.form.backfill')}
            </label>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              data-testid="recurring-form-cancel"
              onClick={onCancel}
              className="flex-1"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              data-testid="recurring-form-submit"
              disabled={isPending}
              className="flex-1 bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
            >
              {isPending
                ? t('common.saving')
                : isEdit
                  ? t('common.saveChanges')
                  : t('common.add')}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  )
}
