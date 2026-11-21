// Layer 6 of src/lib/db: member identity, the Spaces API and the Family share
// state on the spaceKeys entries.

import { delMany, get, keys, setMany } from 'idb-keyval'

import { getLang } from '../../i18n/core'
import { bytesToBase64, encryptValue } from '../crypto'
import {
  defaultExpenseCategories,
  defaultIncomeCategories,
} from '../defaultCategories'
import {
  heldSpaceIds,
  keyringNeedsLoad,
  markKeyringStale,
} from '../spaces/keyring'
import { getCurrentMemberId } from '../spaces/member'
import {
  SpaceKeyError,
  generateIdentityKeyPair,
  generateIndexKey,
  generateSpaceKey,
  importSpaceKey,
} from '../spaces/spaceCrypto'
import {
  PERSONAL_SPACE_ID,
  SpaceError,
  SpaceLockedError,
  isValidFamilySpaceId,
  keyFor,
} from '../spaces/types'
import { postChanged } from '../syncChannel'
import { isLive } from '../syncRecords'
import { withWriteLock } from '../writeLock'
import {
  IDENTITY_KEY,
  MEMBER_PROFILES_KEY,
  PERSONAL_CTX,
  SPACE_INFO_KEY,
  SPACE_KEYS_KEY,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  _key,
  cryptoFor,
  ctxFor,
  loadKeyring,
  readStore,
  stampCreated,
  storageKeyOf,
  store,
  withSpaceLock,
  withUpdatedBy,
} from './context'
import { editedAt, liveRecords, nowIso, withoutRev } from './records'
import { asObject, openRevCounter, parseLocalRev } from './revs'
import { notifyLocalChange, writeKeysMany } from './storage'
import { afterCommit, markDataChanged, requestEntryConversion } from './events'
import { readSyncedSettingsIn } from './settings'
import type { Category, SyncedSettingsRecord } from '../domain'
import type { IdentityKeyPair } from '../spaces/spaceCrypto'
import type {
  IdentityRecord,
  LocalSpace,
  MemberProfile,
  SpaceId,
  SpaceInfoRecord,
  SpaceKeyEntry,
  SpaceKeyWrapSet,
  SpaceRole,
  SpaceShareStatus,
} from '../spaces/types'
import type { Lang } from '../../i18n/lang'
import type { SpaceCtx } from './context'

// ── Member identity (personal record `identity`) ──────────────────────────────

// The member's ECDH P-256 key pair, created on first need and stored in the
// encrypted personal record `identity` (so it syncs to the user's other
// devices). Read from the store on every call (never cached), so a lock leaves
// no identity key in memory. Needs an unlocked vault.
export async function ensureIdentityKeyPair(): Promise<IdentityKeyPair> {
  if (!_key || !store) throw new Error('LocalDb not initialized')
  const P = PERSONAL_CTX
  const { pair, wrote } = await withWriteLock([IDENTITY_KEY, SYNC_META_KEY], async () => {
    const existing = await readStore(P, 'identity')
    if (existing !== undefined) {
      return {
        pair: { publicKeyJwk: existing.publicKeyJwk, privateKeyJwk: existing.privateKeyJwk },
        wrote: false,
      }
    }
    const created = await generateIdentityKeyPair()
    const now = nowIso()
    const counter = await openRevCounter(P)
    const record: IdentityRecord = {
      id: 'identity',
      publicKeyJwk: created.publicKeyJwk,
      privateKeyJwk: created.privateKeyJwk,
      createdAt: now,
      updatedAt: now,
      rev: counter.next(),
    }
    await writeKeysMany(P, { [IDENTITY_KEY]: record }, counter)
    return { pair: created, wrote: true }
  })
  if (wrote) await afterCommit(P, [IDENTITY_KEY])
  return pair
}

export async function getIdentityPublicKey(): Promise<JsonWebKey> {
  return (await ensureIdentityKeyPair()).publicKeyJwk
}

// ── Spaces API (no UI yet) ────────────────────────────────────────────────────

const SPACE_NAME_MAX = 60

function toLocalSpace(entry: SpaceKeyEntry): LocalSpace {
  return {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    keyVersion: entry.keyVersion,
    joinedAt: entry.joinedAt,
  }
}

// The live Family spaces of this device (no key bytes), oldest first. Empty
// while locked.
export async function listLocalSpaces(): Promise<Array<LocalSpace>> {
  if (!_key || !store) return []
  if (keyringNeedsLoad()) await loadKeyring()
  const held = new Set(heldSpaceIds())
  const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
  return entries
    .filter((e) => isLive(e) && held.has(e.id))
    .map(toLocalSpace)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
}

// Creates the Family space: a new id and space key, the personal spaceKeys
// entry (owner, version 1), and in the space spaceInfo, the default expense
// and income categories in `lang` and syncedSettings with the personal main
// currency and rates switch. Everything, with both meta:sync counters, is
// written in ONE setMany. At most one live Family space.
export async function createLocalSpace(input: {
  name: string
  lang?: Lang
}): Promise<LocalSpace> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > SPACE_NAME_MAX) {
    throw new SpaceError('invalid-name', 'A space name needs 1 to 60 characters')
  }
  const dek = _key
  const s = store
  if (!dek || !s) throw new Error('LocalDb not initialized')
  const lang = input.lang ?? getLang()
  const member = await getCurrentMemberId()
  const personalSettings = await readSyncedSettingsIn(PERSONAL_CTX)
  const spaceId = crypto.randomUUID()
  const fam = ctxFor(spaceId)
  const skBytes = generateSpaceKey()
  const indexKeyBytes = generateIndexKey()
  const sk = await importSpaceKey(skBytes)
  const familyBases = [SPACE_INFO_KEY, 'categories', 'incomeCategories', SYNCED_SETTINGS_KEY]

  const space = await withWriteLock(
    [
      SPACE_KEYS_KEY,
      SYNC_META_KEY,
      ...[...familyBases, SYNC_META_KEY].map((k) => storageKeyOf(fam, k)),
    ],
    async () => {
      const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
      if (entries.some(isLive)) {
        throw new SpaceError('family-space-exists', 'A Family space already exists')
      }
      const now = nowIso()
      const personalCounter = await openRevCounter(PERSONAL_CTX)
      const entry: SpaceKeyEntry = {
        id: spaceId,
        keyVersion: 1,
        key: bytesToBase64(skBytes),
        indexKey: bytesToBase64(indexKeyBytes),
        name,
        role: 'owner',
        joinedAt: now,
        updatedAt: now,
        rev: personalCounter.next(),
      }

      // The new space's counter (normally absent: starts at 0).
      const familyMetaKey = storageKeyOf(fam, SYNC_META_KEY)
      const familyMetaRaw = await get<unknown>(familyMetaKey, s)
      let familyRev = parseLocalRev(familyMetaRaw)
      const next = () => ++familyRev
      const stamp = <T extends { createdBy?: string; updatedBy?: string }>(r: T): T =>
        stampCreated<T>(member, r)
      const info = stamp<SpaceInfoRecord>({
        id: 'space',
        name,
        createdAt: now,
        updatedAt: now,
        rev: next(),
      })
      const categories: Array<Category> = defaultExpenseCategories(lang).map((c) =>
        stamp<Category>({
          id: crypto.randomUUID(),
          name: c.name,
          icon: c.icon,
          updatedAt: now,
          rev: next(),
        }),
      )
      const incomeCategories: Array<Category> = defaultIncomeCategories(lang).map((c) =>
        stamp<Category>({
          id: crypto.randomUUID(),
          name: c.name,
          icon: c.icon,
          updatedAt: now,
          rev: next(),
        }),
      )
      const settings: SyncedSettingsRecord = {
        id: 'settings',
        mainCurrency: personalSettings.mainCurrency,
        fetchExchangeRates: personalSettings.fetchExchangeRates,
        updatedAt: now,
        rev: next(),
      }
      if (member) settings.updatedBy = member

      const familyValues: Record<string, unknown> = {
        [SPACE_INFO_KEY]: info,
        categories,
        incomeCategories,
        [SYNCED_SETTINGS_KEY]: settings,
      }
      const writes: Array<[IDBValidKey, unknown]> = [
        [SPACE_KEYS_KEY, await encryptValue(dek, [...entries, entry])],
        [SYNC_META_KEY, { ...personalCounter.base, localRev: personalCounter.last }],
      ]
      for (const [base, value] of Object.entries(familyValues)) {
        writes.push([storageKeyOf(fam, base), await encryptValue(sk, value)])
      }
      writes.push([familyMetaKey, { ...(asObject(familyMetaRaw) ?? {}), localRev: familyRev }])
      if (_key !== dek) throw new Error('LocalDb not initialized')
      await setMany(writes, s)
      return toLocalSpace(entry)
    },
  )
  skBytes.fill(0)
  indexKeyBytes.fill(0)
  markKeyringStale()
  notifyLocalChange()
  postChanged([SPACE_KEYS_KEY])
  postChanged(familyBases, spaceId)
  await markDataChanged()
  requestEntryConversion()
  return space
}

// Leaves the space on this device and, through personal sync, on the user's
// other devices: the spaceKeys entry becomes a tombstone without any key
// material (a personal user write), then every `space:<id>:*` key is deleted
// (quarantine copies are kept). Needs only the DEK. An unknown or already
// forgotten id deletes leftover keys only.
export async function forgetLocalSpace(spaceId: SpaceId): Promise<void> {
  if (!isValidFamilySpaceId(spaceId)) return
  const s = store
  if (!_key || !s) throw new Error('LocalDb not initialized')
  const P = PERSONAL_CTX
  const wrote = await withWriteLock([SPACE_KEYS_KEY, SYNC_META_KEY], async () => {
    const entries = (await readStore(P, 'spaceKeys')) ?? []
    const index = entries.findIndex((e) => e.id === spaceId && isLive(e))
    if (index === -1) return false
    const counter = await openRevCounter(P)
    const now = editedAt(entries[index].updatedAt)
    const tombstone: SpaceKeyEntry = {
      ...entries[index],
      key: '',
      deletedAt: now,
      updatedAt: now,
      rev: counter.next(),
    }
    delete tombstone.previousKeys
    delete tombstone.indexKey
    delete tombstone.wrappedFor
    const next = [...entries]
    next[index] = tombstone
    await writeKeysMany(P, { [SPACE_KEYS_KEY]: next }, counter)
    return true
  })
  markKeyringStale()
  const prefix = keyFor(spaceId, '')
  const doomed = (await keys(s)).filter(
    (k): k is string => typeof k === 'string' && k.startsWith(prefix),
  )
  if (doomed.length > 0) await delMany(doomed, s)
  if (wrote) await afterCommit(P, [SPACE_KEYS_KEY])
}

// ── Family share state on the spaceKeys entries (spec §22) ────────────────────

export interface AdoptSpaceKeyInput {
  spaceId: string
  keyVersion: number
  sk: Uint8Array
  indexKey: Uint8Array
  name: string
  role: SpaceRole
}

export interface SpaceEntryPatch {
  name?: string
  role?: SpaceRole
  status?: SpaceShareStatus
  wrappedFor?: SpaceKeyWrapSet
}

// The live spaceKeys entries (key material included, rev stripped); [] while
// locked.
export async function listSpaceKeyEntries(): Promise<Array<SpaceKeyEntry>> {
  if (!_key || !store) return []
  const entries = (await readStore(PERSONAL_CTX, 'spaceKeys')) ?? []
  return entries.filter((e) => isLive(e) && isValidFamilySpaceId(e.id)).map(withoutRev)
}

export async function getSpaceKeyEntry(spaceId: string): Promise<SpaceKeyEntry | null> {
  return (await listSpaceKeyEntries()).find((e) => e.id === spaceId) ?? null
}

// Runs `change` on the live entry `spaceId` under the spaceKeys + meta:sync
// lock (a personal user write). `change` returns the new entry, or null for
// "nothing to write"; a written entry gets updatedAt and a rev. Returns the
// resulting live entry without rev (null when there is none).
async function changeSpaceEntry(
  spaceId: string,
  change: (current: SpaceKeyEntry | null, now: string) => SpaceKeyEntry | null,
): Promise<{ entry: SpaceKeyEntry | null; wrote: boolean }> {
  const s = store
  if (!_key || !s) throw new Error('LocalDb not initialized')
  const P = PERSONAL_CTX
  const result = await withWriteLock([SPACE_KEYS_KEY, SYNC_META_KEY], async () => {
    const entries = (await readStore(P, 'spaceKeys')) ?? []
    const liveIndex = entries.findIndex((e) => e.id === spaceId && isLive(e))
    const current = liveIndex === -1 ? null : entries[liveIndex]
    const previous = current ?? entries.find((e) => e.id === spaceId)
    const now = editedAt(previous?.updatedAt)
    const changed = change(current === null ? null : withoutRev(current), now)
    if (changed === null) {
      return { entry: current === null ? null : withoutRev(current), wrote: false }
    }
    const counter = await openRevCounter(P)
    const written: SpaceKeyEntry = { ...changed, updatedAt: now, rev: counter.next() }
    const next = [...entries]
    if (liveIndex !== -1) {
      next[liveIndex] = written
    } else {
      // Replaces a tombstone of the same id (a re-join), else appends.
      const tombIndex = next.findIndex((e) => e.id === spaceId)
      if (tombIndex === -1) next.push(written)
      else next[tombIndex] = written
    }
    await writeKeysMany(P, { [SPACE_KEYS_KEY]: next }, counter)
    return { entry: withoutRev(written), wrote: true }
  })
  if (result.wrote) await afterCommit(P, [SPACE_KEYS_KEY])
  return result
}

// Stores a key version received for a Family space (join, rotation, a version
// another owner device made). A personal user write, so it reaches the user's
// other devices through personal sync. See the plan (§2) for the rules.
export async function adoptSpaceKey(input: AdoptSpaceKeyInput): Promise<SpaceKeyEntry> {
  if (!isValidFamilySpaceId(input.spaceId)) {
    throw new SpaceError('unknown-space', 'Invalid space id')
  }
  if (
    !Number.isInteger(input.keyVersion) ||
    input.keyVersion < 1 ||
    input.sk.byteLength !== 32 ||
    input.indexKey.byteLength !== 32
  ) {
    throw new SpaceKeyError('invalid', 'Invalid space key')
  }
  const key = bytesToBase64(input.sk)
  const indexKey = bytesToBase64(input.indexKey)
  const { entry } = await changeSpaceEntry(input.spaceId, (current, now) => {
    if (current === null) {
      return {
        id: input.spaceId,
        keyVersion: input.keyVersion,
        key,
        indexKey,
        name: input.name,
        role: input.role,
        status: 'active',
        joinedAt: now,
        updatedAt: now,
      }
    }
    if (current.indexKey !== undefined && current.indexKey !== indexKey) {
      throw new SpaceKeyError('invalid', 'The index key of a space never changes')
    }
    const next: SpaceKeyEntry = { ...current }
    let changed = false
    if (current.indexKey === undefined) {
      next.indexKey = indexKey
      changed = true
    }
    const previous = current.previousKeys ?? []
    if (input.keyVersion > current.keyVersion) {
      next.previousKeys = [
        { keyVersion: current.keyVersion, key: current.key },
        ...previous.filter((p) => p.keyVersion !== current.keyVersion),
      ].sort((a, b) => b.keyVersion - a.keyVersion)
      next.keyVersion = input.keyVersion
      next.key = key
      changed = true
    } else if (input.keyVersion === current.keyVersion) {
      // The server's key for a version wins (it is what members hold).
      if (current.key !== key) {
        next.key = key
        changed = true
      }
    } else {
      const held = previous.find((p) => p.keyVersion === input.keyVersion)
      if (!held || held.key !== key) {
        next.previousKeys = [
          ...previous.filter((p) => p.keyVersion !== input.keyVersion),
          { keyVersion: input.keyVersion, key },
        ].sort((a, b) => b.keyVersion - a.keyVersion)
        changed = true
      }
    }
    return changed ? next : null
  })
  if (!entry) throw new SpaceError('unknown-space', 'The space key was not stored')
  return entry
}

function sameWrapSet(a: SpaceKeyWrapSet | undefined, b: SpaceKeyWrapSet): boolean {
  if (!a || a.keyVersion !== b.keyVersion || a.userIds.length !== b.userIds.length) {
    return false
  }
  const ids = new Set(a.userIds)
  return b.userIds.every((id) => ids.has(id))
}

// Patches name / role / status / wrappedFor of a live entry (a personal user
// write). Nothing changed: no write, no rev. Unknown id: null.
export async function updateSpaceEntry(
  spaceId: string,
  patch: SpaceEntryPatch,
): Promise<SpaceKeyEntry | null> {
  if (!isValidFamilySpaceId(spaceId)) return null
  const { entry } = await changeSpaceEntry(spaceId, (current) => {
    if (current === null) return null
    const next: SpaceKeyEntry = { ...current }
    let changed = false
    if (patch.name !== undefined && patch.name !== current.name) {
      next.name = patch.name
      changed = true
    }
    if (patch.role !== undefined && patch.role !== current.role) {
      next.role = patch.role
      changed = true
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      next.status = patch.status
      changed = true
    }
    if (patch.wrappedFor !== undefined && !sameWrapSet(current.wrappedFor, patch.wrappedFor)) {
      next.wrappedFor = {
        keyVersion: patch.wrappedFor.keyVersion,
        userIds: [...patch.wrappedFor.userIds],
      }
      changed = true
    }
    return changed ? next : null
  })
  return entry
}

// Gives a live entry without an index key (a run A space) a new random one.
export async function ensureSpaceIndexKey(spaceId: string): Promise<SpaceKeyEntry> {
  const fresh = generateIndexKey()
  try {
    const { entry } = await changeSpaceEntry(spaceId, (current) => {
      if (current === null) {
        throw new SpaceError('unknown-space', 'The space is not held on this device')
      }
      if (current.indexKey !== undefined && current.indexKey !== '') return null
      return { ...current, indexKey: bytesToBase64(fresh) }
    })
    if (!entry) throw new SpaceError('unknown-space', 'The space is not held on this device')
    return entry
  } finally {
    fresh.fill(0)
  }
}

// Renames the space in its own spaceInfo record (a Family user write).
export async function updateSpaceInfo(
  spaceId: SpaceId,
  input: { name: string },
): Promise<SpaceInfoRecord> {
  const ctx = familyCtx(spaceId)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > SPACE_NAME_MAX) {
    throw new SpaceError('invalid-name', 'A space name needs 1 to 60 characters')
  }
  if (!_key) throw new SpaceLockedError(spaceId)
  await cryptoFor(spaceId)
  const info = await withSpaceLock(ctx, [SPACE_INFO_KEY, SYNC_META_KEY], async () => {
    const existing = await readStore(ctx, 'spaceInfo')
    const counter = await openRevCounter(ctx)
    const now = editedAt(existing?.updatedAt)
    const base: SpaceInfoRecord = existing
      ? withoutRev(existing)
      : { id: 'space', name, createdAt: now, updatedAt: now }
    const updated = withUpdatedBy<SpaceInfoRecord>(
      { ...base, name, updatedAt: now },
      counter.member ?? null,
    )
    await writeKeysMany(ctx, { [SPACE_INFO_KEY]: { ...updated, rev: counter.next() } }, counter)
    return updated
  })
  await afterCommit(ctx, [SPACE_INFO_KEY])
  return info
}

function familyCtx(spaceId: SpaceId): SpaceCtx {
  if (spaceId === PERSONAL_SPACE_ID) {
    throw new SpaceError('unknown-space', 'The personal space has no space details')
  }
  return ctxFor(spaceId)
}

// The space details (without rev), or null before any were written.
export async function getSpaceInfo(spaceId: SpaceId): Promise<SpaceInfoRecord | null> {
  const ctx = familyCtx(spaceId)
  if (!_key) throw new SpaceLockedError(spaceId)
  const info = await readStore(ctx, 'spaceInfo')
  return info === undefined ? null : withoutRev(info)
}

// The live member profiles (without rev).
export async function getMemberProfiles(spaceId: SpaceId): Promise<Array<MemberProfile>> {
  const ctx = familyCtx(spaceId)
  if (!_key) throw new SpaceLockedError(spaceId)
  return liveRecords((await readStore(ctx, 'memberProfiles')) ?? [])
}

// Creates or replaces the profile `id` (a Family user write).
export async function upsertMemberProfile(
  spaceId: SpaceId,
  input: { id: string; displayName: string; color: string },
): Promise<MemberProfile> {
  const ctx = familyCtx(spaceId)
  if (!_key) throw new SpaceLockedError(spaceId)
  await cryptoFor(spaceId)
  const profile = await withSpaceLock(ctx, [MEMBER_PROFILES_KEY, SYNC_META_KEY], async () => {
    const list = (await readStore(ctx, 'memberProfiles')) ?? []
    const index = list.findIndex((p) => p.id === input.id)
    const counter = await openRevCounter(ctx)
    const updated: MemberProfile = {
      ...(index === -1 ? {} : withoutRev(list[index])),
      id: input.id,
      displayName: input.displayName,
      color: input.color,
      updatedAt: editedAt(index === -1 ? undefined : list[index].updatedAt),
    }
    delete updated.deletedAt
    const stamped = withUpdatedBy(updated, counter.member ?? null)
    const next = [...list]
    if (index === -1) next.push({ ...stamped, rev: counter.next() })
    else next[index] = { ...stamped, rev: counter.next() }
    await writeKeysMany(ctx, { [MEMBER_PROFILES_KEY]: next }, counter)
    return stamped
  })
  await afterCommit(ctx, [MEMBER_PROFILES_KEY])
  return profile
}
