import { createStore, get, set, clear } from 'idb-keyval'

import type { Category, Expense, MonthlyExpenseSummary } from './domain'

interface OfflineCacheMap {
  recentExpenses: Array<Expense>
  categories: Array<Category>
  monthlyStats: Array<MonthlyExpenseSummary>
}

export type OfflineCacheKey = keyof OfflineCacheMap

const store =
  typeof window !== 'undefined'
    ? createStore('minima-offline', 'cache')
    : null

export async function getOfflineCache<K extends OfflineCacheKey>(
  key: K,
): Promise<OfflineCacheMap[K] | undefined> {
  if (!store) return undefined
  return get<OfflineCacheMap[K]>(key, store)
}

export async function setOfflineCache<K extends OfflineCacheKey>(
  key: K,
  value: OfflineCacheMap[K],
): Promise<void> {
  if (!store) return
  await set(key, value, store)
}

export async function clearOfflineCache(): Promise<void> {
  if (!store) return
  await clear(store)
}
