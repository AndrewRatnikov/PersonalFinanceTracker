import { useState } from 'react'
import type { SubmitEvent } from 'react'
import type {
  Category,
  CreateExpenseInput,
  Currency,
  QuickRepeat,
} from '@/lib/domain'
import type { DescriptionSuggestion, SuggestionEntry } from '@/lib/suggestions'
import { useT } from '@/i18n'
import { validationMessage } from '@/i18n/errors'
import { formatAmount } from '@/i18n/format'
import { currencyForCategory } from '@/lib/categoryCurrency'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CurrencyPicker } from '@/components/CurrencyPicker'
import { DescriptionSuggestInput } from '@/components/DescriptionSuggestInput'
import { PaidBySelect } from '@/components/members/PaidBySelect'

import { createExpenseSchema } from '@/lib/schemas'

const NO_ENTRIES: ReadonlyArray<SuggestionEntry> = []

interface SpeedEntryFormProps {
  categories: Array<Category>
  /** `repeat` other than 'none' also creates a recurring item starting today. */
  onSubmit: (data: CreateExpenseInput, repeat: QuickRepeat) => Promise<void>
  isPending?: boolean
  /** The preselected currency (the main currency) until the user picks one. */
  defaultCurrency?: Currency
  /** Entries the description suggestions are computed from. */
  entries?: ReadonlyArray<SuggestionEntry>
}

export default function SpeedEntryForm({
  categories,
  onSubmit,
  isPending,
  defaultCurrency = DEFAULT_MAIN_CURRENCY,
  entries = NO_ENTRIES,
}: SpeedEntryFormProps) {
  const [amount, setAmount] = useState('')
  const [categoryId, setCategoryId] = useState(categories[0]?.id || '')
  // Set by any change event of the category select, even re-selecting the
  // same category: a suggestion pick then keeps the user's category.
  const [categoryTouched, setCategoryTouched] = useState(false)
  const selectedCategory = categories.find((c) => c.id === categoryId)
  // A tapped currency wins; else a suggestion's currency (until the category
  // changes); else the category default; else the main currency.
  const [chosenCurrency, setCurrency] = useState<Currency | null>(null)
  const [suggestedCurrency, setSuggestedCurrency] = useState<Currency | null>(
    null,
  )
  const currency =
    chosenCurrency ??
    suggestedCurrency ??
    currencyForCategory(selectedCategory, defaultCurrency)
  const [description, setDescription] = useState('')
  const [repeat, setRepeat] = useState<QuickRepeat>('none')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { t } = useT()
  // Family only: who paid (default me). Personal adds no paidBy key.
  const { isFamily, directory, memberId, readOnly } = useSpaceSwitch()
  const showPaidBy = isFamily && directory !== null
  const [paidBy, setPaidBy] = useState<string | null>(null)
  const payer = paidBy ?? memberId ?? ''

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    if (readOnly) return
    setErrors({})

    const result = createExpenseSchema.safeParse({
      amount: Number(amount),
      currency,
      categoryId,
      description: description.trim() || undefined,
    })

    if (!result.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of result.error.issues) {
        const key = issue.path[0] as string
        if (!fieldErrors[key]) fieldErrors[key] = issue.message

      }
      setErrors(fieldErrors)
      return
    }

    const data: CreateExpenseInput =
      showPaidBy && payer !== '' ? { ...result.data, paidBy: payer } : result.data
    try {
      await onSubmit(data, repeat)
    } catch {
      // The caller's mutation onError already shows a toast; keep what the user typed.
      return
    }
    setAmount('')
    setDescription('')
    setRepeat('none')
    setErrors({})
  }

  const handleCategoryChange = (id: string) => {
    setCategoryId(id)
    setCategoryTouched(true)
    setSuggestedCurrency(null)
  }

  const handlePick = (
    s: DescriptionSuggestion,
    { withAmount }: { withAmount: boolean },
  ) => {
    if (!categoryTouched && categories.some((c) => c.id === s.categoryId)) {
      setCategoryId(s.categoryId)
    }
    if (chosenCurrency === null) setSuggestedCurrency(s.currency)
    if (withAmount) setAmount(String(s.amount))
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm">
      <form data-testid="speed-entry-form" onSubmit={handleSubmit}>
        <CardContent className="pt-5 pb-5 flex flex-col gap-4">
          {/* Amount + Currency */}
          <div className="space-y-2">
            <Label
              htmlFor="amount"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('common.amount')}
            </Label>
            <div
              className={`flex items-center h-12 rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0 overflow-hidden ${errors.amount ? 'border-destructive' : 'border-input'}`}
            >
              <input
                id="amount"
                data-testid="speed-entry-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={formatAmount(0)}
                disabled={isPending}
                className="flex-1 h-full bg-transparent px-3 text-2xl font-bold outline-none
                  [appearance:textfield]
                  [&::-webkit-outer-spin-button]:appearance-none
                  [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
            {errors.amount && (
              <p className="text-xs text-destructive">{validationMessage(errors.amount)}</p>
            )}
            <CurrencyPicker
              testIdPrefix="speed-entry"
              value={currency}
              onChange={setCurrency}
              disabled={isPending}
            />
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label
              htmlFor="category"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('common.category')}
            </Label>
            <select
              id="category"
              data-testid="speed-entry-category"
              value={categoryId}
              onChange={(e) => handleCategoryChange(e.target.value)}
              disabled={isPending}
              aria-invalid={errors.categoryId ? true : undefined}
              className={`h-11 w-full rounded-md border bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${errors.categoryId ? 'border-destructive' : 'border-input'}`}
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.icon ? `${cat.icon} ${cat.name}` : cat.name}
                </option>
              ))}
            </select>
            {errors.categoryId && (
              <p className="text-xs text-destructive">{validationMessage(errors.categoryId)}</p>
            )}
          </div>

          {/* Description — optional */}
          <div className="space-y-2">
            <Label
              htmlFor="description"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('common.description')}{' '}
              <span className="normal-case font-normal opacity-50">
                {t('common.optional')}
              </span>
            </Label>
            <DescriptionSuggestInput
              id="description"
              testIdPrefix="speed-entry"
              value={description}
              onChange={setDescription}
              entries={entries}
              categoryId={categoryId || undefined}
              onPick={handlePick}
              placeholder={t('dashboard.quickAdd.descriptionPlaceholder')}
              maxLength={120}
              disabled={isPending}
              className={errors.description ? 'border-destructive' : ''}
            />
          </div>

          {/* Repeat — creates a matching recurring item starting today */}
          <div className="space-y-2">
            <Label
              htmlFor="repeat"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('common.repeat.label')}
            </Label>
            <select
              id="repeat"
              data-testid="speed-entry-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as QuickRepeat)}
              disabled={isPending}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="none">{t('common.repeat.none')}</option>
              <option value="week">{t('common.repeat.week')}</option>
              <option value="month">{t('common.repeat.month')}</option>
              <option value="year">{t('common.repeat.year')}</option>
            </select>
          </div>

          {showPaidBy && (
            <PaidBySelect
              value={payer}
              onChange={setPaidBy}
              label={t('members.paidBy')}
              directory={directory}
              memberId={memberId}
              disabled={isPending || readOnly}
            />
          )}

          {/* Submit */}
          <Button
            type="submit"
            data-testid="speed-entry-submit"
            disabled={isPending || readOnly}
            className="w-full h-12 text-base font-bold mt-1 bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0 shadow-sm"
          >
            {isPending ? t('common.saving') : t('dashboard.quickAdd.save')}
          </Button>
        </CardContent>
      </form>
    </Card>
  )
}
