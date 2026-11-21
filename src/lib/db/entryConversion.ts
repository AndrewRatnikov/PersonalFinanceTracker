// Layer 4 of src/lib/db: main-currency conversion writes (for conversion.ts).

import { isConverted } from '../money'
import { isLive } from '../syncRecords'
import {
  META_SETTINGS_KEY,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  _key,
  readStore,
  store,
  withSpaceLock,
} from './context'
import { nowIso } from './records'
import { openRevCounter } from './revs'
import {
  EXPENSE_CHUNK_KEY_RE,
  allExpenseChunkKeys,
  readChunk,
  writeKeysMany,
} from './storage'
import { afterCommit } from './events'
import {
  readPlainSettings,
  readSyncedSettingsIn,
  stripLegacyCurrency,
} from './settings'
import type { Currency, EntryConversion, Expense, IncomeEntry } from '../domain'
import type { LocalDbMap, SpaceCtx } from './context'

// ── Main-currency conversion (used by conversion.ts) ─────────────────────────

export interface ConversionStorageGroup {
  storageKey: string
  records: Array<Expense | IncomeEntry>
}

export interface EntryConversionUpdate {
  id: string
  amount: number
  currency: Currency
  createdAt: string
  conversion: EntryConversion
}

// The raw stored entries (no joined category, tombstones included: callers
// filter with isLive): one group per expense chunk in ascending key order,
// then `income`. A DecryptError propagates.
// `storageKey` is the base key of the space (the handle passes it back to
// applyEntryConversions of the same space).
export async function readEntriesForConversionIn(ctx: SpaceCtx): Promise<
  Array<ConversionStorageGroup>
> {
  const groups: Array<ConversionStorageGroup> = []
  for (const storageKey of await allExpenseChunkKeys(ctx)) {
    const records = await readChunk(ctx, storageKey)
    if (records.length > 0) groups.push({ storageKey, records })
  }
  const income = (await readStore(ctx, 'income')) ?? []
  if (income.length > 0) groups.push({ storageKey: 'income', records: income })
  return groups
}

async function readEntryKey(
  ctx: SpaceCtx,
  storageKey: string,
): Promise<Array<Expense | IncomeEntry>> {
  if (storageKey === 'income') return (await readStore(ctx, 'income')) ?? []
  return readChunk(ctx, storageKey)
}

// Writes the computed conversions under the lock of `storageKey`. A record is
// updated only when it still exists, is live, is not converted for
// `mainCurrency` yet and still has the amount, currency and createdAt the rate
// was computed for (an edit in between leaves it pending). Only `conversion`
// changes; updatedAt and rev stay (derived data, meta:sync untouched).
// Returns the number of records written.
export async function applyEntryConversionsIn(
  ctx: SpaceCtx,
  storageKey: string,
  mainCurrency: Currency,
  updates: Array<EntryConversionUpdate>,
): Promise<number> {
  if (updates.length === 0) return 0
  if (storageKey !== 'income' && !EXPENSE_CHUNK_KEY_RE.test(storageKey)) {
    throw new Error(`applyEntryConversions: not an entry key "${storageKey}"`)
  }
  const byId = new Map(updates.map((u) => [u.id, u]))
  const written = await withSpaceLock(ctx, storageKey, async () => {
    if (!_key) throw new Error('LocalDb not initialized')
    const records = await readEntryKey(ctx, storageKey)
    let count = 0
    const next = records.map((record) => {
      const update = byId.get(record.id)
      if (
        !update ||
        !isLive(record) ||
        isConverted(record, mainCurrency) ||
        record.amount !== update.amount ||
        record.currency !== update.currency ||
        record.createdAt !== update.createdAt
      ) {
        return record
      }
      count++
      return { ...record, conversion: update.conversion }
    })
    if (count === 0) return 0
    await writeKeysMany(ctx, { [storageKey]: next })
    return count
  })
  if (written > 0) {
    await afterCommit(ctx, [storageKey], { fromConversion: true, dataChange: false })
  }
  return written
}

// Converts every live budget not in `target` with `rateFor(budget.currency)`
// (unrounded) and, with setMainCurrency, stores `target` as the main currency
// in the synced settings record, in the SAME transaction. Every converted
// budget and the settings record get updatedAt = now and a rev (meta:sync in
// the same setMany). Without setMainCurrency (the one-time fix of budgets in
// another currency) it does nothing unless `target` is the stored main
// currency. A throwing rateFor writes nothing. Returns the number of budgets
// converted.
export async function convertBudgetsIn(
  ctx: SpaceCtx,
  target: Currency,
  rateFor: (from: Currency) => number,
  options: { setMainCurrency: boolean },
): Promise<number> {
  const s = store
  if (!s) return 0
  const lockKeys = ctx.personal
    ? ['budgets', META_SETTINGS_KEY, SYNC_META_KEY, SYNCED_SETTINGS_KEY]
    : ['budgets', SYNC_META_KEY, SYNCED_SETTINGS_KEY]
  const result = await withSpaceLock(
    ctx,
    lockKeys,
    async () => {
      const current = await readSyncedSettingsIn(ctx)
      if (!options.setMainCurrency && current.mainCurrency !== target) {
        return { converted: 0, keys: [] as Array<string> }
      }
      if (!_key) throw new Error('LocalDb not initialized')

      const budgets = (await readStore(ctx, 'budgets')) ?? []
      const updatedAt = nowIso()
      const counter = await openRevCounter(ctx)
      let converted = 0
      const nextBudgets = budgets.map((b) => {
        if (!isLive(b) || b.currency === target) return b
        const rate = rateFor(b.currency)
        converted++
        return {
          ...b,
          monthlyLimit: b.monthlyLimit * rate,
          currency: target,
          updatedAt,
          rev: counter.next(),
        }
      })

      const values: Partial<LocalDbMap> = {}
      const plain: Array<[string, unknown]> = []
      const writtenKeys: Array<string> = []
      if (converted > 0) {
        values.budgets = nextBudgets
        writtenKeys.push('budgets')
      }
      if (options.setMainCurrency) {
        values.syncedSettings = {
          ...current,
          mainCurrency: target,
          updatedAt,
          rev: counter.next(),
        }
        writtenKeys.push(SYNCED_SETTINGS_KEY)
        const stripped = ctx.personal
          ? stripLegacyCurrency(await readPlainSettings(s))
          : null
        if (stripped) {
          plain.push([META_SETTINGS_KEY, stripped])
          writtenKeys.push(META_SETTINGS_KEY)
        }
      }
      await writeKeysMany(ctx, values, counter, plain)
      return { converted, keys: writtenKeys }
    },
  )
  if (result.keys.length > 0) {
    // The one-time fix is the converter's own background work, not a data
    // change for the backup reminder; a main-currency change is.
    await afterCommit(ctx, result.keys, {
      fromConversion: true,
      dataChange: options.setMainCurrency,
    })
  }
  return result.converted
}
