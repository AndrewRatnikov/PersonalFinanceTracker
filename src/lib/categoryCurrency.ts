// The per-category default currency. Pure. Every form goes through
// currencyForCategory; nothing reads category.defaultCurrency directly, because
// a restored backup could hold any value in that field.

import { isCurrency } from './domain'
import type { Category, Currency } from './domain'

export function categoryDefaultCurrency(
  category: Pick<Category, 'defaultCurrency'> | null | undefined,
): Currency | undefined {
  const value: unknown = category?.defaultCurrency
  return isCurrency(value) ? value : undefined
}

export function currencyForCategory(
  category: Pick<Category, 'defaultCurrency'> | null | undefined,
  mainCurrency: Currency,
): Currency {
  return categoryDefaultCurrency(category) ?? mainCurrency
}
