import { useState } from 'react'
import dayjs from 'dayjs'
import { Check, Loader2, Trash2, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'

import type { Category, Currency, Expense } from '@/lib/domain'
import type { UpdateExpenseFormValues } from '@/lib/schemas'
import { TableCell, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { CURRENCIES } from '@/lib/domain'
import { updateExpenseSchema } from '@/lib/schemas'

interface ExpenseRowEditorProps {
  expense: Expense
  categories: Array<Category>
  onSave: (values: UpdateExpenseFormValues) => void | Promise<void>
  onCancel: () => void
}

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive'

function FieldError({ field, message }: { field: string; message?: string }) {
  if (!message) return null
  return (
    <p data-testid={`edit-error-${field}`} className="text-xs text-destructive mt-1">
      {message}
    </p>
  )
}

/**
 * Builds the ISO createdAt for the chosen calendar date. An unchanged date
 * passes the original timestamp through untouched; a changed date keeps the
 * original local time of day.
 */
function buildCreatedAt(date: string, initialDate: string, original: string): string {
  if (date === initialDate) return original
  if (date === '') return ''
  const picked = dayjs(date)
  if (!picked.isValid()) return date
  const orig = dayjs(original)
  return picked
    .hour(orig.hour())
    .minute(orig.minute())
    .second(orig.second())
    .millisecond(orig.millisecond())
    .toISOString()
}

export function ExpenseRowEditor({
  expense,
  categories,
  onSave,
  onCancel,
}: ExpenseRowEditorProps) {
  const initialDate = dayjs(expense.createdAt).format('YYYY-MM-DD')
  const [date, setDate] = useState(initialDate)
  const [amount, setAmount] = useState(String(expense.amount))
  const [currency, setCurrency] = useState<Currency>(expense.currency)
  const [categoryId, setCategoryId] = useState(expense.categoryId)
  const [description, setDescription] = useState(expense.description ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (saving) return

    const result = updateExpenseSchema.safeParse({
      amount: Number(amount),
      currency,
      categoryId,
      description: description.trim(),
      createdAt: buildCreatedAt(date, initialDate, expense.createdAt),
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

    setErrors({})
    setSaving(true)
    try {
      await Promise.resolve(onSave(result.data))
    } catch {
      // The parent reports the failure (toast). This editor stays mounted, so
      // the entered values remain available for another attempt.
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter') {
      // Let Enter on the Save/Cancel buttons activate that button instead.
      if (e.target instanceof HTMLButtonElement) return
      e.preventDefault()
      void handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <TableRow
      data-testid="transaction-edit-row"
      className="bg-muted/20 align-top"
      onKeyDown={handleKeyDown}
    >
      <TableCell className="pl-6">
        <Input
          type="date"
          data-testid="edit-date-input"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={errors.createdAt ? true : undefined}
          aria-label="Date"
          className="w-[150px]"
        />
        <FieldError field="createdAt" message={errors.createdAt} />
      </TableCell>
      <TableCell>
        <select
          data-testid="edit-category-select"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-invalid={errors.categoryId ? true : undefined}
          aria-label="Category"
          className={SELECT_CLASS}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon ? `${c.icon} ${c.name}` : c.name}
            </option>
          ))}
        </select>
        <FieldError field="categoryId" message={errors.categoryId} />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Input
          data-testid="edit-description-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={errors.description ? true : undefined}
          aria-label="Description"
          placeholder="Description"
        />
        <FieldError field="description" message={errors.description} />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Input
            type="number"
            step="0.01"
            data-testid="edit-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={errors.amount ? true : undefined}
            aria-label="Amount"
            className="w-[110px] text-right tabular-nums"
          />
          <select
            data-testid="edit-currency-select"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            aria-invalid={errors.currency ? true : undefined}
            aria-label="Currency"
            className={SELECT_CLASS}
          >
            {CURRENCIES.map((cur) => (
              <option key={cur} value={cur}>
                {cur}
              </option>
            ))}
          </select>
        </div>
        <FieldError field="amount" message={errors.amount} />
        <FieldError field="currency" message={errors.currency} />
      </TableCell>
      <TableCell className="pr-6 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            data-testid="edit-save-button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
            title="Save changes"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="edit-cancel-button"
            onClick={onCancel}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title="Cancel editing"
          >
            <X className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="transaction-delete-button"
            disabled
            className="h-8 w-8 text-muted-foreground"
            title="Finish editing before deleting"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
