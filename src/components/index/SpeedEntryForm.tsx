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
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50"
    >
      <div className="flex gap-4 items-end">
        <div className="flex-1 flex flex-col gap-1">
          <Label className="text-sm text-slate-400">Amount</Label>
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="bg-slate-900 border-slate-700 text-3xl font-bold text-white h-9 px-4 focus-visible:ring-cyan-500 focus-visible:border-cyan-500"
            placeholder="0.00"
            required
            disabled={isPending}
          />
        </div>

        <div className="w-28 flex flex-col gap-1">
          <Label className="text-sm text-slate-400">Currency</Label>
          <Select
            value={currency}
            onValueChange={(v) => setCurrency(v as Currency)}
            disabled={isPending}
          >
            <SelectTrigger className="bg-slate-900 border-slate-700 text-white h-9 text-xl font-bold w-full focus:ring-cyan-500">
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

      <div className="flex flex-col gap-1">
        <Label className="text-sm text-slate-400">Category</Label>
        <Select
          value={categoryId}
          onValueChange={setCategoryId}
          disabled={isPending}
          required
        >
          <SelectTrigger className="bg-slate-900 border-slate-700 text-white h-9 text-lg w-full focus:ring-cyan-500">
            <SelectValue placeholder="Select a category" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.icon ? `${cat.icon} ` : ''}
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        type="submit"
        disabled={isPending}
        className="w-full bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-white font-bold py-4 h-14 rounded-xl text-lg shadow-lg shadow-cyan-500/30 mt-2"
      >
        {isPending ? 'Saving...' : 'Save Expense'}
      </Button>
    </form>
  )
}
