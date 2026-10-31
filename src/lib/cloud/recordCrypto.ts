// Pure record crypto for encrypted sync (format in ./types.ts): key
// derivation, the opaque record key, and encrypt / decrypt of one SyncRecord.
// No storage, no network, no React, and no import of vault.ts (vault.ts
// imports this module).

import {
  SPACE_INDEX_INFO,
  SYNC_DATA_INFO,
  SYNC_ENC_V,
  SYNC_INDEX_INFO,
} from './types'
import type { EncryptedSpaceRow, EncryptedSyncRecord, SyncKeys } from './types'
import type { SyncRecord, SyncRecordType } from '@/lib/syncRecords'
import { base64ToBytes, bytesToBase64 } from '@/lib/crypto'

export type SyncRecordErrorCode =
  'decrypt-failed' | 'unsupported-version' | 'invalid-record'

export class SyncRecordError extends Error {
  readonly code: SyncRecordErrorCode

  constructor(code: SyncRecordErrorCode, message: string = code) {
    super(message)
    this.name = 'SyncRecordError'
    this.code = code
  }
}

const SYNC_RECORD_TYPES: ReadonlyArray<SyncRecordType> = [
  'expense',
  'income',
  'category',
  'incomeCategory',
  'budget',
  'recurring',
  'settings',
  'identity',
  'spaceKey',
  'spaceInfo',
  'memberProfile',
]

const IV_BYTES = 12
const utf8 = new TextEncoder()
const EMPTY_SALT = new Uint8Array(0)

function isCryptoKey(value: CryptoKey | Uint8Array): value is CryptoKey {
  return !ArrayBuffer.isView(value)
}

// RFC 4648 §5, without padding.
function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function hkdfParams(info: string): HkdfParams {
  return {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: EMPTY_SALT,
    info: utf8.encode(info),
  }
}

// K_index and K_data from the DEK. Raw bytes are imported as non-extractable
// HKDF material; a CryptoKey must already be HKDF material (the AES-GCM DEK
// itself can't be used for HKDF and is refused).
export async function deriveSyncKeys(
  dek: CryptoKey | Uint8Array,
): Promise<SyncKeys> {
  let base: CryptoKey
  if (isCryptoKey(dek)) {
    if (dek.algorithm.name !== 'HKDF') {
      throw new TypeError(
        `deriveSyncKeys needs HKDF key material, got a ${dek.algorithm.name} key`,
      )
    }
    base = dek
  } else {
    // Any 256-bit root key: the DEK bytes or a Family space key (SK).
    if (dek.byteLength !== 32) {
      throw new TypeError(
        `deriveSyncKeys needs a 32-byte root key, got ${dek.byteLength} bytes`,
      )
    }
    const material = new Uint8Array(dek)
    try {
      base = await crypto.subtle.importKey('raw', material, 'HKDF', false, [
        'deriveKey',
      ])
    } finally {
      material.fill(0)
    }
  }

  const index = await crypto.subtle.deriveKey(
    hkdfParams(SYNC_INDEX_INFO),
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const data = await crypto.subtle.deriveKey(
    hkdfParams(SYNC_DATA_INFO),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return { index, data }
}

// base64url(HMAC-SHA256(K_index, `${type}:${id}`)): 43 characters.
export async function recordKeyFor(
  keys: SyncKeys,
  type: SyncRecordType,
  id: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    keys.index,
    utf8.encode(`${type}:${id}`),
  )
  return bytesToBase64Url(new Uint8Array(mac))
}

export async function encryptSyncRecord(
  keys: SyncKeys,
  record: SyncRecord,
): Promise<EncryptedSyncRecord> {
  const updatedAtMs = Date.parse(record.updatedAt)
  if (!Number.isFinite(updatedAtMs)) {
    throw new SyncRecordError(
      'invalid-record',
      'The record has no valid updatedAt',
    )
  }
  const recordKey = await recordKeyFor(keys, record.type, record.id)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(recordKey) },
    keys.data,
    utf8.encode(JSON.stringify(record)),
  )
  return {
    record_key: recordKey,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    enc_v: SYNC_ENC_V,
    updated_at_ms: updatedAtMs,
  }
}

function isSyncRecord(value: unknown): value is SyncRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.type === 'string' &&
    (SYNC_RECORD_TYPES as ReadonlyArray<string>).includes(r.type) &&
    typeof r.id === 'string' &&
    typeof r.updatedAt === 'string' &&
    (r.deletedAt === undefined || typeof r.deletedAt === 'string') &&
    typeof r.data === 'object' &&
    r.data !== null &&
    !Array.isArray(r.data)
  )
}

// Opens a stored row. Checks, in order: the format version, the AES-GCM tag
// (with record_key as additional data), the record shape, and that the record
// inside really belongs to this record_key.
export async function decryptSyncRecord(
  keys: SyncKeys,
  row: Pick<EncryptedSyncRecord, 'record_key' | 'ciphertext' | 'iv' | 'enc_v'>,
): Promise<SyncRecord> {
  if (row.enc_v !== SYNC_ENC_V) {
    throw new SyncRecordError(
      'unsupported-version',
      `Unsupported enc_v ${row.enc_v}`,
    )
  }

  let plaintext: string
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(row.iv),
        additionalData: utf8.encode(row.record_key),
      },
      keys.data,
      base64ToBytes(row.ciphertext),
    )
    plaintext = new TextDecoder('utf-8', { fatal: true }).decode(opened)
  } catch {
    throw new SyncRecordError(
      'decrypt-failed',
      'The record could not be decrypted',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new SyncRecordError('invalid-record', 'The record is not valid JSON')
  }
  if (!isSyncRecord(parsed)) {
    throw new SyncRecordError(
      'invalid-record',
      'The record has an invalid shape',
    )
  }

  if ((await recordKeyFor(keys, parsed.type, parsed.id)) !== row.record_key) {
    throw new SyncRecordError(
      'decrypt-failed',
      'The record does not match its key',
    )
  }
  return parsed
}

// ── Family records (spec §22, decision D1) ──────────────────────────────────
// The index key comes from the space's fixed indexKey, the data key from the
// sk of one key version; the AAD binds the key version to the record key.

async function hkdfMaterial(raw: Uint8Array, what: string): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new TypeError(`${what} must be 32 bytes, got ${raw.byteLength}`)
  }
  const material = new Uint8Array(raw)
  try {
    return await crypto.subtle.importKey('raw', material, 'HKDF', false, [
      'deriveKey',
    ])
  } finally {
    material.fill(0)
  }
}

// HKDF-SHA256(indexKey, empty salt, info SPACE_INDEX_INFO) → HMAC-SHA-256.
export async function deriveSpaceIndexKey(
  indexKey: Uint8Array,
): Promise<CryptoKey> {
  const base = await hkdfMaterial(indexKey, 'A space index key')
  return crypto.subtle.deriveKey(
    hkdfParams(SPACE_INDEX_INFO),
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

// HKDF-SHA256(sk, empty salt, info SYNC_DATA_INFO) → AES-GCM-256.
export async function deriveSpaceDataKey(sk: Uint8Array): Promise<CryptoKey> {
  const base = await hkdfMaterial(sk, 'A space key')
  return crypto.subtle.deriveKey(
    hkdfParams(SYNC_DATA_INFO),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function deriveSpaceSyncKeys(
  indexKey: Uint8Array,
  sk: Uint8Array,
): Promise<SyncKeys> {
  const [index, data] = await Promise.all([
    deriveSpaceIndexKey(indexKey),
    deriveSpaceDataKey(sk),
  ])
  return { index, data }
}

export function spaceRecordAad(recordKey: string, keyVersion: number): string {
  return `${recordKey}:${keyVersion}`
}

export async function encryptSpaceRecord(
  keys: SyncKeys,
  record: SyncRecord,
  keyVersion: number,
): Promise<EncryptedSyncRecord> {
  const updatedAtMs = Date.parse(record.updatedAt)
  if (!Number.isFinite(updatedAtMs)) {
    throw new SyncRecordError(
      'invalid-record',
      'The record has no valid updatedAt',
    )
  }
  const recordKey = await recordKeyFor(keys, record.type, record.id)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: utf8.encode(spaceRecordAad(recordKey, keyVersion)),
    },
    keys.data,
    utf8.encode(JSON.stringify(record)),
  )
  return {
    record_key: recordKey,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    enc_v: SYNC_ENC_V,
    updated_at_ms: updatedAtMs,
  }
}

// Opens a Family row: enc_v, the tag (AAD with row.key_version), the shape,
// and that the record belongs to its record_key.
export async function decryptSpaceRecord(
  keys: SyncKeys,
  row: EncryptedSpaceRow,
): Promise<SyncRecord> {
  if (row.enc_v !== SYNC_ENC_V) {
    throw new SyncRecordError(
      'unsupported-version',
      `Unsupported enc_v ${row.enc_v}`,
    )
  }

  let plaintext: string
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(row.iv),
        additionalData: utf8.encode(
          spaceRecordAad(row.record_key, row.key_version),
        ),
      },
      keys.data,
      base64ToBytes(row.ciphertext),
    )
    plaintext = new TextDecoder('utf-8', { fatal: true }).decode(opened)
  } catch {
    throw new SyncRecordError(
      'decrypt-failed',
      'The record could not be decrypted',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new SyncRecordError('invalid-record', 'The record is not valid JSON')
  }
  if (!isSyncRecord(parsed)) {
    throw new SyncRecordError(
      'invalid-record',
      'The record has an invalid shape',
    )
  }

  if ((await recordKeyFor(keys, parsed.type, parsed.id)) !== row.record_key) {
    throw new SyncRecordError(
      'decrypt-failed',
      'The record does not match its key',
    )
  }
  return parsed
}
