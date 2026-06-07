import { z } from 'zod'

import { CURRENCIES } from './domain'

export const createIncomeSchema = z.object({
  source: z.string().min(1, 'Source is required'),
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.enum(CURRENCIES),
  description: z.string().optional(),
})

export const upsertBudgetSchema = z.object({
  categoryId: z.string().min(1, 'Category is required'),
  monthlyLimit: z.number().positive('Monthly limit must be greater than 0'),
  currency: z.enum(CURRENCIES),
})

export const createExpenseSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.enum(CURRENCIES),
  categoryId: z.string(),
  description: z.string().optional(),
})
