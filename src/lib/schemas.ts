import { z } from 'zod'

import { CURRENCIES } from './domain'

export const createIncomeSchema = z.object({
  source: z.string().min(1, 'Source is required'),
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.enum(CURRENCIES),
  description: z.string().optional(),
})

export const createExpenseSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.enum(CURRENCIES),
  categoryId: z.string().min(1, 'Category is required'),
  description: z.string().optional(),
})

export const updateExpenseSchema = createExpenseSchema.extend({
  createdAt: z
    .string()
    .min(1, 'Date is required')
    .refine((s) => !isNaN(new Date(s).getTime()), 'Invalid date'),
})

export type UpdateExpenseFormValues = z.infer<typeof updateExpenseSchema>
