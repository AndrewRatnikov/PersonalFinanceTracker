/**
 * Typed, SSR-safe wrapper around localStorage.
 * Add new keys and their value types to the `LocalStore` interface.
 */

export interface LocalStore {
  categoriesProvisioned: boolean
}

type Key = keyof LocalStore

function storageKey(userId: string, key: Key): string {
  return `minima_${userId}_${key}`
}

export function getLocalStore<K extends Key>(
  userId: string,
  key: K,
): LocalStore[K] | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(storageKey(userId, key))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as LocalStore[K]
  } catch {
    return null
  }
}

export function setLocalStore<K extends Key>(
  userId: string,
  key: K,
  value: LocalStore[K],
): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(storageKey(userId, key), JSON.stringify(value))
}

export function removeLocalStore(userId: string, key: Key): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(storageKey(userId, key))
}
