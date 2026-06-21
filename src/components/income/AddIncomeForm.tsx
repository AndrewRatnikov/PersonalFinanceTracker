import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { addIncome } from '@/lib/localDb'
import { createIncomeSchema } from '@/lib/schemas'
import type { CreateIncomeInput, Currency } from '@/lib/domain'

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
  onSuccess: () => void
}

export function AddIncomeForm({ onSuccess }: AddIncomeFormProps) {
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('UAH')
  const [source, setSource] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mutation = useMutation({
    mutationFn: (data: CreateIncomeInput) => addIncome(data),
    onSuccess: () => {
      setAmount('')
      setSource('')
      setDescription('')
      setErrors({})
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
      source: source.trim(),
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

    mutation.mutate(result.data)
  }

  return (
    <Card className="border-border bg-card/50 backdrop-blur-sm">
      <form onSubmit={handleSubmit}>
        <CardContent className="pt-5 pb-5 flex flex-col gap-4">

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Amount
            </Label>
            <div className={`flex items-center h-12 rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0 overflow-hidden ${errors.amount ? 'border-destructive' : 'border-input'}`}>
              <input
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

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Source
            </Label>
            <Input
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. Salary, Freelance"
              disabled={mutation.isPending}
              className={errors.source ? 'border-destructive' : ''}
            />
            {errors.source && (
              <p className="text-xs text-destructive">{errors.source}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Description{' '}
              <span className="normal-case font-normal opacity-50">(optional)</span>
            </Label>
            <Input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. March salary"
              disabled={mutation.isPending}
              className={errors.description ? 'border-destructive' : ''}
            />
          </div>

          <Button
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
