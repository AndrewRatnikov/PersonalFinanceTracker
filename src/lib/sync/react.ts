// React access to sync. With ENABLE_SYNC off these hooks never touch the
// runtime: the state is OFF_SYNC_STATE and sync is unavailable. The Family
// hooks also need ENABLE_SPACES (read inside the hooks only, never at import)
// and visible accounts; otherwise they return OFF_FAMILY_STATE.

import { useMemo, useSyncExternalStore } from 'react'

import { getSyncRuntime } from './runtime'
import type { FamilySyncState, SyncState } from './types'
import { useAccountsVisible } from '@/lib/accountSession'
import { ENABLE_SPACES, ENABLE_SYNC } from '@/lib/featureFlags'

export const OFF_SYNC_STATE: SyncState = {
  status: 'off',
  lastSyncAt: null,
  progress: null,
  errorCode: null,
  lastError: null,
  deviceId: null,
}

export const OFF_FAMILY_STATE: FamilySyncState = {
  status: 'none',
  spaceId: null,
  role: null,
  name: null,
  readOnly: false,
  space: null,
  lastSyncAt: null,
  progress: null,
  errorCode: null,
  lastError: null,
  pendingOwnerEmail: null,
}

const subscribeNothing = () => () => undefined
const offState = () => OFF_SYNC_STATE
const offFamilyState = () => OFF_FAMILY_STATE

// Sync UI shows only with the flag on and the account UI visible.
export function useSyncAvailable(): boolean {
  const accountsVisible = useAccountsVisible()
  return ENABLE_SYNC && accountsVisible
}

// Family UI shows only with both flags on and the account UI visible.
export function useFamilyAvailable(): boolean {
  const accountsVisible = useAccountsVisible()
  return ENABLE_SPACES && ENABLE_SYNC && accountsVisible
}

export function useFamilySyncState(): FamilySyncState {
  const available = useFamilyAvailable()
  const family = available ? getSyncRuntime().family : null
  const store = useMemo(
    () =>
      family
        ? {
            subscribe: (listener: () => void) => family.subscribe(listener),
            getState: () => family.getState(),
          }
        : { subscribe: subscribeNothing, getState: offFamilyState },
    [family],
  )
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

// The personal sync state (unchanged); with a space id, the Family state of
// that space (OFF_FAMILY_STATE for any other space, or without the flags).
// ENABLE_SPACES is read only when a space id is given.
// (The no-argument signature is last, so vi.mocked(useSyncState) keeps the
// personal types in the existing tests.)
export function useSyncState(spaceId: string): FamilySyncState
export function useSyncState(): SyncState
export function useSyncState(spaceId?: string): SyncState | FamilySyncState {
  const family =
    spaceId !== undefined && ENABLE_SPACES && ENABLE_SYNC ? getSyncRuntime().family : null
  const engine = spaceId === undefined && ENABLE_SYNC ? getSyncRuntime().engine : null
  const store = useMemo((): {
    subscribe: (listener: () => void) => () => void
    getState: () => SyncState | FamilySyncState
  } => {
    if (spaceId !== undefined) {
      if (!family) return { subscribe: subscribeNothing, getState: offFamilyState }
      return {
        subscribe: (listener) => family.subscribe(listener),
        getState: () => {
          const current = family.getState()
          return current.spaceId === spaceId ? current : OFF_FAMILY_STATE
        },
      }
    }
    return engine
      ? {
          subscribe: (listener) => engine.subscribe(listener),
          getState: () => engine.getState(),
        }
      : { subscribe: subscribeNothing, getState: offState }
  }, [engine, family, spaceId])
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
