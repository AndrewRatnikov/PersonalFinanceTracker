import { getAllBudgets, getAllCategories, getAllExpenses, getAllIncome } from './localDb'

function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? '')
  return `"${str.replace(/"/g, '""')}"`
}

function triggerDownload(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function exportAllLocalData(): Promise<void> {
  const [expenses, categories, income, budgets] = await Promise.all([
    getAllExpenses(),
    getAllCategories(),
    getAllIncome(),
    getAllBudgets(),
  ])

  // expenses.csv — date, amount, currency, category, description
  const expenseRows = expenses.map((e) => {
    const date = e.createdAt.slice(0, 10)
    const category = e.category?.name ?? ''
    return [date, e.amount, e.currency, category, e.description ?? ''].map(csvEscape).join(',')
  })
  triggerDownload(
    'expenses.csv',
    ['"date","amount","currency","category","description"', ...expenseRows].join('\n'),
  )

  // income.csv — date, source, amount, currency, description
  const incomeRows = income.map((i) => {
    const date = i.createdAt.slice(0, 10)
    return [date, i.source, i.amount, i.currency, i.description ?? ''].map(csvEscape).join(',')
  })
  triggerDownload(
    'income.csv',
    ['"date","source","amount","currency","description"', ...incomeRows].join('\n'),
  )

  // categories.csv — name, icon
  const categoryRows = categories.map((c) =>
    [c.name, c.icon ?? ''].map(csvEscape).join(','),
  )
  triggerDownload('categories.csv', ['"name","icon"', ...categoryRows].join('\n'))

  // budgets.csv — category, monthly_limit, currency
  const budgetRows = budgets.map((b) =>
    [b.categoryName, b.monthlyLimit, b.currency].map(csvEscape).join(','),
  )
  triggerDownload(
    'budgets.csv',
    ['"category","monthly_limit","currency"', ...budgetRows].join('\n'),
  )
}
