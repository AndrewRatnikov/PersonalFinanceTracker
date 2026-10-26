// Vault v2 (docs/free-tier-spec.md §4): key hierarchy, header, brute-force
// delay, recovery key and the v1 -> v2 migration.
//
//   password ──PBKDF2-SHA256 (600k, salt)──► KEK_pw ─┐
//                                                    ├─ AES-GCM wrap ─► DEK
//   recovery key ──HKDF-SHA256 (salt)──────► KEK_rc ─┘
//
// The DEK is a random 256-bit key. In use it is a non-extractable CryptoKey
// held by localDb (`unlockLocalDb`); its raw bytes only exist while a vault is
// created or re-wrapped and are zeroed afterwards. The header lives in the
// same IndexedDB store as the data under `meta:vault`; the brute-force counter
// lives under `meta:settings`. The only state this module keeps is a WeakMap of
// HKDF material keyed by the in-use DEK (for getSyncKeys); it does nothing at
// import time.
//
// Sync keys (docs/free-tier-spec.md §18, src/lib/cloud/types.ts): importDek,
// the one place raw DEK bytes become the in-use DEK (create, v1 migration,
// every unlock and openHeaderWithSecret), imports the same bytes a second time
// as non-extractable HKDF material. getSyncKeys() derives K_index / K_data from
// it for the DEK currently held by localDb. The DEK stays a non-extractable
// AES-GCM key and is never exported; only the two purpose-bound keys leave
// this module.
//
// Every operation that produces a new recovery key (createVault, the v1
// migration, regenerateRecoveryKey) writes `recoveryKeyConfirmed: false` into
// `meta:settings` in the same transaction as the header; the UI sets it to true
// once the user confirms the key was saved. The key itself is never stored.

import { get, keys, set, setMany } from 'idb-keyval'

import {
  RECOVERY_KEY_BYTES,
  base64ToBytes,
  bytesToBase64,
  checkKeyVerifier,
  decryptValue,
  deriveKey,
  encodeRecoveryKey,
  encryptValue,
  parseRecoveryKey,
  readDeviceSalt,
} from './crypto'
import { deriveSyncKeys } from './cloud/recordCrypto'
import { isDataStorageKey } from './dataErrors'
import {
  getLocalDbKey,
  getLocalStore,
  hasLocalData,
  rekeyLiveData,
  unlockLocalDb,
  wipeLocalDbKey,
} from './localDb'
import { postLock } from './syncChannel'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'
import type { SyncKeys } from './cloud/types'
import type { RekeyResult } from './localDb'

export const META_VAULT_KEY = 'meta:vault'
export const META_SETTINGS_KEY = 'meta:settings'
export const PBKDF2_ITERATIONS = 600_000

const VERIFIER_SENTINEL = 'minima-verify-v2'
const RECOVERY_HKDF_INFO = 'minima-recovery-kek-v2'
const DEK_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12

const MAX_FREE_ATTEMPTS = 5
const BASE_DELAY_MS = 5000
const MAX_DELAY_MS = 300_000

const V1_SALT_PREFIX = 'minima_device_salt_'
const V1_VERIFIER_PREFIX = 'minima_key_verify_'
const OFFLINE_USER_KEY = 'minima_offline_user'

export type VaultState = 'none' | 'v1' | 'v2' | 'orphaned'

export interface VaultHeaderV2 {
  v: 2
  vaultId: string
  createdAt: string
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string }
  wrappedByPassword: { iv: string; ct: string }
  recovery: { salt: string; iv: string; ct: string }
  verifier: { iv: string; ct: string }
}

export interface MetaSettings {
  failedUnlockAttempts: number
  unlockBlockedUntil: string | null
}

export interface UnlockResult {
  // Non-null only when this unlock migrated a v1 store.
  recoveryKey: string | null
}

// The secret that opens a cloud vault header on a fresh device: the password,
// or the recovery key plus the new password the DEK is re-wrapped with.
export type CloudVaultSecret =
  | { password: string }
  | { recoveryKey: string; newPassword: string }

export type HeaderAdoption = 'adopted' | 'unchanged' | 'mismatch'

export type JoinCloudVaultResult = RekeyResult

export type VaultErrorCode =
  | 'incorrect-password'
  | 'incorrect-recovery-key'
  | 'damaged'
  | 'throttled'
  | 'invalid-state'

export class VaultError extends Error {
  readonly code: VaultErrorCode
  readonly retryAfterMs: number

  constructor(code: VaultErrorCode, message: string, retryAfterMs = 0) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

function incorrectPassword(): VaultError {
  return new VaultError('incorrect-password', 'Incorrect password')
}

function incorrectRecoveryKey(): VaultError {
  return new VaultError(
    'incorrect-recovery-key',
    "This recovery key doesn't match",
  )
}

function damaged(): VaultError {
  return new VaultError('damaged', 'Vault damaged')
}

function noVault(): VaultError {
  return new VaultError('invalid-state', 'No vault on this device')
}

// ── Brute-force delay (§4.4) ──────────────────────────────────────────────────

export function unlockDelayMs(failedAttempts: number): number {
  if (failedAttempts < MAX_FREE_ATTEMPTS) return 0
  return Math.min(
    BASE_DELAY_MS * 2 ** (failedAttempts - MAX_FREE_ATTEMPTS),
    MAX_DELAY_MS,
  )
}

type StoredSettings = Partial<MetaSettings> & Record<string, unknown>

async function readSettingsRaw(store: UseStore): Promise<StoredSettings | null> {
  const raw = await get<unknown>(META_SETTINGS_KEY, store)
  if (!raw || typeof raw !== 'object') return null
  return raw as StoredSettings
}

// The `meta:settings` entry that marks a freshly produced recovery key as not
// yet confirmed, keeping every other stored field. Only a boolean is written.
async function unconfirmedKeySettings(
  store: UseStore,
): Promise<[string, StoredSettings]> {
  return [
    META_SETTINGS_KEY,
    { ...(await readSettingsRaw(store)), recoveryKeyConfirmed: false },
  ]
}

function attemptsOf(s: StoredSettings | null): number {
  const n = s?.failedUnlockAttempts
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

function blockedUntilOf(s: StoredSettings | null): number {
  const iso = s?.unlockBlockedUntil
  if (typeof iso !== 'string') return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

async function assertNotThrottled(store: UseStore): Promise<void> {
  const s = await readSettingsRaw(store)
  const remaining = blockedUntilOf(s) - Date.now()
  if (remaining > 0) {
    throw new VaultError(
      'throttled',
      `Too many attempts. Try again in ${Math.ceil(remaining / 1000)} s.`,
      remaining,
    )
  }
}

async function recordFailure(store: UseStore): Promise<void> {
  await withWriteLock(META_SETTINGS_KEY, async () => {
    const s = await readSettingsRaw(store)
    const attempts = attemptsOf(s) + 1
    const delay = unlockDelayMs(attempts)
    const next: MetaSettings = {
      failedUnlockAttempts: attempts,
      unlockBlockedUntil:
        delay > 0 ? new Date(Date.now() + delay).toISOString() : null,
    }
    await set(META_SETTINGS_KEY, { ...s, ...next }, store)
  })
}

async function recordSuccess(store: UseStore): Promise<void> {
  await withWriteLock(META_SETTINGS_KEY, async () => {
    const s = await readSettingsRaw(store)
    if (!s) return
    if (s.failedUnlockAttempts === 0 && s.unlockBlockedUntil === null) return
    const next: MetaSettings = { failedUnlockAttempts: 0, unlockBlockedUntil: null }
    await set(META_SETTINGS_KEY, { ...s, ...next }, store)
  })
}

// ── Key primitives ────────────────────────────────────────────────────────────

const utf8 = new TextEncoder()

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

async function derivePasswordKek(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    utf8.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function deriveRecoveryKek(
  recoveryBytes: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    recoveryBytes,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: utf8.encode(RECOVERY_HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function seal(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(IV_BYTES)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) }
}

// Returns null when the key doesn't open the box (wrong secret).
async function open(
  key: CryptoKey,
  box: { iv: string; ct: string },
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(box.iv) },
      key,
      base64ToBytes(box.ct),
    )
    return new Uint8Array(pt)
  } catch {
    return null
  }
}

// HKDF material for the sync keys, keyed by the in-use DEK. Filled by
// importDek; an entry goes away with its DEK.
const syncKeyMaterial = new WeakMap<
  CryptoKey,
  { base: CryptoKey; keys?: Promise<SyncKeys> }
>()

async function importDek(dekBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const dek = await crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
  // The same bytes again, before the caller zeroes them, as HKDF material.
  const base = await crypto.subtle.importKey('raw', dekBytes, 'HKDF', false, [
    'deriveKey',
  ])
  syncKeyMaterial.set(dek, { base })
  return dek
}

async function wrapWithPassword(
  password: string,
  dekBytes: Uint8Array<ArrayBuffer>,
): Promise<Pick<VaultHeaderV2, 'kdf' | 'wrappedByPassword'>> {
  const salt = randomBytes(SALT_BYTES)
  const kek = await derivePasswordKek(password, salt, PBKDF2_ITERATIONS)
  return {
    kdf: {
      alg: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    wrappedByPassword: await seal(kek, dekBytes),
  }
}

async function wrapWithRecoveryKey(
  recoveryBytes: Uint8Array<ArrayBuffer>,
  dekBytes: Uint8Array<ArrayBuffer>,
): Promise<VaultHeaderV2['recovery']> {
  const salt = randomBytes(SALT_BYTES)
  const kek = await deriveRecoveryKek(recoveryBytes, salt)
  const box = await seal(kek, dekBytes)
  return { salt: bytesToBase64(salt), ...box }
}

async function buildHeader(
  password: string,
  dekBytes: Uint8Array<ArrayBuffer>,
  recoveryBytes: Uint8Array<ArrayBuffer>,
  dek: CryptoKey,
): Promise<VaultHeaderV2> {
  const pw = await wrapWithPassword(password, dekBytes)
  return {
    v: 2,
    vaultId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    kdf: pw.kdf,
    wrappedByPassword: pw.wrappedByPassword,
    recovery: await wrapWithRecoveryKey(recoveryBytes, dekBytes),
    verifier: await seal(dek, utf8.encode(VERIFIER_SENTINEL)),
  }
}

// ── Header access ─────────────────────────────────────────────────────────────

function requireStore(): UseStore {
  const store = getLocalStore()
  if (!store) throw noVault()
  return store
}

function isHeader(value: unknown): value is VaultHeaderV2 {
  if (!value || typeof value !== 'object') return false
  const h = value as Partial<VaultHeaderV2>
  return (
    h.v === 2 &&
    typeof h.kdf?.salt === 'string' &&
    typeof h.kdf.iterations === 'number' &&
    typeof h.wrappedByPassword?.ct === 'string' &&
    typeof h.recovery?.ct === 'string' &&
    typeof h.verifier?.ct === 'string'
  )
}

async function readHeader(store: UseStore): Promise<VaultHeaderV2> {
  const raw = await get<unknown>(META_VAULT_KEY, store)
  if (raw === undefined) throw noVault()
  if (!isHeader(raw)) throw damaged()
  return raw
}

async function writeHeader(store: UseStore, header: VaultHeaderV2) {
  await set(META_VAULT_KEY, header, store)
}

// Unwraps the raw DEK with the password or the recovery key. Applies the
// shared brute-force counter: throttled attempts are rejected before deriving
// anything, a wrong secret is counted. The caller must zero the result.
async function unwrapDek(
  store: UseStore,
  header: VaultHeaderV2,
  secret: { password: string } | { recoveryKey: string },
): Promise<Uint8Array<ArrayBuffer>> {
  await assertNotThrottled(store)
  let dekBytes: Uint8Array<ArrayBuffer> | null = null
  if ('password' in secret) {
    const kek = await derivePasswordKek(
      secret.password,
      base64ToBytes(header.kdf.salt),
      header.kdf.iterations,
    )
    dekBytes = await open(kek, header.wrappedByPassword)
  } else {
    const recoveryBytes = parseRecoveryKey(secret.recoveryKey)
    if (recoveryBytes) {
      try {
        const kek = await deriveRecoveryKek(
          recoveryBytes,
          base64ToBytes(header.recovery.salt),
        )
        dekBytes = await open(kek, header.recovery)
      } finally {
        recoveryBytes.fill(0)
      }
    }
  }
  if (!dekBytes || dekBytes.length !== DEK_BYTES) {
    dekBytes?.fill(0)
    await recordFailure(store)
    throw 'password' in secret ? incorrectPassword() : incorrectRecoveryKey()
  }
  return dekBytes
}

// Imports the DEK and checks it against the header verifier. A DEK that
// unwrapped but fails the verifier means the vault is damaged.
async function openDek(
  header: Pick<VaultHeaderV2, 'verifier'>,
  dekBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  let dek: CryptoKey
  try {
    dek = await importDek(dekBytes)
  } catch {
    throw damaged()
  }
  const plain = await open(dek, header.verifier)
  if (!plain || new TextDecoder().decode(plain) !== VERIFIER_SENTINEL) {
    throw damaged()
  }
  return dek
}

// ── Backup headers (§7) ───────────────────────────────────────────────────────

// The local vault header. Throws VaultError('invalid-state') without a vault
// and VaultError('damaged') for a malformed header.
export async function getVaultHeader(): Promise<VaultHeaderV2> {
  return readHeader(requireStore())
}

async function tryOpen(
  deriveKek: () => Promise<CryptoKey>,
  box: { iv: string; ct: string },
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const bytes = await open(await deriveKek(), box)
    if (bytes && bytes.length === DEK_BYTES) return bytes
    bytes?.fill(0)
    return null
  } catch {
    return null
  }
}

// Unwraps the DEK of any header (e.g. a backup's) with a password or a
// recovery key. A secret that parses as a recovery key is tried as one first,
// then as a password. Returns null when neither opens the DEK; throws
// VaultError('damaged') when the DEK unwraps but fails the verifier. Never
// touches the local brute-force counter: the secret is checked against the
// given header, not against this device.
export async function openHeaderWithSecret(
  header: Pick<
    VaultHeaderV2,
    'kdf' | 'wrappedByPassword' | 'recovery' | 'verifier'
  >,
  secret: string,
): Promise<CryptoKey | null> {
  if (!secret) return null

  let dekBytes: Uint8Array<ArrayBuffer> | null = null
  const recoveryBytes = parseRecoveryKey(secret)
  if (recoveryBytes) {
    try {
      dekBytes = await tryOpen(
        () => deriveRecoveryKek(recoveryBytes, base64ToBytes(header.recovery.salt)),
        header.recovery,
      )
    } finally {
      recoveryBytes.fill(0)
    }
  }
  if (!dekBytes) {
    dekBytes = await tryOpen(
      () =>
        derivePasswordKek(
          secret,
          base64ToBytes(header.kdf.salt),
          header.kdf.iterations,
        ),
      header.wrappedByPassword,
    )
  }
  if (!dekBytes) return null

  try {
    return await openDek(header, dekBytes)
  } finally {
    dekBytes.fill(0)
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

function localStorageKeys(): Array<string> {
  if (typeof localStorage === 'undefined') return []
  const result: Array<string> = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k !== null) result.push(k)
  }
  return result
}

function v1UserIds(): Array<string> {
  return localStorageKeys()
    .filter((k) => k.startsWith(V1_VERIFIER_PREFIX))
    .map((k) => k.slice(V1_VERIFIER_PREFIX.length))
    .sort()
}

export async function getVaultState(): Promise<VaultState> {
  const store = getLocalStore()
  if (!store) return 'none'
  const header = await get<unknown>(META_VAULT_KEY, store)
  if (header !== undefined) return 'v2'
  if (v1UserIds().length > 0) return 'v1'
  if (await hasLocalData()) return 'orphaned'
  return 'none'
}

// ── Operations ────────────────────────────────────────────────────────────────

export async function createVault(
  password: string,
): Promise<{ recoveryKey: string }> {
  const store = requireStore()
  return withWriteLock([META_VAULT_KEY, META_SETTINGS_KEY], async () => {
    const state = await getVaultState()
    if (state !== 'none') {
      throw new VaultError(
        'invalid-state',
        state === 'v2'
          ? 'A vault already exists on this device'
          : 'This device already has data that is not in a new vault',
      )
    }
    const dekBytes = randomBytes(DEK_BYTES)
    const recoveryBytes = randomBytes(RECOVERY_KEY_BYTES)
    try {
      const dek = await importDek(dekBytes)
      const header = await buildHeader(password, dekBytes, recoveryBytes, dek)
      // One transaction: the header never exists without the unconfirmed flag.
      await setMany(
        [[META_VAULT_KEY, header], await unconfirmedKeySettings(store)],
        store,
      )
      unlockLocalDb(dek)
      return { recoveryKey: encodeRecoveryKey(recoveryBytes) }
    } finally {
      dekBytes.fill(0)
      recoveryBytes.fill(0)
    }
  })
}

export async function unlockWithPassword(
  password: string,
): Promise<UnlockResult> {
  const store = requireStore()
  const state = await getVaultState()
  if (state === 'v1') return migrateV1(store, password)
  if (state !== 'v2') throw noVault()

  const header = await readHeader(store)
  const dekBytes = await unwrapDek(store, header, { password })
  let dek: CryptoKey
  try {
    dek = await openDek(header, dekBytes)
  } finally {
    dekBytes.fill(0)
  }
  await recordSuccess(store)
  unlockLocalDb(dek)
  return { recoveryKey: null }
}

// Checks the password against the v2 vault without unlocking it: the key in
// memory and the header stay as they are. Counts toward the brute-force
// counter like an unlock attempt; success resets it.
export async function verifyPassword(password: string): Promise<void> {
  const store = requireStore()
  if ((await getVaultState()) !== 'v2') throw noVault()

  const header = await readHeader(store)
  const dekBytes = await unwrapDek(store, header, { password })
  try {
    await openDek(header, dekBytes)
  } finally {
    dekBytes.fill(0)
  }
  await recordSuccess(store)
}

export async function unlockWithRecoveryKey(key: string): Promise<void> {
  const store = requireStore()
  if ((await getVaultState()) !== 'v2') throw noVault()

  const header = await readHeader(store)
  const dekBytes = await unwrapDek(store, header, { recoveryKey: key })
  let dek: CryptoKey
  try {
    dek = await openDek(header, dekBytes)
  } finally {
    dekBytes.fill(0)
  }
  await recordSuccess(store)
  unlockLocalDb(dek)
}

export async function resetPasswordWithRecoveryKey(
  key: string,
  next: string,
): Promise<void> {
  const store = requireStore()
  if ((await getVaultState()) !== 'v2') throw noVault()

  const dek = await withWriteLock(META_VAULT_KEY, async () => {
    const header = await readHeader(store)
    const dekBytes = await unwrapDek(store, header, { recoveryKey: key })
    try {
      const opened = await openDek(header, dekBytes)
      const pw = await wrapWithPassword(next, dekBytes)
      await writeHeader(store, {
        ...header,
        kdf: pw.kdf,
        wrappedByPassword: pw.wrappedByPassword,
      })
      return opened
    } finally {
      dekBytes.fill(0)
    }
  })
  await recordSuccess(store)
  unlockLocalDb(dek)
  emitHeaderChange()
}

export async function changePassword(
  current: string,
  next: string,
): Promise<void> {
  const store = requireStore()
  if ((await getVaultState()) !== 'v2') throw noVault()

  await withWriteLock(META_VAULT_KEY, async () => {
    const header = await readHeader(store)
    const dekBytes = await unwrapDek(store, header, { password: current })
    try {
      await openDek(header, dekBytes)
      const pw = await wrapWithPassword(next, dekBytes)
      await writeHeader(store, {
        ...header,
        kdf: pw.kdf,
        wrappedByPassword: pw.wrappedByPassword,
      })
    } finally {
      dekBytes.fill(0)
    }
  })
  await recordSuccess(store)
  emitHeaderChange()
}

export async function regenerateRecoveryKey(
  password: string,
): Promise<{ recoveryKey: string }> {
  const store = requireStore()
  if ((await getVaultState()) !== 'v2') throw noVault()

  const recoveryKey = await withWriteLock(META_VAULT_KEY, async () => {
    const header = await readHeader(store)
    const dekBytes = await unwrapDek(store, header, { password })
    const recoveryBytes = randomBytes(RECOVERY_KEY_BYTES)
    try {
      await openDek(header, dekBytes)
      const recovery = await wrapWithRecoveryKey(recoveryBytes, dekBytes)
      // Same nesting order (vault, then settings) as recordFailure in unwrapDek.
      await withWriteLock(META_SETTINGS_KEY, async () =>
        setMany(
          [
            [META_VAULT_KEY, { ...header, recovery }],
            await unconfirmedKeySettings(store),
          ],
          store,
        ),
      )
      return encodeRecoveryKey(recoveryBytes)
    } finally {
      dekBytes.fill(0)
      recoveryBytes.fill(0)
    }
  })
  await recordSuccess(store)
  emitHeaderChange()
  return { recoveryKey }
}

export function lockVault(): void {
  wipeLocalDbKey()
}

// K_index / K_data of the unlocked vault (format in src/lib/cloud/types.ts).
// The same keys object for the whole session. Rejects with
// VaultError('invalid-state') while locked.
export async function getSyncKeys(): Promise<SyncKeys> {
  const dek = getLocalDbKey()
  if (!dek) throw new VaultError('invalid-state', 'Vault is locked')
  const entry = syncKeyMaterial.get(dek)
  if (!entry) throw new VaultError('invalid-state', 'Sync keys are not available')
  if (!entry.keys) {
    const derived = deriveSyncKeys(entry.base)
    entry.keys = derived
    // A failed derivation is not cached, so the next call tries again.
    derived.catch(() => {
      if (entry.keys === derived) entry.keys = undefined
    })
  }
  return entry.keys
}

// ── Header changes and cloud vaults (sync, spec §19) ──────────────────────────

const headerListeners = new Set<() => void>()

// Called after a committed changePassword, regenerateRecoveryKey or
// resetPasswordWithRecoveryKey (the sync actions push the new header). Never
// for create, unlock or a header adopted from the cloud.
export function subscribeHeaderChanges(listener: () => void): () => void {
  headerListeners.add(listener)
  return () => {
    headerListeners.delete(listener)
  }
}

function emitHeaderChange(): void {
  for (const listener of Array.from(headerListeners)) {
    try {
      listener()
    } catch (err) {
      console.error(
        'Header change listener failed:',
        err instanceof Error ? err.name : typeof err,
      )
    }
  }
}

// Whether `header`'s verifier opens to the sentinel with `dek`.
async function verifierMatches(
  dek: CryptoKey,
  header: Pick<VaultHeaderV2, 'verifier'>,
): Promise<boolean> {
  try {
    const plain = await open(dek, header.verifier)
    return plain !== null && new TextDecoder().decode(plain) === VERIFIER_SENTINEL
  } catch {
    return false
  }
}

// JSON with keys sorted recursively, for comparing headers.
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

// A fresh device (state 'none') adopts a header downloaded from the cloud.
// The secret is checked with this device's brute-force counter and the same
// delay as an unlock. A recovery key re-wraps the DEK with the new password
// (headerChanged: true; the caller pushes it). Nothing is written before the
// secret is verified; then `meta:vault` and `meta:settings` (without
// recoveryKeyConfirmed: the key belongs to the cloud vault) are written in one
// setMany and localDb is unlocked.
export async function adoptCloudVault(
  header: VaultHeaderV2,
  secret: CloudVaultSecret,
): Promise<{ header: VaultHeaderV2; headerChanged: boolean }> {
  const store = requireStore()
  const notFresh = () =>
    new VaultError('invalid-state', 'A vault already exists on this device')
  if ((await getVaultState()) !== 'none') throw notFresh()
  if (!isHeader(header)) throw damaged()

  const dekBytes = await unwrapDek(
    store,
    header,
    'password' in secret
      ? { password: secret.password }
      : { recoveryKey: secret.recoveryKey },
  )
  try {
    const dek = await openDek(header, dekBytes)
    let adopted = header
    let headerChanged = false
    if (!('password' in secret)) {
      const pw = await wrapWithPassword(secret.newPassword, dekBytes)
      adopted = { ...header, kdf: pw.kdf, wrappedByPassword: pw.wrappedByPassword }
      headerChanged = true
    }
    // Same nesting order (vault, then settings) as regenerateRecoveryKey.
    await withWriteLock(META_VAULT_KEY, async () => {
      if ((await getVaultState()) !== 'none') throw notFresh()
      await withWriteLock(META_SETTINGS_KEY, async () => {
        const settings: StoredSettings = { ...(await readSettingsRaw(store)) }
        delete settings.recoveryKeyConfirmed
        await setMany(
          [
            [META_VAULT_KEY, adopted],
            [META_SETTINGS_KEY, settings],
          ],
          store,
        )
      })
    })
    await recordSuccess(store)
    unlockLocalDb(dek)
    return { header: adopted, headerChanged }
  } finally {
    dekBytes.fill(0)
  }
}

// "Join cloud data and keep this device's entries": this unlocked device
// moves to the cloud vault. The cloud password is checked with this device's
// counter (same delay as an unlock); then localDb.rekeyLiveData re-encrypts
// the live records under the cloud DEK and writes them, the cloud header,
// meta:settings (without recoveryKeyConfirmed) and the sync fields in ONE
// setMany. A wrong password or any failure before that commit leaves the old
// vault exactly as it was. Afterwards every other tab is told to lock (they
// still hold the old DEK); this tab stays unlocked with the cloud DEK.
export async function joinCloudVault(
  header: VaultHeaderV2,
  password: string,
  syncPatch: Record<string, unknown>,
): Promise<JoinCloudVaultResult> {
  const store = requireStore()
  if (!getLocalDbKey() || (await getVaultState()) !== 'v2') {
    throw new VaultError('invalid-state', 'Unlock this device first')
  }
  if (!isHeader(header)) throw damaged()

  const dekBytes = await unwrapDek(store, header, { password })
  let cloudDek: CryptoKey
  try {
    cloudDek = await openDek(header, dekBytes)
  } finally {
    dekBytes.fill(0)
  }
  await recordSuccess(store)

  const settings: StoredSettings = { ...(await readSettingsRaw(store)) }
  delete settings.recoveryKeyConfirmed
  const result = await rekeyLiveData(cloudDek, {
    plain: [
      [META_VAULT_KEY, header],
      [META_SETTINGS_KEY, settings],
    ],
    syncPatch,
  })
  postLock()
  return result
}

// A header seen in the cloud is adopted only when it belongs to this vault and
// wraps the DEK in use (its verifier opens with it). 'unchanged' when it is
// the local header; 'mismatch' changes nothing. meta:settings (the
// brute-force counters) is never touched. Needs the vault unlocked.
export async function adoptHeaderIfSameDek(
  header: VaultHeaderV2,
): Promise<HeaderAdoption> {
  const dek = getLocalDbKey()
  if (!dek) throw new VaultError('invalid-state', 'Vault is locked')
  const store = requireStore()
  return withWriteLock(META_VAULT_KEY, async () => {
    const local = await readHeader(store)
    if (!isHeader(header) || header.vaultId !== local.vaultId) return 'mismatch'
    if (!(await verifierMatches(dek, header))) return 'mismatch'
    if (canonicalJson(header) === canonicalJson(local)) return 'unchanged'
    await writeHeader(store, header)
    return 'adopted'
  })
}

// Whether a header wraps the DEK in use (the verifier check alone, no write).
export async function headerMatchesDek(header: VaultHeaderV2): Promise<boolean> {
  const dek = getLocalDbKey()
  if (!dek) throw new VaultError('invalid-state', 'Vault is locked')
  if (!isHeader(header)) return false
  return verifierMatches(dek, header)
}

// Removes the v1 localStorage keys (§4.5 step 5). Does nothing until the v2
// header exists, so v1 data can never be orphaned by calling it too early.
export async function clearLegacyKeys(): Promise<void> {
  const store = getLocalStore()
  if (!store) return
  const header = await get<unknown>(META_VAULT_KEY, store)
  if (header === undefined) return
  const legacy = localStorageKeys().filter(
    (k) =>
      k.startsWith(V1_SALT_PREFIX) ||
      k.startsWith(V1_VERIFIER_PREFIX) ||
      k === OFFLINE_USER_KEY,
  )
  for (const k of legacy) localStorage.removeItem(k)
}

// ── v1 -> v2 migration (§4.5) ─────────────────────────────────────────────────

function withUpdatedAt(
  storageKey: string,
  value: unknown,
  migratedAt: string,
): unknown {
  if (!Array.isArray(value)) return value
  const hasCreatedAt = storageKey === 'income' || storageKey.startsWith('expenses_')
  return value.map((record: unknown) => {
    if (!record || typeof record !== 'object') return record
    const r = record as { updatedAt?: unknown; createdAt?: unknown }
    if (typeof r.updatedAt === 'string') return record
    const updatedAt =
      hasCreatedAt && typeof r.createdAt === 'string' ? r.createdAt : migratedAt
    return { ...r, updatedAt }
  })
}

async function findV1Key(password: string): Promise<CryptoKey | null> {
  for (const userId of v1UserIds()) {
    const salt = readDeviceSalt(userId)
    if (!salt) continue
    const key = await deriveKey(password, salt)
    if (await checkKeyVerifier(key, userId)) return key
  }
  return null
}

async function migrateV1(
  store: UseStore,
  password: string,
): Promise<UnlockResult> {
  await assertNotThrottled(store)
  const v1Key = await findV1Key(password)
  if (!v1Key) {
    await recordFailure(store)
    throw incorrectPassword()
  }

  const migratedAt = new Date().toISOString()
  const dataKeys = (await keys(store))
    .filter((k): k is string => typeof k === 'string' && isDataStorageKey(k))
    .sort()

  const dekBytes = randomBytes(DEK_BYTES)
  const recoveryBytes = randomBytes(RECOVERY_KEY_BYTES)
  try {
    const dek = await importDek(dekBytes)
    const header = await buildHeader(password, dekBytes, recoveryBytes, dek)

    await withWriteLock([...dataKeys, META_VAULT_KEY, META_SETTINGS_KEY], async () => {
      if ((await get<unknown>(META_VAULT_KEY, store)) !== undefined) {
        throw new VaultError(
          'invalid-state',
          'A vault already exists on this device',
        )
      }
      const entries: Array<[string, unknown]> = []
      for (const storageKey of dataKeys) {
        const raw = await get<unknown>(storageKey, store)
        if (!(raw instanceof Uint8Array)) continue
        let value: unknown
        try {
          value = await decryptValue(v1Key, raw)
        } catch {
          // Left untouched; it surfaces later through the Data problem screen.
          continue
        }
        const migrated = withUpdatedAt(storageKey, value, migratedAt)
        entries.push([storageKey, await encryptValue(dek, migrated)])
      }
      entries.push([META_VAULT_KEY, header])
      entries.push(await unconfirmedKeySettings(store))
      // One transaction: either everything (data, header and the unconfirmed
      // recovery-key flag) commits or nothing.
      await setMany(entries, store)
    })

    await recordSuccess(store)
    unlockLocalDb(dek)
    return { recoveryKey: encodeRecoveryKey(recoveryBytes) }
  } finally {
    dekBytes.fill(0)
    recoveryBytes.fill(0)
  }
}
