// Pure rules shared by backup restore now and the sync engine later. Nothing
// here touches storage: localDb and backup import these, never the reverse.
//
// - isLive: a record is live unless it carries a non-empty `deletedAt`
//   (a tombstone). Every reader and computation filters with it.
// - mergeRecord: per-record newest-wins on `updatedAt` (falling back to
//   `createdAt`). An equal time with different content is reported as
//   'conflict-same-time'; callers resolve it with sameTimeWinner and count it.
// - sameTimeWinner: the tombstone side wins; otherwise the larger canonical
//   JSON (plain string order); identical content keeps the local record.

export type SyncRecordType =
  | 'expense'
  | 'income'
  | 'category'
  | 'incomeCategory'
  | 'budget'
  | 'recurring'
  | 'settings'
  // Personal only: the member identity key pair and the Family space keys.
  | 'identity'
  | 'spaceKey'
  // Family only: the space details and the member profiles.
  | 'spaceInfo'
  | 'memberProfile'

export interface SyncRecord {
  type: SyncRecordType
  id: string
  updatedAt: string
  deletedAt?: string
  /** The stored record without `rev`, `conversion` and the joined `category`. */
  data: Record<string, unknown>
}

export type MergeDecision = 'take-incoming' | 'keep-local' | 'conflict-same-time'

export interface MergeableRecord {
  id: string
  updatedAt?: string
  createdAt?: string
  deletedAt?: string
}

export function isLive(record: { deletedAt?: string | null }): boolean {
  return !record.deletedAt
}

export function recordTimestamp(record: {
  updatedAt?: string
  createdAt?: string
}): number {
  const t = Date.parse(record.updatedAt ?? record.createdAt ?? '')
  return Number.isNaN(t) ? 0 : t
}

// Top-level fields that are local bookkeeping or derived data, never content.
const IGNORED_TOP_LEVEL = new Set(['rev', 'conversion', 'category'])

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

// Canonical JSON: keys sorted recursively, top-level rev / conversion /
// category removed. Two devices writing the same fields in a different order
// produce the same string.
export function recordContent(record: object): string {
  const top: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (!IGNORED_TOP_LEVEL.has(k)) top[k] = v
  }
  return JSON.stringify(canonical(top))
}

export function mergeRecord(
  local: MergeableRecord | undefined,
  incoming: MergeableRecord,
): MergeDecision {
  if (local === undefined) return 'take-incoming'
  const l = recordTimestamp(local)
  const i = recordTimestamp(incoming)
  if (i > l) return 'take-incoming'
  if (i < l) return 'keep-local'
  return recordContent(local) === recordContent(incoming)
    ? 'keep-local'
    : 'conflict-same-time'
}

export function sameTimeWinner(
  local: MergeableRecord,
  incoming: MergeableRecord,
): 'local' | 'incoming' {
  const localDead = !isLive(local)
  const incomingDead = !isLive(incoming)
  if (localDead !== incomingDead) return localDead ? 'local' : 'incoming'
  return recordContent(incoming) > recordContent(local) ? 'incoming' : 'local'
}
