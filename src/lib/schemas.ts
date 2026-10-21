import { z } from 'zod'

import { CURRENCIES } from './domain'

// Every message is a catalog key (errors.validation.*), never text: the UI
// shows it with validationMessage() from src/i18n/errors.ts, in the UI
// language. Schemas stay pure and import nothing from i18n.

export const createIncomeSchema = z.object({
  categoryId: z.string().min(1, 'errors.validation.categoryRequired'),
  amount: z.number().positive('errors.validation.amountPositive'),
  currency: z.enum(CURRENCIES),
  description: z.string().optional(),
})

export const createExpenseSchema = z.object({
  amount: z.number().positive('errors.validation.amountPositive'),
  currency: z.enum(CURRENCIES),
  categoryId: z.string().min(1, 'errors.validation.categoryRequired'),
  description: z.string().optional(),
})

export const updateExpenseSchema = createExpenseSchema.extend({
  createdAt: z
    .string()
    .min(1, 'errors.validation.dateRequired')
    .refine((s) => !isNaN(new Date(s).getTime()), 'errors.validation.invalidDate'),
})

export type UpdateExpenseFormValues = z.infer<typeof updateExpenseSchema>

// ── Recurring items ───────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// A real calendar date written as YYYY-MM-DD (2027-02-29 and 2026-02-30 fail).
function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (!match) return false
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  )
}

const calendarDate = z.string().refine(isCalendarDate, 'errors.validation.invalidDate')

const INTERVAL_MESSAGE = 'errors.validation.intervalRange'

export const recurringInputSchema = z
  .object({
    kind: z.enum(['expense', 'income']),
    amount: z.number().positive('errors.validation.amountPositive'),
    currency: z.enum(CURRENCIES),
    categoryId: z.string().min(1, 'errors.validation.categoryRequired'),
    description: z.string().nullable().optional(),
    frequency: z.object({
      unit: z.enum(['day', 'week', 'month', 'year']),
      interval: z
        .number()
        .int(INTERVAL_MESSAGE)
        .min(1, INTERVAL_MESSAGE)
        .max(365, INTERVAL_MESSAGE),
    }),
    startDate: calendarDate,
    end: z.discriminatedUnion('type', [
      z.object({ type: z.literal('never') }),
      z.object({ type: z.literal('onDate'), date: calendarDate }),
      z.object({
        type: z.literal('afterCount'),
        count: z
          .number()
          .int('errors.validation.wholeNumber')
          .min(1, 'errors.validation.atLeastOne'),
      }),
    ]),
    mode: z.enum(['auto', 'ask']),
  })
  .superRefine((value, ctx) => {
    // zod runs this even when a field had a non-fatal issue, so check shapes.
    const end = value.end as { type?: unknown; date?: unknown } | undefined
    if (
      end?.type === 'onDate' &&
      typeof end.date === 'string' &&
      typeof value.startDate === 'string' &&
      isCalendarDate(end.date) &&
      isCalendarDate(value.startDate) &&
      end.date < value.startDate
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'errors.validation.endBeforeStart',
      })
    }
  })

export type RecurringFormValues = z.infer<typeof recurringInputSchema>

// recurringInputSchema plus: the categoryId must be one of `categoryIds` (the
// categories of the item's kind).
export function recurringInputSchemaFor(categoryIds: ReadonlyArray<string>) {
  const known = new Set(categoryIds)
  return recurringInputSchema.superRefine((value, ctx) => {
    if (
      typeof value.categoryId === 'string' &&
      value.categoryId !== '' &&
      !known.has(value.categoryId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'errors.validation.categoryNotFound',
      })
    }
  })
}
