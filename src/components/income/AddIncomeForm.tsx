import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import type {
  Category,
  CreateIncomeInput,
  Currency,
  QuickRepeat,
} from '@/lib/domain'
import { CURRENCIES, DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { addIncome, addRepeatingIncome } from '@/lib/localDb'
import { createIncomeSchema } from '@/lib/schemas'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface AddIncomeFormProps {
  /** Income categories; the first one is selected by default. */
  categories: Array<Category>
  onSuccess: () => void
  /** The preselected currency (the main currency) until the user picks one. */
  defaultCurrency?: Currency
}

export function AddIncomeForm({
  categories,
  onSuccess,
  defaultCurrency = DEFAULT_MAIN_CURRENCY,
}: AddIncomeFormProps) {
  const [amount, setAmount] = useState('')
  const [chosenCurrency, setCurrency] = useState<Currency | null>(null)
  const currency = chosenCurrency ?? defaultCurrency
  const [selected, setSelected] = useState('')
  const [description, setDescription] = useState('')
  const [repeat, setRepeat] = useState<QuickRepeat>('none')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const queryClient = useQueryClient()

  // The first category is the default, even when the list arrives later or
  // the selected one disappears.
  const categoryId = categories.some((c) => c.id === selected)
    ? selected
    : (categories[0]?.id ?? '')
  const selectedCategory = categories.find((c) => c.id === categoryId)

  const mutation = useMutation({
    mutationFn: ({
      data,
      repeat: unit,
    }: {
      data: CreateIncomeInput
      repeat: QuickRepeat
    }) => (unit === 'none' ? addIncome(data) : addRepeatingIncome(data, unit)),
    onSuccess: (_saved, { repeat: unit }) => {
      setAmount('')
      setDescription('')
      setRepeat('none')
      setErrors({})
      if (unit !== 'none') {
        void queryClient.invalidateQueries({ queryKey: ['recurring'] })
      }
      toast.success('Income saved')
      onSuccess()
    },
    onError: (error: any) => {
      toast.error(`Failed to save income: ${error.message}`)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const result = createIncomeSchema.safeParse({
      categoryId,
      amount: Number(amount),
      currency,
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

    mutation.mutate({ data: result.data, repeat })
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm">
      <form data-testid="add-income-form" onSubmit={handleSubmit}>
        <CardContent className="pt-5 pb-5 flex flex-col gap-4">
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Amount
            </Label>
            <div
              className={`flex items-center h-12 rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0 overflow-hidden ${errors.amount ? 'border-destructive' : 'border-input'}`}
            >
              <input
                data-testid="income-form-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                disabled={mutation.isPending}
                className="flex-1 h-full bg-transparent px-3 text-2xl font-bold outline-none
                  [appearance:textfield]
                  [&::-webkit-outer-spin-button]:appearance-none
                  [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div className="w-px h-6 bg-border flex-shrink-0" />
              <Select
                value={currency}
                onValueChange={(v) => setCurrency(v as Currency)}
                disabled={mutation.isPending}
              >
                <SelectTrigger className="w-[88px] h-full border-0 shadow-none rounded-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 font-semibold bg-transparent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {errors.amount && (
              <p className="text-xs text-destructive">{errors.amount}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="income-category"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Category
            </Label>
            {categories.length === 0 ? (
              <Link
                to="/settings"
                search={{ tab: 'categories' }}
                data-testid="income-form-no-categories"
                className="block text-sm text-primary underline underline-offset-4"
              >
                Add income categories in Settings → Categories
              </Link>
            ) : (
              <Select
                value={categoryId}
                onValueChange={(v) => setSelected(v)}
                disabled={mutation.isPending}
              >
                <SelectTrigger
                  id="income-category"
                  data-testid="income-form-category"
                  className={`h-11 ${errors.categoryId ? 'border-destructive' : ''}`}
                >
                  <SelectValue placeholder="Select a category">
                    {selectedCategory && (
                      <span className="flex items-center gap-2">
                        {selectedCategory.icon && (
                          <span className="text-base">
                            {selectedCategory.icon}
                          </span>
                        )}
                        <span>{selectedCategory.name}</span>
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      <div className="flex items-center gap-2">
                        {cat.icon && (
                          <span className="text-base">{cat.icon}</span>
                        )}
                        <span>{cat.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {errors.categoryId && (
              <p
                data-testid="income-form-category-error"
                className="text-xs text-destructive"
              >
                {errors.categoryId}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Description{' '}
              <span className="normal-case font-normal opacity-50">
                (optional)
              </span>
            </Label>
            <Input
              data-testid="income-form-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. March salary"
              disabled={mutation.isPending}
              className={errors.description ? 'border-destructive' : ''}
            />
          </div>

          {/* Repeat — creates a matching recurring item starting today */}
          <div className="space-y-2">
            <Label
              htmlFor="income-repeat-select"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Repeat
            </Label>
            <select
              id="income-repeat-select"
              data-testid="income-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as QuickRepeat)}
              disabled={mutation.isPending}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="none">Don't repeat</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </div>

          <Button
            data-testid="income-form-submit"
            type="submit"
            disabled={mutation.isPending}
            className="w-full h-12 text-base font-bold mt-1 bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0 shadow-sm"
          >
            {mutation.isPending ? 'Saving…' : 'Save Income'}
          </Button>
        </CardContent>
      </form>
    </Card>
  )
}
