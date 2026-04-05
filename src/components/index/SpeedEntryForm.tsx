import { useState } from 'react'
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
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

import type { Category, CreateExpenseInput, Currency } from '@/lib/domain'

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!amount || !categoryId) return
    onSubmit({ amount: Number(amount), currency, categoryId })
    setAmount('')
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm">
      <form onSubmit={handleSubmit}>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-semibold tracking-tight">Quick Add Expense</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex gap-4 items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="amount" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Amount
              </Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="text-2xl font-bold h-12"
                placeholder="0.00"
                required
                disabled={isPending}
              />
            </div>

            <div className="w-32 space-y-2">
              <Label htmlFor="currency" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Currency
              </Label>
              <Select
                value={currency}
                onValueChange={(v) => setCurrency(v as Currency)}
                disabled={isPending}
              >
                <SelectTrigger id="currency" className="h-12 font-semibold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UAH">UAH</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="category" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Category
            </Label>
            <Select
              value={categoryId}
              onValueChange={setCategoryId}
              disabled={isPending}
              required
            >
              <SelectTrigger id="category" className="h-11">
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
        </CardContent>

        <CardFooter className="pt-2 pb-6">
          <Button
            type="submit"
            disabled={isPending}
            className="w-full h-12 text-base font-bold shadow-sm"
          >
            {isPending ? 'Saving...' : 'Save Expense'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
