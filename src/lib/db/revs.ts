// Layer 1 of src/lib/db: the meta:sync change counter.

import { get } from 'idb-keyval'

import { PERSONAL_SPACE_ID, keyFor } from '../spaces/types'
import { SYNC_META_KEY, memberFor, storageKeyOf, store } from './context'
import type { SpaceId } from '../spaces/types'
import type { SpaceCtx } from './context'

// ── The change counter (meta:sync) ────────────────────────────────────────────

export function parseLocalRev(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0
  const value = (raw as { localRev?: unknown }).localRev
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0
}

// The plaintext change counter of a space (`meta:sync` of the space). Works
// before unlock.
export async function getLocalRevIn(ctx: SpaceCtx): Promise<number> {
  if (!store) return 0
  return parseLocalRev(await get<unknown>(storageKeyOf(ctx, SYNC_META_KEY), store))
}

export interface RevCounter {
  next: () => number
  readonly changed: boolean
  readonly last: number
  /** localRev before this write: records with a higher rev are this write's. */
  readonly start: number
  /** The storage key of the space's meta:sync. */
  readonly metaKey: string
  /** The stored meta:sync object (its sync fields are written back unchanged). */
  readonly base: Record<string, unknown>
  /** Family: the writing member (null = unknown). Personal: undefined. */
  readonly member: string | null | undefined
}

// Only called inside a lock that includes the space's SYNC_META_KEY. Nothing
// is written until writeKeysMany commits the counter together with the data.
// A Family counter also carries the current member id for the stamps.
export async function openRevCounter(ctx: SpaceCtx): Promise<RevCounter> {
  const metaKey = storageKeyOf(ctx, SYNC_META_KEY)
  const raw = store ? await get<unknown>(metaKey, store) : undefined
  const start = parseLocalRev(raw)
  const base = asObject(raw) ?? {}
  const member = await memberFor(ctx)
  let last = start
  return {
    next: () => ++last,
    get changed() {
      return last !== start
    },
    get last() {
      return last
    },
    start,
    metaKey,
    base,
    member,
  }
}

// The meta:sync entry for a write that advanced the counter to `localRev`:
// the stored object (sync fields kept) with localRev replaced. Exactly
// `{ localRev }` when nothing else is stored. Must be called inside a lock that
// holds the space's SYNC_META_KEY. Personal by default.
export async function syncMetaEntry(
  localRev: number,
  spaceId: SpaceId = PERSONAL_SPACE_ID,
): Promise<[string, Record<string, unknown>]> {
  const metaKey = keyFor(spaceId, SYNC_META_KEY)
  const raw = store ? await get<unknown>(metaKey, store) : undefined
  return [metaKey, { ...(asObject(raw) ?? {}), localRev }]
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
