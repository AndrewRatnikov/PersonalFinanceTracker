// Errors and key helpers for the encrypted local store. This module has no
// dependencies so UI code can use it without pulling in localDb.

export class DecryptError extends Error {
  readonly storageKey: string
  constructor(storageKey: string, cause?: unknown) {
    super(`Could not decrypt local data "${storageKey}"`, { cause })
    this.name = 'DecryptError'
    this.storageKey = storageKey
  }
}

export function isDecryptError(err: unknown): err is DecryptError {
  if (err instanceof DecryptError) return true
  return (
    err instanceof Error &&
    err.name === 'DecryptError' &&
    typeof (err as { storageKey?: unknown }).storageKey === 'string'
  )
}

const EXPENSE_CHUNK_RE = /^expenses_(\d{4})_(\d{2})$/

const SINGLE_KEY_LABELS: Record<string, string> = {
  categories: 'Categories',
  income: 'Income',
  budgets: 'Budgets',
}

// True for the keys that hold user data in the current (v1) format.
// Quarantine copies (`quarantine:<key>:<ISO>`) and anything else are not data keys.
export function isDataStorageKey(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(SINGLE_KEY_LABELS, key) ||
    EXPENSE_CHUNK_RE.test(key)
  )
}

// 'expenses_2026_03' -> 'Expenses · 2026-03', 'categories' -> 'Categories', ...
export function storageKeyLabel(key: string): string {
  const match = EXPENSE_CHUNK_RE.exec(key)
  if (match) return `Expenses · ${match[1]}-${match[2]}`
  if (Object.prototype.hasOwnProperty.call(SINGLE_KEY_LABELS, key)) {
    return SINGLE_KEY_LABELS[key]
  }
  return key
}
