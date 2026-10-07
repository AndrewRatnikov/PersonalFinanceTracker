import { useSyncExternalStore } from 'react'

import type { DecryptError } from './dataErrors'

// The current "data problem": the first DecryptError reported by a query, a
// mutation or the error boundary. While set, the app shows the Data problem
// screen instead of the routes.

export type DataProblem = { storageKey: string; error: DecryptError }

let current: DataProblem | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getDataProblem(): DataProblem | null {
  return current
}

// The first report wins until cleared; later reports are ignored.
export function reportDataProblem(error: DecryptError): void {
  if (current) return
  current = { storageKey: error.storageKey, error }
  emit()
}

export function clearDataProblem(): void {
  if (!current) return
  current = null
  emit()
}

export function subscribeDataProblem(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDataProblem(): DataProblem | null {
  return useSyncExternalStore(subscribeDataProblem, getDataProblem, () => null)
}
