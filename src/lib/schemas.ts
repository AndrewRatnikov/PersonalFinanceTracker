import { z } from 'zod'

export const CURRENCIES = ['UAH', 'USD', 'EUR'] as const

export const createIncomeSchema = z.object({
  source: z.string().min(1, 'Source is required'),
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.enum(CURRENCIES),
  description: z.string().optional(),
})

export const createExpenseSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.enum(CURRENCIES),
  categoryId: z.string(),
  description: z.string().optional(),
})
