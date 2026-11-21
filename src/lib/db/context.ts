// Layer 0 of src/lib/db (see src/lib/localDb.ts): the store, the vault DEK,
// the space context, the keyring loader, cryptoFor, write stamps,
// withSpaceLock and readStore.

import { clear, createStore, get } from 'idb-keyval'

import { base64ToBytes, decryptValue, encryptValue } from '../crypto'
import { DecryptError } from '../dataErrors'
import {
  clearKeyring,
  getHeldSpace,
  keyringNeedsLoad,
  keyringVersion,
  markKeyringStale,
  setKeyring,
  setKeyringLoader,
} from '../spaces/keyring'
import { getCurrentMemberId } from '../spaces/member'
import { importSpaceKey } from '../spaces/spaceCrypto'
import {
  PERSONAL_SPACE_ID,
  SpaceLockedError,
  isReadOnlyShareStatus,
  isValidFamilySpaceId,
  keyFor,
} from '../spaces/types'
import { isLive } from '../syncRecords'
import { withWriteLock } from '../writeLock'
import type { UseStore } from 'idb-keyval'
import type {
  BudgetEntry,
  Category,
  IncomeEntry,
  RecurringItem,
  SyncedSettingsRecord,
} from '../domain'
import type { HeldSpace } from '../spaces/keyring'
import type {
  IdentityRecord,
  MemberProfile,
  SpaceId,
  SpaceInfoRecord,
  SpaceKeyEntry,
} from '../spaces/types'

// Expenses are stored in per-month chunks: `expenses_YYYY_MM`.
// All other collections are small enough to store as single keys:
// `categories` (expense categories), `incomeCategories`, `income`, `budgets`,
// `recurring` (recurring items) and `syncedSettings` (ONE encrypted record
// with the settings that follow the user between devices).
// Income records reference an income category by `categoryId`; legacy records
// with a free-text `source` are converted by ensureIncomeCategories().
//
// Every mutation runs its whole read-modify-write under withWriteLock for the
// storage key(s) it touches, and announces the written keys on the sync
// channel after the write has committed. Reads throw DecryptError for a blob
// that cannot be decrypted; mutations never catch it, so a corrupt blob is
// never overwritten. Quarantined copies live under `quarantine:<key>:<ISO>`
// and are ignored by every reader. After each committed mutation (but not a
// quarantine, a compaction, a migration or the converter's own writes)
// `meta:settings.lastDataChangeAt` is set for the backup reminder.
//
// Sync groundwork:
// - Deletes are soft: a deleted record stays in its array (an expense in its
//   chunk) with `deletedAt = updatedAt = now` (a tombstone). Every reader
//   filters with isLive (syncRecords.ts) and the public API never returns a
//   tombstone or the local `rev`. Only quarantineKey, clearLocalDb and
//   compactTombstones really remove data.
// - Change sequence: the plaintext `meta:sync` holds `{ localRev }`. Every user
//   write locks `meta:sync`, stamps `rev = ++localRev` on each record it
//   creates, changes, deletes or undeletes, and writes the data keys and
//   `meta:sync` in ONE setMany. A write that sets `updatedAt` stamps `rev`;
//   derived writes (conversion, quarantine, migrations, incoming records,
//   compaction) stamp neither and never touch `meta:sync`. `meta:sync` also
//   holds the sync engine's fields (src/lib/sync/syncMeta.ts); a user write
//   keeps them and only replaces localRev, then calls the onLocalChange
//   listeners (the engine's debounced trigger).
// - Records generated for a recurring occurrence get the deterministic id
//   occurrenceRecordId(recurringId, occurrenceDate).
//
// Main currency: an entry saved in the main currency gets its identity
// `conversion` right away; any other entry is stored without one (pending).
// Every committed write to an entry key (an expense chunk or `income`) or to
// `syncedSettings` calls requestEntryConversion(), which conversion.ts listens
// to (this module never imports conversion.ts). The converter writes back
// through applyEntryConversions / convertBudgets, which don't trigger it again.
//
// Spaces (spec §20): every data function is implemented once against a space
// context (`SpaceCtx`). The top-level exports are the Personal space;
// spaceDb(spaceId) returns a handle with the same members for a Family space.
// Storage keys are built only by keyFor (personal keys unchanged, Family keys
// `space:<id>:<baseKey>`) and every value is encrypted only through
// cryptoFor(spaceId): the DEK for personal, the space key (SK) for a Family
// space. Family data is never encrypted or decrypted with the DEK; a Family
// space without its key raises SpaceLockedError. Each space has its own
// `meta:sync` localRev. Family writes stamp createdBy / updatedBy / paidBy
// with the current member id; personal records never carry them.
export interface LocalDbMap {
  categories: Array<Category>
  incomeCategories: Array<Category>
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  recurring: Array<RecurringItem>
  syncedSettings: SyncedSettingsRecord
  // Personal only (encrypted with the DEK).
  identity: IdentityRecord
  spaceKeys: Array<SpaceKeyEntry>
  // Family only (encrypted with the space key).
  spaceInfo: SpaceInfoRecord
  memberProfiles: Array<MemberProfile>
}

/** Personal: the member identity key pair (one record). */
export const IDENTITY_KEY = 'identity'
/** Personal: one entry per Family space with its key. */
export const SPACE_KEYS_KEY = 'spaceKeys'
/** Family: the space details (one record, id 'space'). */
export const SPACE_INFO_KEY = 'spaceInfo'
/** Family: the member profiles. */
export const MEMBER_PROFILES_KEY = 'memberProfiles'

type LocalDbKey = keyof LocalDbMap

/** Plaintext `{ localRev: number, ...sync fields }`; a missing or invalid localRev means 0. */
export const SYNC_META_KEY = 'meta:sync'
/** The encrypted synced settings record. */
export const SYNCED_SETTINGS_KEY = 'syncedSettings'
/** updatedAt of a settings record that only holds defaults. */
export const SETTINGS_DEFAULT_UPDATED_AT = '1970-01-01T00:00:00.000Z'

// The vault DEK (see vault.ts): a non-extractable AES-GCM key, memory only.
export let _key: CryptoKey | null = null

export const store =
  typeof window !== 'undefined' ? createStore('minima-local', 'data') : null

// The shared store handle. vault.ts keeps `meta:vault` and `meta:settings` in
// the same store as the data. Null on the server.
export function getLocalStore(): UseStore | null {
  return store
}

export function getLocalDbKey(): CryptoKey | null {
  return _key
}

// A new DEK: the keyring is reloaded from its spaceKeys on the next Family
// access.
export function unlockLocalDb(key: CryptoKey): void {
  _key = key
  clearKeyring()
}

// Lock, auto-lock, cross-tab lock and Remove data: the DEK and every space key
// leave memory. The identity key pair is never cached.
export function wipeLocalDbKey(): void {
  _key = null
  clearKeyring()
}

// Re-key only (rekeyLiveData): swaps the DEK without clearing the keyring;
// the caller marks it stale. Lives here because only this module assigns _key.
export function replaceLocalDbKey(key: CryptoKey): void {
  _key = key
}

// ── Space context, keyring and cryptoFor ──────────────────────────────────────

export interface SpaceCtx {
  readonly spaceId: SpaceId
  readonly personal: boolean
}

export const PERSONAL_CTX: SpaceCtx = { spaceId: PERSONAL_SPACE_ID, personal: true }

const ctxCache = new Map<string, SpaceCtx>()

// The context of a space id; a bad Family id throws TypeError.
export function ctxFor(spaceId: SpaceId): SpaceCtx {
  if (spaceId === PERSONAL_SPACE_ID) return PERSONAL_CTX
  let ctx = ctxCache.get(spaceId)
  if (!ctx) {
    keyFor(spaceId, SYNC_META_KEY) // validates the id
    ctx = { spaceId, personal: false }
    ctxCache.set(spaceId, ctx)
  }
  return ctx
}

// The storage key of `baseKey` in the space (the only key builder: keyFor).
export function storageKeyOf(ctx: SpaceCtx, baseKey: string): string {
  return keyFor(ctx.spaceId, baseKey)
}

// True when personal reads must return nothing (no DEK). A Family space is
// never "quietly empty": its reads raise SpaceLockedError instead.
export function personalLocked(ctx: SpaceCtx): boolean {
  return ctx.personal && !_key
}

export interface SpaceCrypto {
  spaceId: string
  encrypt: (value: unknown) => Promise<Uint8Array>
  decrypt: (bytes: Uint8Array) => Promise<unknown>
}

// The record crypto of a space. Personal: the DEK ("LocalDb not initialized"
// while locked). Family: the space key from the keyring (loaded on demand),
// newest version for writing, older versions tried for reading;
// SpaceLockedError when the vault is locked or the space is not held. Never
// the DEK for a Family space.
export async function cryptoFor(spaceId: SpaceId): Promise<SpaceCrypto> {
  if (spaceId === PERSONAL_SPACE_ID) {
    const key = _key
    if (!key) throw new Error('LocalDb not initialized')
    return {
      spaceId,
      encrypt: (value) => encryptValue(key, value),
      decrypt: (bytes) => decryptValue(key, bytes),
    }
  }
  if (!isValidFamilySpaceId(spaceId)) {
    throw new TypeError(`cryptoFor: invalid space id "${spaceId}"`)
  }
  if (!_key) throw new SpaceLockedError(spaceId)
  if (keyringNeedsLoad()) await loadKeyring()
  const held = getHeldSpace(spaceId)
  // A lock while the keyring loaded leaves nothing usable.
  if (!getLocalDbKey() || !held || held.keys.length === 0) {
    throw new SpaceLockedError(spaceId)
  }
  const versions = held.keys
  return {
    spaceId,
    encrypt: (value) => encryptValue(versions[0].key, value),
    decrypt: async (bytes) => {
      let lastError: unknown = new Error('no key')
      for (const version of versions) {
        try {
          return await decryptValue(version.key, bytes)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    },
  }
}

let keyringLoad: Promise<void> | null = null

// Reads the personal spaceKeys record with the DEK and imports the keys of
// every live entry into the keyring. A DecryptError('spaceKeys') propagates.
// A lock during the load leaves the keyring cleared.
export function loadKeyring(): Promise<void> {
  if (keyringLoad) return keyringLoad
  keyringLoad = (async () => {
    const dek = _key
    if (!dek || !store) return
    const version = keyringVersion()
    const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
    const spaces: Array<HeldSpace> = []
    for (const entry of entries) {
      if (!isLive(entry) || !isValidFamilySpaceId(entry.id) || !entry.key) continue
      try {
        const versions = [
          { keyVersion: entry.keyVersion, key: entry.key },
          ...(entry.previousKeys ?? []),
        ].sort((a, b) => b.keyVersion - a.keyVersion)
        const imported: HeldSpace['keys'] = []
        for (const v of versions) {
          if (!v.key) continue
          imported.push({
            keyVersion: v.keyVersion,
            key: await importSpaceKey(base64ToBytes(v.key)),
          })
        }
        spaces.push({
          id: entry.id,
          name: entry.name,
          role: entry.role,
          keyVersion: entry.keyVersion,
          keys: imported,
          readOnly: isReadOnlyShareStatus(entry.status),
        })
      } catch (err) {
        console.error('Could not import a space key:', err instanceof Error ? err.name : typeof err)
      }
    }
    if (_key !== dek) return
    setKeyring(spaces)
    if (keyringVersion() !== version) markKeyringStale()
  })().finally(() => {
    keyringLoad = null
  })
  return keyringLoad
}

// One assignment, no I/O: listHeldSpaceIds() loads through it.
setKeyringLoader(loadKeyring)

// The current member for a Family write (undefined for personal: no stamps).
export async function memberFor(ctx: SpaceCtx): Promise<string | null | undefined> {
  return ctx.personal ? undefined : getCurrentMemberId()
}

// Family create: createdBy = updatedBy = the member (absent when unknown) and,
// for expenses and income, paidBy = input.paidBy ?? the member. Mutates and
// returns the record. Personal (member undefined): nothing.
export function stampCreated<T extends { createdBy?: string; updatedBy?: string; paidBy?: string }>(
  member: string | null | undefined,
  record: T,
  paid?: { paidBy?: string },
): T {
  if (member === undefined) return record
  if (member) {
    record.createdBy = member
    record.updatedBy = member
  }
  if (paid) {
    const paidBy = paid.paidBy ?? member
    if (paidBy) record.paidBy = paidBy
  }
  return record
}

// updatedBy = the member, or removed when the writer is unknown.
export function withUpdatedBy<T extends object>(record: T, member: string | null): T {
  const r = record as T & { updatedBy?: string }
  if (member) return r.updatedBy === member ? record : { ...record, updatedBy: member }
  if (!('updatedBy' in r)) return record
  const copy = { ...r }
  delete copy.updatedBy
  return copy
}

// Locks the space's storage keys (meta:settings is device-level: unprefixed).
export function withSpaceLock<T>(
  ctx: SpaceCtx,
  lockKeys: Array<string> | string,
  fn: () => Promise<T>,
): Promise<T> {
  const list = Array.isArray(lockKeys) ? lockKeys : [lockKeys]
  return withWriteLock(
    list.map((k) => (k === META_SETTINGS_KEY ? k : storageKeyOf(ctx, k))),
    fn,
  )
}

export async function clearLocalDb(): Promise<void> {
  if (!store) return
  await clear(store)
}

// Reads and decrypts the base key `key` of the space. Personal: undefined
// while locked. Family: SpaceLockedError without its key. An unreadable blob
// throws DecryptError naming the full storage key.
export async function readStore<TKey extends LocalDbKey>(
  ctx: SpaceCtx,
  key: TKey,
): Promise<LocalDbMap[TKey] | undefined> {
  if (!store || personalLocked(ctx)) return undefined
  const c = await cryptoFor(ctx.spaceId)
  const storageKey = storageKeyOf(ctx, key)
  const raw = await get<unknown>(storageKey, store)
  if (!(raw instanceof Uint8Array)) return undefined
  try {
    return (await c.decrypt(raw)) as LocalDbMap[TKey]
  } catch (err) {
    throw new DecryptError(storageKey, err)
  }
}

// Must equal META_SETTINGS_KEY in vault.ts. Not imported from there: vault.ts
// imports this module, and many tests mock `@/lib/vault` partially.
export const META_SETTINGS_KEY = 'meta:settings'
