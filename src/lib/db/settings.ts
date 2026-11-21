// Layer 3 of src/lib/db: the synced settings record.

import { get } from 'idb-keyval'

import { isDecryptError } from '../dataErrors'
import { DEFAULT_MAIN_CURRENCY, isCurrency } from '../domain'
import { identityConversion } from '../money'
import { isSpaceLockedError } from '../spaces/types'
import { postChanged } from '../syncChannel'
import { withWriteLock } from '../writeLock'
import {
  META_SETTINGS_KEY,
  PERSONAL_CTX,
  SETTINGS_DEFAULT_UPDATED_AT,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  _key,
  readStore,
  store,
  withSpaceLock,
} from './context'
import { nowIso } from './records'
import { asObject, openRevCounter } from './revs'
import { writeKeysMany } from './storage'
import { afterCommit } from './events'
import type { UseStore } from 'idb-keyval'
import type { Currency, EntryConversion, SyncedSettingsRecord } from '../domain'
import type { SpaceCtx } from './context'

// ── Synced settings ───────────────────────────────────────────────────────────

const DEFAULT_FETCH_EXCHANGE_RATES = true

// A record from the legacy plaintext `meta:settings` fields, else the defaults.
function settingsFromLegacy(
  plain: Record<string, unknown> | null,
): SyncedSettingsRecord {
  const main = plain?.mainCurrency
  const fetchRates = plain?.fetchExchangeRates
  return {
    id: 'settings',
    mainCurrency: isCurrency(main) ? main : DEFAULT_MAIN_CURRENCY,
    fetchExchangeRates:
      typeof fetchRates === 'boolean' ? fetchRates : DEFAULT_FETCH_EXCHANGE_RATES,
    updatedAt: SETTINGS_DEFAULT_UPDATED_AT,
  }
}

// A stored record with invalid fields read as their defaults; never `rev`.
function normalizeSettings(value: unknown): SyncedSettingsRecord {
  const record = asObject(value)
  const main = record?.mainCurrency
  const fetchRates = record?.fetchExchangeRates
  const updatedAt = record?.updatedAt
  return {
    id: 'settings',
    mainCurrency: isCurrency(main) ? main : DEFAULT_MAIN_CURRENCY,
    fetchExchangeRates:
      typeof fetchRates === 'boolean' ? fetchRates : DEFAULT_FETCH_EXCHANGE_RATES,
    updatedAt:
      typeof updatedAt === 'string' ? updatedAt : SETTINGS_DEFAULT_UPDATED_AT,
  }
}

// `meta:settings` without the legacy currency fields, or null when it has
// neither field (nothing to strip).
export function stripLegacyCurrency(
  plain: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!plain) return null
  if (!('mainCurrency' in plain) && !('fetchExchangeRates' in plain)) {
    return null
  }
  const copy = { ...plain }
  delete copy.mainCurrency
  delete copy.fetchExchangeRates
  return copy
}

export async function readPlainSettings(
  s: UseStore,
): Promise<Record<string, unknown> | null> {
  return asObject(await get<unknown>(META_SETTINGS_KEY, s))
}

// The synced settings (no lock: a read). Before unlock, or while the record
// doesn't exist yet, the legacy plaintext fields or the defaults. An
// unreadable record throws DecryptError('syncedSettings'). A Family space has
// its own record and no legacy fields (defaults when absent).
export async function readSyncedSettingsIn(ctx: SpaceCtx): Promise<SyncedSettingsRecord> {
  const s = store
  if (!s) return settingsFromLegacy(null)
  const stored = await readStore(ctx, 'syncedSettings')
  if (stored !== undefined) return normalizeSettings(stored)
  if (!ctx.personal) return settingsFromLegacy(null)
  return settingsFromLegacy(await readPlainSettings(s))
}

// The stored main currency. A DecryptError or SpaceLockedError propagates;
// any other failure falls back to the default.
export async function readMainCurrency(ctx: SpaceCtx): Promise<Currency> {
  try {
    return (await readSyncedSettingsIn(ctx)).mainCurrency
  } catch (err) {
    if (isDecryptError(err) || isSpaceLockedError(err)) throw err
    console.error('Could not read the main currency:', err)
    return DEFAULT_MAIN_CURRENCY
  }
}

// Creates the `syncedSettings` record from the legacy `meta:settings` fields
// (defaults when absent) and removes those fields from `meta:settings`, in ONE
// setMany. A derived write: no rev, no meta:sync, no lastDataChangeAt, no
// conversion request. Idempotent: does nothing (false) when the record already
// exists, even as an unreadable blob, or while the app is locked.
export async function migrateSyncedSettings(): Promise<boolean> {
  const s = store
  if (!s || !_key) return false
  const migrated = await withWriteLock(
    [META_SETTINGS_KEY, SYNCED_SETTINGS_KEY],
    async () => {
      if ((await get<unknown>(SYNCED_SETTINGS_KEY, s)) !== undefined) {
        return false
      }
      const plain = await readPlainSettings(s)
      const record = settingsFromLegacy(plain)
      const hadLegacyValue =
        isCurrency(plain?.mainCurrency) ||
        typeof plain?.fetchExchangeRates === 'boolean'
      if (hadLegacyValue) record.updatedAt = nowIso()
      const stripped = stripLegacyCurrency(plain)
      await writeKeysMany(
        PERSONAL_CTX,
        { [SYNCED_SETTINGS_KEY]: record },
        undefined,
        stripped ? [[META_SETTINGS_KEY, stripped]] : [],
      )
      return true
    },
  )
  if (migrated) postChanged([SYNCED_SETTINGS_KEY])
  return migrated
}

// Patches the synced settings (only `fetchExchangeRates`; the main currency
// changes through convertBudgets). Stamps updatedAt and a rev, and strips the
// legacy fields from `meta:settings` in the same transaction (personal only).
// An empty or invalid patch writes nothing.
export async function updateSyncedSettingsIn(
  ctx: SpaceCtx,
  patch: { fetchExchangeRates?: boolean },
): Promise<void> {
  const value = patch.fetchExchangeRates
  if (typeof value !== 'boolean') return
  const s = store
  if (!s) return
  const lockKeys = ctx.personal
    ? [META_SETTINGS_KEY, SYNC_META_KEY, SYNCED_SETTINGS_KEY]
    : [SYNC_META_KEY, SYNCED_SETTINGS_KEY]
  const written = await withSpaceLock(ctx, lockKeys, async () => {
    const current = await readSyncedSettingsIn(ctx)
    const counter = await openRevCounter(ctx)
    const record: SyncedSettingsRecord = {
      ...current,
      fetchExchangeRates: value,
      updatedAt: nowIso(),
      rev: counter.next(),
    }
    const stripped = ctx.personal
      ? stripLegacyCurrency(await readPlainSettings(s))
      : null
    await writeKeysMany(
      ctx,
      { [SYNCED_SETTINGS_KEY]: record },
      counter,
      stripped ? [[META_SETTINGS_KEY, stripped]] : [],
    )
    return stripped
      ? [SYNCED_SETTINGS_KEY, META_SETTINGS_KEY]
      : [SYNCED_SETTINGS_KEY]
  })
  await afterCommit(ctx, written)
}

// The identity conversion when the record is in `main`; otherwise undefined
// (the record stays pending until the converter runs).
export function conversionOnSave(
  record: { amount: number; currency: Currency; createdAt: string },
  main: Currency,
): EntryConversion | undefined {
  return record.currency === main ? identityConversion(record, main) : undefined
}
