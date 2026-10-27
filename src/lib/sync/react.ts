// React access to sync. With ENABLE_SYNC off these hooks never touch the
// runtime: the state is OFF_SYNC_STATE and sync is unavailable.

import { useMemo, useSyncExternalStore } from 'react'

import { getSyncRuntime } from './runtime'
import type { SyncState } from './types'
import { useAccountsVisible } from '@/lib/accountSession'
import { ENABLE_SYNC } from '@/lib/featureFlags'

export const OFF_SYNC_STATE: SyncState = {
  status: 'off',
  lastSyncAt: null,
  progress: null,
  errorCode: null,
  lastError: null,
  deviceId: null,
}

const subscribeNothing = () => () => undefined
const offState = () => OFF_SYNC_STATE

// Sync UI shows only with the flag on and the account UI visible.
export function useSyncAvailable(): boolean {
  const accountsVisible = useAccountsVisible()
  return ENABLE_SYNC && accountsVisible
}

export function useSyncState(): SyncState {
  const engine = ENABLE_SYNC ? getSyncRuntime().engine : null
  const store = useMemo(
    () =>
      engine
        ? {
            subscribe: (listener: () => void) => engine.subscribe(listener),
            getState: () => engine.getState(),
          }
        : { subscribe: subscribeNothing, getState: offState },
    [engine],
  )
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
