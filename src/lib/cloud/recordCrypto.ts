// Pure record crypto for encrypted sync (format in ./types.ts): key
// derivation, the opaque record key, and encrypt / decrypt of one SyncRecord.
// No storage, no network, no React, and no import of vault.ts (vault.ts
// imports this module).

import { SYNC_DATA_INFO, SYNC_ENC_V, SYNC_INDEX_INFO } from './types'
import type { EncryptedSyncRecord, SyncKeys } from './types'
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
