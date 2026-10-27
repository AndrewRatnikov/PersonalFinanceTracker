// "Sign in to restore your data" (spec §19): after Google sign-in the app comes
// back to `/?restore=sync`, and the create-vault gate opens straight on the
// sync restore screen. The request is a one-shot in-memory flag.

import { ENABLE_SYNC } from '@/lib/featureFlags'

export const SYNC_RESTORE_PARAM = 'restore'
const SYNC_RESTORE_VALUE = 'sync'

let requested = false

export function requestSyncRestore(): void {
  requested = true
}

// True once after a request, then false until the next one.
export function consumeSyncRestoreRequest(): boolean {
  const was = requested
  requested = false
  return was
}

// Requests a restore when sync is enabled and the search string carries
// `restore=sync`. Returns whether it did.
export function requestSyncRestoreFromUrl(search: string): boolean {
  if (!ENABLE_SYNC) return false
  if (new URLSearchParams(search).get(SYNC_RESTORE_PARAM) !== SYNC_RESTORE_VALUE) {
    return false
  }
  requestSyncRestore()
  return true
}
