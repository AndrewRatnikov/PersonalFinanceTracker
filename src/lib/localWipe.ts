// "Remove data from this device" (spec §2.5). The store is emptied first, so
// the data is gone even if the database deletion stays blocked by the open
// idb-keyval connection; the caller then reloads, which closes it.

import { clearLocalDb } from './localDb'
import { postWiped } from './syncChannel'
import { lockVault } from './vault'

export const LOCAL_DB_NAME = 'minima-local'
export const LOCAL_STORAGE_PREFIX = 'minima_'

export function removeMinimaLocalStorageKeys(): void {
  if (typeof localStorage === 'undefined') return
  const doomed: Array<string> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key !== null && key.startsWith(LOCAL_STORAGE_PREFIX)) doomed.push(key)
  }
  for (const key of doomed) localStorage.removeItem(key)
}

function requestDatabaseDeletion(): void {
  try {
    if (typeof indexedDB === 'undefined') return
    // Not awaited: the request completes once every connection has closed.
    indexedDB.deleteDatabase(LOCAL_DB_NAME)
  } catch {
    // The store is already empty; a failed deletion leaves nothing behind.
  }
}

export async function wipeLocalData(): Promise<void> {
  lockVault()
  await clearLocalDb()
  removeMinimaLocalStorageKeys()
  postWiped()
  requestDatabaseDeletion()
}

export function reloadToHome(): void {
  window.location.replace('/')
}
