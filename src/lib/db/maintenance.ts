// Layer 3 of src/lib/db: quarantine and orphan detection.

import { del, get, keys, set } from 'idb-keyval'

import { isAnyDataStorageKey, isDataStorageKey } from '../dataErrors'
import { parseSpaceStorageKey } from '../spaces/types'
import { postChanged } from '../syncChannel'
import { withWriteLock } from '../writeLock'
import { store } from './context'
import { nowIso } from './records'

// ── Quarantine and orphan detection ───────────────────────────────────────────

// Moves the raw stored value of a data key, unchanged, to
// `quarantine:<key>:<ISO timestamp>`, then deletes the original. The original
// is only deleted after the copy has been written. Needs no unlock key.
// Family data keys (`space:<id>:<key>`) are quarantined the same way.
export async function quarantineKey(
  storageKey: string,
): Promise<string | null> {
  if (!isAnyDataStorageKey(storageKey)) {
    throw new Error(`quarantineKey: not a data key "${storageKey}"`)
  }
  const s = store
  if (!s) return null
  const qKey = await withWriteLock(storageKey, async () => {
    const raw = await get<unknown>(storageKey, s)
    if (raw === undefined) return null
    const target = `quarantine:${storageKey}:${nowIso()}`
    await set(target, raw, s)
    await del(storageKey, s)
    return target
  })
  if (qKey !== null) {
    const family = parseSpaceStorageKey(storageKey)
    if (family) postChanged([family.baseKey], family.spaceId)
    else postChanged([storageKey])
  }
  return qKey
}

// True if the store holds any personal data key in the current format
// (quarantine copies alone do not count). Works before unlock.
export async function hasLocalData(): Promise<boolean> {
  if (!store) return false
  const allKeys = await keys(store)
  return allKeys.some((k) => typeof k === 'string' && isDataStorageKey(k))
}
