// Layer 2 of src/lib/db: the commit hook (lastDataChangeAt) and the
// conversion trigger.

import { get, set } from 'idb-keyval'

import { markKeyringStale } from '../spaces/keyring'
import { postChanged } from '../syncChannel'
import { withWriteLock } from '../writeLock'
import {
  META_SETTINGS_KEY,
  SPACE_KEYS_KEY,
  SYNCED_SETTINGS_KEY,
  store,
} from './context'
import { nowIso } from './records'
import { EXPENSE_CHUNK_KEY_RE } from './storage'
import type { SpaceCtx } from './context'

// ── Commit hook: lastDataChangeAt (§6.2) ──────────────────────────────────────

// Records the time of the last committed data change in the plaintext
// `meta:settings` object (merged, other fields kept). The data write has
// already committed, so a failure here is logged and never fails the mutation.
export async function markDataChanged(): Promise<void> {
  const s = store
  if (!s) return
  try {
    await withWriteLock(META_SETTINGS_KEY, async () => {
      const raw = await get<unknown>(META_SETTINGS_KEY, s)
      const stored = raw && typeof raw === 'object' ? raw : {}
      await set(
        META_SETTINGS_KEY,
        { ...stored, lastDataChangeAt: nowIso() },
        s,
      )
    })
  } catch (err) {
    console.error('Could not record the data change time:', err)
  }
}

// ── Conversion trigger (in-tab) ───────────────────────────────────────────────

const conversionListeners = new Set<() => void>()

// Registers a listener for "entries may need converting". Returns the
// unsubscribe function.
export function onConversionNeeded(listener: () => void): () => void {
  conversionListeners.add(listener)
  return () => {
    conversionListeners.delete(listener)
  }
}

// Calls every listener; a throwing listener is logged and never stops the
// others (or the write that triggered it).
export function requestEntryConversion(): void {
  for (const listener of Array.from(conversionListeners)) {
    try {
      listener()
    } catch (err) {
      console.error('Conversion listener failed:', err)
    }
  }
}

function isEntryKey(key: string): boolean {
  return key === 'income' || EXPENSE_CHUNK_KEY_RE.test(key)
}

// Runs after every committed data mutation (not after quarantine). Writes to
// entry keys or to the synced settings request a conversion, except the
// converter's own. `dataChange: false` skips lastDataChangeAt (the converter's
// background writes).
// `changedKeys` are base keys; a Family commit announces them with its
// spaceId (personal messages are unchanged). A write of the personal
// spaceKeys marks the keyring stale.
export async function afterCommit(
  ctx: SpaceCtx,
  changedKeys: Array<string>,
  opts: { fromConversion?: boolean; dataChange?: boolean } = {},
): Promise<void> {
  if (ctx.personal) {
    postChanged(changedKeys)
    if (changedKeys.includes(SPACE_KEYS_KEY)) markKeyringStale()
  } else {
    postChanged(changedKeys, ctx.spaceId)
  }
  // A Family write touches only its own space's keys: the device-level
  // lastDataChangeAt (backup reminder) follows personal writes.
  if (ctx.personal && opts.dataChange !== false) await markDataChanged()
  if (
    !opts.fromConversion &&
    changedKeys.some((k) => isEntryKey(k) || k === SYNCED_SETTINGS_KEY)
  ) {
    requestEntryConversion()
  }
}
