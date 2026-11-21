// Layer 6 of src/lib/db: re-keying the live data for a cloud join.

import { get, setMany } from 'idb-keyval'

import { encryptValue } from '../crypto'
import { markKeyringStale } from '../spaces/keyring'
import { isLive } from '../syncRecords'
import { withWriteLock } from '../writeLock'
import {
  IDENTITY_KEY,
  PERSONAL_CTX,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  _key,
  readStore,
  replaceLocalDbKey,
  store,
} from './context'
import { openRevCounter } from './revs'
import {
  allExpenseChunkKeys,
  expenseChunkKey,
  notifyLocalChange,
  readChunk,
} from './storage'
import { afterCommit } from './events'
import { RECURRING_ATTEMPTS } from './recurringOccurrences'
import type { Expense } from '../domain'
import type { Revisioned, SingleListKey } from './records'

// ── Re-key (sync: "Join cloud data and keep this device's entries") ──────────

export interface RekeyResult {
  /** Records re-stamped (live records plus the settings record). */
  records: number
  /** localRev before the re-stamp. */
  startRev: number
  /** localRev after it. */
  localRev: number
}

const REKEY_SINGLE_KEYS: Array<SingleListKey> = [
  'categories',
  'incomeCategories',
  'income',
  'budgets',
  'recurring',
  'spaceKeys',
]

// Re-encrypts this device's LIVE data under `newKey` (used only by
// vault.joinCloudVault). Under one lock: everything is read with the current
// key (a DecryptError propagates and nothing is written), tombstones are
// dropped (they belong to the old vault), every kept record and the settings
// record gets a fresh rev (id, updatedAt, createdAt and conversion kept), and
// ONE setMany writes every data key (expenses regrouped into the chunk of their
// createdAt; a key left empty gets an encrypted []), the `plain` entries
// verbatim and meta:sync = { ...stored, ...syncPatch, localRev } (plus
// pushedRev = startRev when the patch enables sync, so every re-inserted record
// is pushed). quarantine:* keys are left alone. Only after the commit does the
// in-memory key switch; a failure before leaves the store and the key as they
// were.
export async function rekeyLiveData(
  newKey: CryptoKey,
  extra: {
    plain?: Array<[string, unknown]>
    syncPatch?: Record<string, unknown>
  } = {},
): Promise<RekeyResult> {
  const s = store
  if (!_key || !s) throw new Error('LocalDb not initialized')
  const plain = extra.plain ?? []
  const syncPatch = extra.syncPatch ?? {}

  const P = PERSONAL_CTX
  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    const chunkKeys = await allExpenseChunkKeys(P)
    const outcome = await withWriteLock(
      [
        ...chunkKeys,
        ...REKEY_SINGLE_KEYS,
        SYNCED_SETTINGS_KEY,
        IDENTITY_KEY,
        SYNC_META_KEY,
        ...plain.map(([key]) => key),
      ],
      async (): Promise<
        { status: 'retry' } | { status: 'done'; result: RekeyResult; written: Array<string> }
      > => {
        const locked = new Set(chunkKeys)
        if ((await allExpenseChunkKeys(P)).some((k) => !locked.has(k))) {
          return { status: 'retry' }
        }

        // Read everything with the current key first. The space keys and the
        // identity are re-encrypted too (only when present), so the device
        // keeps its Family access; Family data itself is encrypted with the
        // space keys and needs nothing.
        const chunks = new Map<string, Array<Expense>>()
        for (const key of chunkKeys) chunks.set(key, await readChunk(P, key))
        const singles = new Map<string, Array<Revisioned>>()
        for (const key of REKEY_SINGLE_KEYS) {
          const raw = await get<unknown>(key, s)
          if (raw === undefined) continue
          singles.set(key, ((await readStore(P, key)) ?? []) as Array<Revisioned>)
        }
        const settings = await readStore(P, 'syncedSettings')
        const identity = await readStore(P, 'identity')

        const counter = await openRevCounter(P)
        const startRev = counter.last
        const values = new Map<string, unknown>()

        const regrouped = new Map<string, Array<Expense>>(
          chunkKeys.map((key) => [key, []]),
        )
        for (const list of chunks.values()) {
          for (const expense of list) {
            if (!isLive(expense)) continue
            const target = expenseChunkKey(expense.createdAt)
            const bucket = regrouped.get(target) ?? []
            bucket.push({ ...expense, rev: counter.next() })
            regrouped.set(target, bucket)
          }
        }
        for (const [key, list] of regrouped) values.set(key, list)
        for (const [key, list] of singles) {
          values.set(
            key,
            list.filter(isLive).map((r) => ({ ...r, rev: counter.next() })),
          )
        }
        if (settings !== undefined) {
          values.set(SYNCED_SETTINGS_KEY, { ...settings, rev: counter.next() })
        }
        if (identity !== undefined) {
          values.set(IDENTITY_KEY, { ...identity, rev: counter.next() })
        }

        const entries: Array<[IDBValidKey, unknown]> = []
        for (const [key, value] of values) {
          entries.push([key, await encryptValue(newKey, value)])
        }
        entries.push(...plain)
        const meta: Record<string, unknown> = {
          ...counter.base,
          ...syncPatch,
          localRev: counter.last,
        }
        if (syncPatch.enabled === true) meta.pushedRev = startRev
        entries.push([SYNC_META_KEY, meta])

        await setMany(entries, s)
        return {
          status: 'done',
          result: {
            records: counter.last - startRev,
            startRev,
            localRev: counter.last,
          },
          written: [...values.keys()],
        }
      },
    )
    if (outcome.status === 'retry') continue
    replaceLocalDbKey(newKey)
    markKeyringStale()
    await afterCommit(P, outcome.written)
    notifyLocalChange()
    return outcome.result
  }
  throw new Error('rekeyLiveData: storage kept changing')
}
