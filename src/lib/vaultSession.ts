// Client-side vault session (spec §2.1, §2.2, §2.4): which phase the local
// vault is in, and whether the user asked to create one. The root route, the
// Header and the Landing page all decide what to show from this store.

import { useSyncExternalStore } from 'react'

import { startAutoLock } from './autoLock'
import { reloadToHome } from './localWipe'
import { listenForLockAndWipe, postLock } from './syncChannel'
import { lockVault } from './vault'
import type { QueryClient } from '@tanstack/react-query'
import type { SyncChannel } from './syncChannel'
import type { VaultState } from './vault'

export type VaultPhase = 'checking' | 'none' | 'locked' | 'unlocked'

export interface VaultSessionState {
  phase: VaultPhase
  createRequested: boolean
}

export const DATA_ROUTES: ReadonlyArray<string> = [
  '/analytics',
  '/transactions',
  '/income',
  '/settings',
]

export function isDataRoute(pathname: string): boolean {
  return DATA_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  )
}

export function phaseForVaultState(state: VaultState): VaultPhase {
  // v1, v2 and orphaned all go to the gate, which picks Unlock or Recovery.
  return state === 'none' ? 'none' : 'locked'
}

const INITIAL_STATE: VaultSessionState = {
  phase: 'checking',
  createRequested: false,
}

let state: VaultSessionState = INITIAL_STATE
const listeners = new Set<() => void>()

function update(next: VaultSessionState): void {
  if (
    next.phase === state.phase &&
    next.createRequested === state.createRequested
  ) {
    return
  }
  state = next
  for (const listener of Array.from(listeners)) listener()
}

export function getVaultSession(): VaultSessionState {
  return state
}

export function setVaultPhase(phase: VaultPhase): void {
  update({
    phase,
    createRequested: phase === 'unlocked' ? false : state.createRequested,
  })
}

export function requestCreateVault(): void {
  update({ ...state, createRequested: true })
}

export function cancelCreateVault(): void {
  update({ ...state, createRequested: false })
}

export function subscribeVaultSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getServerSnapshot(): VaultSessionState {
  return INITIAL_STATE
}

export function useVaultSession(): VaultSessionState {
  return useSyncExternalStore(
    subscribeVaultSession,
    getVaultSession,
    getServerSnapshot,
  )
}

export function computeGate(input: {
  mounted: boolean
  phase: VaultPhase
  createRequested: boolean
  pathname: string
}): { showGate: boolean; showChildren: boolean } {
  const { mounted, phase, createRequested, pathname } = input
  return {
    showGate:
      mounted && (phase === 'locked' || (phase === 'none' && createRequested)),
    // Non-data routes keep rendering under the overlay (the OAuth callback
    // must still run while locked). Data routes wait for the unlock so their
    // queries never run without a key.
    showChildren: !mounted || phase === 'unlocked' || !isDataRoute(pathname),
  }
}

// Locks this tab: forgets the key, drops every cached query and shows the
// gate. Never deletes stored data, and never turns "no vault" into "locked".
export function lockApp(
  queryClient: Pick<QueryClient, 'clear'>,
  options: { broadcast?: boolean } = {},
): void {
  lockVault()
  queryClient.clear()
  if (state.phase === 'unlocked') setVaultPhase('locked')
  if (options.broadcast !== false) postLock()
}

// Auto-lock locks only the idle tab: it never broadcasts, so an idle tab can't
// lock a tab that is still in use. A manual lock (lockApp with the default
// `broadcast`) locks every tab (spec §2.4).
export function startTabAutoLock(
  minutes: number,
  queryClient: Pick<QueryClient, 'clear'>,
  doc?: Document,
): () => void {
  const onLock = () => lockApp(queryClient, { broadcast: false })
  return doc === undefined
    ? startAutoLock(minutes, onLock)
    : startAutoLock(minutes, onLock, doc)
}

// Reacts to `lock` / `wiped` from other tabs. A wipe also reloads to the home
// page (by default), which drops all in-memory state.
export function connectOtherTabs(
  queryClient: Pick<QueryClient, 'clear'>,
  options: { onWiped?: () => void; channel?: SyncChannel | null } = {},
): () => void {
  return listenForLockAndWipe(
    {
      onLock: () => lockApp(queryClient, { broadcast: false }),
      onWiped: () => {
        lockApp(queryClient, { broadcast: false })
        ;(options.onWiped ?? reloadToHome)()
      },
    },
    options.channel,
  )
}
