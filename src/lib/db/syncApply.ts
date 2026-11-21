// Layer 6 of src/lib/db: applying incoming sync records.

import { base64ToBytes } from '../crypto'
import { isCurrency } from '../domain'
import { SpaceLockedError, isValidFamilySpaceId } from '../spaces/types'
import { mergeRecord, sameTimeWinner } from '../syncRecords'
import {
  IDENTITY_KEY,
  _key,
  cryptoFor,
  readStore,
  store,
  withSpaceLock,
} from './context'
import { asObject } from './revs'
import {
  allExpenseChunkKeys,
  expenseChunkKey,
  readChunk,
  writeKeysMany,
} from './storage'
import { afterCommit } from './events'
import { RECURRING_ATTEMPTS } from './recurringOccurrences'
import { isObjectKey, keyOfTypeFor, syncData } from './sync'
import type { SyncRecord, SyncRecordType } from '../syncRecords'
import type { SpaceCtx } from './context'
import type { SingleListKey } from './records'
import type {
  AppliedIncomingRecord,
  ApplyIncomingOptions,
  ApplyIncomingResult,
  StoredRecord,
} from './sync'

function isParseableDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isBase64Key(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false
  try {
    return base64ToBytes(value).byteLength === 32
  } catch {
    return false
  }
}

function isValidIncoming(
  record: unknown,
  keyOfType: Map<SyncRecordType, string>,
): record is SyncRecord {
  const r = asObject(record)
  if (!r) return false
  const type = r.type as SyncRecordType
  if (type !== 'expense' && !keyOfType.has(type)) return false
  if (typeof r.id !== 'string' || r.id === '') return false
  const data = asObject(r.data)
  if (!data || data.id !== r.id) return false
  if (!isParseableDate(r.updatedAt)) return false
  if (r.deletedAt !== undefined && r.deletedAt !== null && !isParseableDate(r.deletedAt)) {
    return false
  }
  if ((type === 'expense' || type === 'income') && !isParseableDate(data.createdAt)) {
    return false
  }
  if (type === 'settings') {
    return (
      r.id === 'settings' &&
      isCurrency(data.mainCurrency) &&
      typeof data.fetchExchangeRates === 'boolean'
    )
  }
  if (type === 'identity') {
    return (
      r.id === IDENTITY_KEY &&
      asObject(data.publicKeyJwk) !== null &&
      asObject(data.privateKeyJwk) !== null
    )
  }
  if (type === 'spaceKey') {
    const tombstone = typeof r.deletedAt === 'string' && r.deletedAt !== ''
    return (
      isValidFamilySpaceId(r.id) &&
      typeof data.keyVersion === 'number' &&
      Number.isInteger(data.keyVersion) &&
      data.keyVersion >= 1 &&
      (data.role === 'owner' || data.role === 'member') &&
      typeof data.name === 'string' &&
      (tombstone || isBase64Key(data.key))
    )
  }
  if (type === 'spaceInfo') {
    return r.id === 'space' && typeof data.name === 'string'
  }
  if (type === 'memberProfile') {
    return typeof data.displayName === 'string'
  }
  return true
}

// The form an incoming record is stored in: its data with the envelope's
// updatedAt (and deletedAt), without rev, conversion or a joined category.
function incomingStoredForm(record: SyncRecord): StoredRecord {
  const stored: StoredRecord = {
    ...syncData(record.data),
    id: record.id,
    updatedAt: record.updatedAt,
  }
  if (record.deletedAt) stored.deletedAt = record.deletedAt
  return stored
}

// A stored list indexed by id; removed slots are null until written.
interface KeyState {
  list: Array<StoredRecord | null>
  changed: boolean
}

function buildState(list: Array<unknown>): KeyState {
  return { list: list as Array<StoredRecord>, changed: false }
}

function liveList(state: KeyState): Array<StoredRecord> {
  return state.list.filter((r): r is StoredRecord => r !== null)
}

// Applies records from outside (later the server), per record by mergeRecord
// with the sameTimeWinner tie-break. It is not a local change: no rev is
// stamped and meta:sync is neither locked nor written. Expenses go to the
// chunk of their createdAt and are removed from every other chunk that holds
// the same id; tombstones are stored as tombstones; `settings` replaces the
// synced settings record. A malformed record rejects the whole batch before
// anything is read. Everything changed is written in ONE setMany, then the
// usual commit hook runs. A DecryptError propagates and nothing is written.
//
// `preferIncomingOnTie` (the sync engine, for the server copy of a 'stale' push
// result): an equal updatedAt with different content takes the incoming record
// (still counted as a conflict), so every device converges on the server copy.
export async function applyIncomingRecordsIn(
  ctx: SpaceCtx,
  records: Array<SyncRecord>,
  options: ApplyIncomingOptions = {},
): Promise<ApplyIncomingResult> {
  const KEY_OF_TYPE = keyOfTypeFor(ctx)
  records.forEach((record, index) => {
    if (!isValidIncoming(record, KEY_OF_TYPE)) {
      throw new Error(`applyIncomingRecords: invalid record ${index}`)
    }
  })
  const empty: ApplyIncomingResult = { applied: 0, kept: 0, conflicts: 0 }
  if (records.length === 0) return empty
  if (!_key || !store) {
    if (ctx.personal) throw new Error('LocalDb not initialized')
    throw new SpaceLockedError(ctx.spaceId)
  }
  if (!ctx.personal) await cryptoFor(ctx.spaceId)

  const types = new Set(records.map((r) => r.type))
  const singleKeys = Array.from(types)
    .filter((t) => t !== 'expense')
    .map((t) => KEY_OF_TYPE.get(t) as string)
  const hasExpenses = types.has('expense')
  const targetChunks = new Set<string>()
  for (const r of records) {
    if (r.type === 'expense') targetChunks.add(expenseChunkKey(r.data.createdAt as string))
  }

  for (let attempt = 0; attempt < RECURRING_ATTEMPTS; attempt++) {
    const chunkKeys = hasExpenses
      ? Array.from(new Set([...(await allExpenseChunkKeys(ctx)), ...targetChunks]))
      : []
    const outcome = await withSpaceLock(
      ctx,
      [...singleKeys, ...chunkKeys],
      async (): Promise<
        | { status: 'retry' }
        | {
            status: 'done'
            result: ApplyIncomingResult
            written: Array<string>
            taken: Array<AppliedIncomingRecord>
          }
      > => {
        if (hasExpenses) {
          const locked = new Set(chunkKeys)
          if ((await allExpenseChunkKeys(ctx)).some((k) => !locked.has(k))) {
            return { status: 'retry' }
          }
        }

        // Read everything first: a DecryptError leaves nothing written.
        const singles = new Map<string, KeyState>()
        const objects = new Map<string, { value: StoredRecord | undefined; changed: boolean }>()
        for (const key of singleKeys) {
          if (isObjectKey(key)) {
            const stored = await readStore(ctx, key)
            objects.set(key, {
              value: stored === undefined ? undefined : (stored as unknown as StoredRecord),
              changed: false,
            })
            continue
          }
          singles.set(key, buildState((await readStore(ctx, key as SingleListKey)) ?? []))
        }
        const chunks = new Map<string, KeyState>()
        for (const key of chunkKeys) chunks.set(key, buildState(await readChunk(ctx, key)))

        // Indexes: id -> position (single keys), id -> every chunk slot.
        const singleIndex = new Map<string, Map<string, number>>()
        for (const [key, state] of singles) {
          const index = new Map<string, number>()
          state.list.forEach((r, i) => {
            if (r && !index.has(r.id)) index.set(r.id, i)
          })
          singleIndex.set(key, index)
        }
        const where = new Map<string, Array<{ chunk: string; i: number }>>()
        for (const [key, state] of chunks) {
          state.list.forEach((r, i) => {
            if (!r) return
            const slots = where.get(r.id) ?? []
            slots.push({ chunk: key, i })
            where.set(r.id, slots)
          })
        }

        const result: ApplyIncomingResult = { applied: 0, kept: 0, conflicts: 0 }
        const taken: Array<AppliedIncomingRecord> = []
        for (const record of records) {
          const incoming = incomingStoredForm(record)
          let local: StoredRecord | undefined
          if (record.type === 'expense') {
            const slot = where.get(record.id)?.[0]
            local = slot ? (chunks.get(slot.chunk)?.list[slot.i] ?? undefined) : undefined
          } else if (isObjectKey(KEY_OF_TYPE.get(record.type) as string)) {
            local = objects.get(KEY_OF_TYPE.get(record.type) as string)?.value
          } else {
            const key = KEY_OF_TYPE.get(record.type) as string
            const i = singleIndex.get(key)?.get(record.id)
            local = i === undefined ? undefined : (singles.get(key)?.list[i] ?? undefined)
          }

          const decision = mergeRecord(local, incoming)
          let take = decision === 'take-incoming'
          if (decision === 'conflict-same-time' && local) {
            result.conflicts++
            take =
              options.preferIncomingOnTie === true ||
              sameTimeWinner(local, incoming) === 'incoming'
          }
          if (!take) {
            result.kept++
            continue
          }
          result.applied++
          const createdBy = incoming.createdBy
          taken.push({
            type: record.type,
            id: record.id,
            created: local === undefined,
            deleted: incoming.deletedAt !== undefined,
            ...(typeof createdBy === 'string' ? { createdBy } : {}),
          })

          // The local conversion stays while amount, currency and createdAt
          // are unchanged; otherwise the record is pending.
          if (
            local?.conversion !== undefined &&
            (record.type === 'expense' || record.type === 'income') &&
            local.amount === incoming.amount &&
            local.currency === incoming.currency &&
            local.createdAt === incoming.createdAt
          ) {
            incoming.conversion = local.conversion
          }

          if (record.type === 'expense') {
            const target = expenseChunkKey(incoming.createdAt as string)
            const kept: Array<{ chunk: string; i: number }> = []
            for (const slot of where.get(record.id) ?? []) {
              const state = chunks.get(slot.chunk)
              if (!state) continue
              state.changed = true
              if (slot.chunk === target && kept.length === 0) {
                state.list[slot.i] = incoming
                kept.push(slot)
              } else {
                state.list[slot.i] = null
              }
            }
            if (kept.length === 0) {
              const state = chunks.get(target)
              if (!state) throw new Error(`applyIncomingRecords: ${target} not locked`)
              state.list.push(incoming)
              state.changed = true
              kept.push({ chunk: target, i: state.list.length - 1 })
            }
            where.set(record.id, kept)
          } else if (isObjectKey(KEY_OF_TYPE.get(record.type) as string)) {
            objects.set(KEY_OF_TYPE.get(record.type) as string, {
              value: incoming,
              changed: true,
            })
          } else {
            const key = KEY_OF_TYPE.get(record.type) as string
            const state = singles.get(key)
            const index = singleIndex.get(key)
            if (!state || !index) continue
            const i = index.get(record.id)
            if (i === undefined) {
              index.set(record.id, state.list.length)
              state.list.push(incoming)
            } else {
              state.list[i] = incoming
            }
            state.changed = true
          }
        }

        const values: Record<string, unknown> = {}
        for (const [key, state] of [...chunks, ...singles]) {
          if (state.changed) values[key] = liveList(state)
        }
        for (const [key, state] of objects) {
          if (state.changed && state.value) values[key] = state.value
        }
        await writeKeysMany(ctx, values)
        return { status: 'done', result, written: Object.keys(values), taken }
      },
    )
    if (outcome.status === 'retry') continue
    if (outcome.written.length > 0) await afterCommit(ctx, outcome.written)
    if (options.onApplied) {
      try {
        options.onApplied(outcome.taken)
      } catch (err) {
        console.error(
          'applyIncomingRecords onApplied failed:',
          err instanceof Error ? err.name : typeof err,
        )
      }
    }
    return outcome.result
  }
  throw new Error('applyIncomingRecords: storage kept changing')
}
