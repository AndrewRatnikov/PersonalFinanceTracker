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
// lives under `meta:settings`. This module keeps no state of its own and does
// nothing at import time.

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
import { isDataStorageKey } from './dataErrors'
import {
  getLocalStore,
  hasLocalData,
  unlockLocalDb,
  wipeLocalDbKey,
} from './localDb'
import { withWriteLock } from './writeLock'
import type { UseStore } from 'idb-keyval'

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

function importDek(dekBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
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
  header: VaultHeaderV2,
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
  return withWriteLock(META_VAULT_KEY, async () => {
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
      await writeHeader(store, header)
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
      await writeHeader(store, { ...header, recovery })
      return encodeRecoveryKey(recoveryBytes)
    } finally {
      dekBytes.fill(0)
      recoveryBytes.fill(0)
    }
  })
  await recordSuccess(store)
  return { recoveryKey }
}

export function lockVault(): void {
  wipeLocalDbKey()
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

    await withWriteLock([...dataKeys, META_VAULT_KEY], async () => {
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
      // One transaction: either everything (data + header) commits or nothing.
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
