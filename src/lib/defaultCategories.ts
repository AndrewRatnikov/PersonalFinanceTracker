// The default expense and income categories written into a new vault, per UI
// language. Once written they are user data and are never renamed.

import type { Lang } from '../i18n/lang'

type DefaultCategory = { name: string; icon: string }

const EXPENSE: Record<Lang, ReadonlyArray<DefaultCategory>> = {
  en: [
    { name: 'Food', icon: '🍔' },
    { name: 'Transport', icon: '🚌' },
    { name: 'Rent', icon: '🏠' },
    { name: 'Coffee', icon: '☕' },
    { name: 'Entertainment', icon: '🎬' },
    { name: 'Server Costs', icon: '🖥️' },
  ],
  uk: [
    { name: 'Їжа', icon: '🍔' },
    { name: 'Транспорт', icon: '🚌' },
    { name: 'Оренда', icon: '🏠' },
    { name: 'Кава', icon: '☕' },
    { name: 'Розваги', icon: '🎬' },
    { name: 'Сервери', icon: '🖥️' },
  ],
}

// The last entry is the "Other" fallback for income without a source.
const INCOME: Record<Lang, ReadonlyArray<DefaultCategory>> = {
  en: [
    { name: 'Salary', icon: '💼' },
    { name: 'Freelance', icon: '💻' },
    { name: 'Gifts', icon: '🎁' },
    { name: 'Investments', icon: '📈' },
    { name: 'Refunds', icon: '↩️' },
    { name: 'Other', icon: '🪙' },
  ],
  uk: [
    { name: 'Зарплата', icon: '💼' },
    { name: 'Фриланс', icon: '💻' },
    { name: 'Подарунки', icon: '🎁' },
    { name: 'Інвестиції', icon: '📈' },
    { name: 'Повернення', icon: '↩️' },
    { name: 'Інше', icon: '🪙' },
  ],
}

export function defaultExpenseCategories(lang: Lang): ReadonlyArray<DefaultCategory> {
  return EXPENSE[lang]
}

export function defaultIncomeCategories(lang: Lang): ReadonlyArray<DefaultCategory> {
  return INCOME[lang]
}
