import { useState, SubmitEvent } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'

import type { Category, CreateExpenseInput, Currency } from '@/lib/domain'
import { createExpenseSchema } from '@/lib/schemas'

interface SpeedEntryFormProps {
  categories: Array<Category>
  onSubmit: (data: CreateExpenseInput) => void
  isPending?: boolean
}

export default function SpeedEntryForm({
  categories,
  onSubmit,
  isPending,
}: SpeedEntryFormProps) {
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('UAH')
  const [categoryId, setCategoryId] = useState(categories[0]?.id || '')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault()
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

    onSubmit(result.data)
    setAmount('')
    setDescription('')
    setErrors({})
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm">
      <form onSubmit={handleSubmit}>
        <CardContent className="pt-5 pb-5 flex flex-col gap-4">

          {/* Amount + Currency */}
          <div className="space-y-2">
            <Label
              htmlFor="amount"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Amount
            </Label>
            <div className={`flex items-center h-12 rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0 overflow-hidden ${errors.amount ? 'border-destructive' : 'border-input'}`}>
              <input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                disabled={isPending}
                className="flex-1 h-full bg-transparent px-3 text-2xl font-bold outline-none
                  [appearance:textfield]
                  [&::-webkit-outer-spin-button]:appearance-none
                  [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div className="w-px h-6 bg-border flex-shrink-0" />
              <Select
                value={currency}
                onValueChange={(v) => setCurrency(v as Currency)}
                disabled={isPending}
              >
                <SelectTrigger
                  id="currency"
                  className="w-[88px] h-full border-0 shadow-none rounded-none
                    focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0
                    font-semibold bg-transparent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UAH">UAH</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {errors.amount && (
              <p className="text-xs text-destructive">{errors.amount}</p>
            )}
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label
              htmlFor="category"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Category
            </Label>
            <Select
              value={categoryId}
              onValueChange={(v) => setCategoryId(v)}
              disabled={isPending}
            >
              <SelectTrigger
                id="category"
                className="h-11"
              >
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    <div className="flex items-center gap-2">
                      {cat.icon && <span className="text-base">{cat.icon}</span>}
                      <span>{cat.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description — optional */}
          <div className="space-y-2">
            <Label
              htmlFor="description"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Description{' '}
              <span className="normal-case font-normal opacity-50">(optional)</span>
            </Label>
            <Input
              id="description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. coffee with team"
              maxLength={120}
              disabled={isPending}
              className={errors.description ? 'border-destructive' : ''}
            />
          </div>

          {/* Submit */}
          <Button
            type="submit"
            disabled={isPending}
            className="w-full h-12 text-base font-bold mt-1 bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0 shadow-sm"
          >
            {isPending ? 'Saving…' : 'Save Expense'}
          </Button>

        </CardContent>
      </form>
    </Card>
  )
}
