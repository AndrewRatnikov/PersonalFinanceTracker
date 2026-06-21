import dayjs from 'dayjs'
import {
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  bulkSeedExpenses,
  bulkSeedIncome,
  upsertBudget,
} from './localDb'

function daysAgo(n: number): string {
  return dayjs().subtract(n, 'day').toISOString()
}

export async function seedTestData(): Promise<{ expenses: number; income: number; budgets: number }> {
  const [categories, existingExpenses, existingIncome] = await Promise.all([
    getAllCategories(),
    getAllExpenses(),
    getAllIncome(),
  ])

  if (existingExpenses.length > 0 || existingIncome.length > 0) {
    throw new Error('Data already exists. Clear all data first before seeding.')
  }

  const byName = (name: string) =>
    categories.find((c) => c.name === name)?.id ?? categories[0]?.id ?? ''

  const food = byName('Food')
  const transport = byName('Transport')
  const rent = byName('Rent')
  const coffee = byName('Coffee')
  const entertainment = byName('Entertainment')
  const server = byName('Server Costs')

  const expenseSeed = [
    // This month
    { amount: 340, currency: 'UAH' as const, categoryId: food, description: 'Grocery run', daysAgo: 1 },
    { amount: 45, currency: 'UAH' as const, categoryId: coffee, description: 'Morning latte', daysAgo: 2 },
    { amount: 89, currency: 'UAH' as const, categoryId: transport, description: 'Uber to office', daysAgo: 3 },
    { amount: 210, currency: 'UAH' as const, categoryId: food, description: 'Restaurant with friends', daysAgo: 4 },
    { amount: 12, currency: 'USD' as const, categoryId: server, description: 'Vercel subscription', daysAgo: 5 },
    { amount: 55, currency: 'UAH' as const, categoryId: coffee, description: 'Café work session', daysAgo: 6 },
    { amount: 180, currency: 'UAH' as const, categoryId: entertainment, description: 'Cinema tickets', daysAgo: 7 },
    { amount: 430, currency: 'UAH' as const, categoryId: food, description: 'Weekly groceries', daysAgo: 9 },
    { amount: 120, currency: 'UAH' as const, categoryId: transport, description: 'Monthly metro top-up', daysAgo: 10 },
    { amount: 40, currency: 'UAH' as const, categoryId: coffee, description: 'Cold brew', daysAgo: 11 },
    { amount: 8500, currency: 'UAH' as const, categoryId: rent, description: 'June rent', daysAgo: 12 },
    { amount: 95, currency: 'UAH' as const, categoryId: food, description: 'Lunch delivery', daysAgo: 14 },
    // Last month
    { amount: 380, currency: 'UAH' as const, categoryId: food, description: 'Grocery run', daysAgo: 33 },
    { amount: 50, currency: 'UAH' as const, categoryId: coffee, description: 'Office coffee', daysAgo: 34 },
    { amount: 75, currency: 'UAH' as const, categoryId: transport, description: 'Taxi home', daysAgo: 35 },
    { amount: 320, currency: 'UAH' as const, categoryId: entertainment, description: 'Concert tickets', daysAgo: 36 },
    { amount: 12, currency: 'USD' as const, categoryId: server, description: 'Vercel subscription', daysAgo: 38 },
    { amount: 8500, currency: 'UAH' as const, categoryId: rent, description: 'May rent', daysAgo: 40 },
    { amount: 145, currency: 'UAH' as const, categoryId: food, description: 'Sushi delivery', daysAgo: 42 },
    { amount: 60, currency: 'UAH' as const, categoryId: coffee, description: 'Coffee beans', daysAgo: 44 },
    { amount: 200, currency: 'UAH' as const, categoryId: transport, description: 'Train tickets', daysAgo: 45 },
    { amount: 410, currency: 'UAH' as const, categoryId: food, description: 'Weekly groceries', daysAgo: 47 },
    { amount: 550, currency: 'UAH' as const, categoryId: entertainment, description: 'Netflix + Spotify', daysAgo: 49 },
    { amount: 80, currency: 'UAH' as const, categoryId: food, description: 'Breakfast cafe', daysAgo: 55 },
    // Two months ago
    { amount: 8500, currency: 'UAH' as const, categoryId: rent, description: 'April rent', daysAgo: 70 },
    { amount: 390, currency: 'UAH' as const, categoryId: food, description: 'Grocery run', daysAgo: 62 },
    { amount: 12, currency: 'USD' as const, categoryId: server, description: 'Vercel subscription', daysAgo: 65 },
    { amount: 250, currency: 'UAH' as const, categoryId: entertainment, description: 'Board game cafe', daysAgo: 67 },
    { amount: 45, currency: 'UAH' as const, categoryId: coffee, description: 'Morning coffee', daysAgo: 68 },
    { amount: 160, currency: 'UAH' as const, categoryId: transport, description: 'Uber trips', daysAgo: 72 },
    { amount: 490, currency: 'UAH' as const, categoryId: food, description: 'Weekly groceries', daysAgo: 75 },
    { amount: 85, currency: 'UAH' as const, categoryId: coffee, description: 'Specialty coffee shop', daysAgo: 78 },
    { amount: 300, currency: 'UAH' as const, categoryId: entertainment, description: 'Museum + art gallery', daysAgo: 80 },
    { amount: 100, currency: 'UAH' as const, categoryId: transport, description: 'Monthly metro', daysAgo: 82 },
    { amount: 200, currency: 'UAH' as const, categoryId: food, description: 'Dinner out', daysAgo: 85 },
  ]

  const incomeSeed = [
    { source: 'Salary', amount: 85000, currency: 'UAH' as const, description: 'June salary', daysAgo: 1 },
    { source: 'Freelance', amount: 1200, currency: 'USD' as const, description: 'Web project payment', daysAgo: 15 },
    { source: 'Salary', amount: 85000, currency: 'UAH' as const, description: 'May salary', daysAgo: 32 },
    { source: 'Freelance', amount: 800, currency: 'USD' as const, description: 'Design consultation', daysAgo: 50 },
    { source: 'Salary', amount: 85000, currency: 'UAH' as const, description: 'April salary', daysAgo: 62 },
    { source: 'Dividends', amount: 500, currency: 'USD' as const, description: 'Q1 dividends', daysAgo: 75 },
  ]

  const budgetSeed = [
    { categoryId: food, monthlyLimit: 4000, currency: 'UAH' as const },
    { categoryId: coffee, monthlyLimit: 500, currency: 'UAH' as const },
    { categoryId: transport, monthlyLimit: 600, currency: 'UAH' as const },
    { categoryId: entertainment, monthlyLimit: 1500, currency: 'UAH' as const },
    { categoryId: server, monthlyLimit: 20, currency: 'USD' as const },
  ]

  await bulkSeedExpenses(
    expenseSeed.map((e) => ({
      amount: e.amount,
      currency: e.currency,
      categoryId: e.categoryId,
      description: e.description,
      createdAt: daysAgo(e.daysAgo),
    })),
  )

  await bulkSeedIncome(
    incomeSeed.map((i) => ({
      source: i.source,
      amount: i.amount,
      currency: i.currency,
      description: i.description,
      createdAt: daysAgo(i.daysAgo),
    })),
  )

  await Promise.all(budgetSeed.map((b) => upsertBudget(b)))

  return {
    expenses: expenseSeed.length,
    income: incomeSeed.length,
    budgets: budgetSeed.length,
  }
}
