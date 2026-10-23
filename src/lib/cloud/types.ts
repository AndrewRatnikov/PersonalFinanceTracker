// Wire types and constants for encrypted sync (docs/free-tier-spec.md §18,
// supabase/migrations/20261023000000_sync_server.sql). Run 2 builds the
// server; run 3 adds the sync engine on top of this contract.
//
// Encrypted record format (enc_v 1). The server never learns amounts,
// categories, descriptions, record types or record ids. Per record it stores:
//
//   record_key    base64url (RFC 4648 §5, no padding, 43 chars) of
//                 HMAC-SHA256(K_index, utf8(`${type}:${id}`)). The same record
//                 gets the same key on every device; the server can't tell
//                 expenses from categories.
//   ciphertext    standard base64 of AES-GCM-256(K_data, iv, utf8(JSON of the
//                 full SyncRecord { type, id, updatedAt, deletedAt?, data })),
//                 additionalData = utf8(record_key), so a ciphertext can't be
//                 moved to another key. The 16-byte tag is appended (WebCrypto).
//   iv            standard base64 of 12 random bytes (16 chars).
//   enc_v         1.
//   updated_at_ms Date.parse(record.updatedAt): the one value in the clear, so
//                 the server can refuse stale overwrites.
//   device_id     the writer, set by the server from p_device_id.
//
// Keys, derived from the vault DEK (raw 32 bytes) with HKDF-SHA256 and an
// empty (zero-length) salt: the DEK is already a uniformly random 256-bit key
// (RFC 5869 §3.1) and every device must derive the same keys without extra
// state. The info strings separate the two keys:
//
//   K_index = HKDF(DEK, info 'minima-sync-index-v1') → HMAC-SHA-256, 256-bit,
//             non-extractable, usages ['sign']
//   K_data  = HKDF(DEK, info 'minima-sync-data-v1')  → AES-GCM-256,
//             non-extractable, usages ['encrypt', 'decrypt']
//
// vault.ts getSyncKeys() derives them without ever exporting the DEK.
//
// Server rules the client relies on: pulls are ordered by a per-user `seq`;
// a push is written only with a strictly newer updated_at_ms, so an equal time
// comes back 'stale' with the stored row (the server copy wins exact ties).
// get_sync_status().granted_by says whether an entitlement, the beta switch
// (free_for_all) or nothing ('default') decided the plan.

import type { VaultHeaderV2 } from '@/lib/vault'

export const SYNC_ENC_V = 1
export const SYNC_INDEX_INFO = 'minima-sync-index-v1'
export const SYNC_DATA_INFO = 'minima-sync-data-v1'

export const RECORD_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export const MAX_RECORDS_PER_PUSH = 500
export const MAX_PUSH_CIPHERTEXT_CHARS = 1048576
export const MAX_CIPHERTEXT_CHARS = 65536
export const MAX_IV_CHARS = 32

export const DEFAULT_PULL_LIMIT = 500
export const MAX_PULL_LIMIT = 1000
export const MAX_DEVICE_LABEL_CHARS = 60

// The codes the server raises as `MINIMA:<code>`.
export const SERVER_ERROR_CODES = [
  'not_signed_in',
  'sync_not_included',
  'device_not_registered',
  'device_removed',
  'device_limit',
  'no_vault',
  'vault_exists',
  'vault_mismatch',
  'header_conflict',
  'quota_exceeded',
  'batch_too_large',
  'invalid_input',
] as const

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]
export type CloudErrorCode = ServerErrorCode | 'network' | 'unknown'

export type FeatureName = 'sync'

export interface SyncKeys {
  index: CryptoKey
  data: CryptoKey
}

export interface EncryptedSyncRecord {
  record_key: string
  ciphertext: string
  iv: string
  enc_v: number
  updated_at_ms: number
}

export interface CloudRecordRow extends EncryptedSyncRecord {
  device_id: string
  seq: number
}

// plans.features: the feature flags and the limits of a plan.
export interface PlanFeatures {
  sync: boolean
  max_devices: number
  max_records: number
  max_bytes: number
  [k: string]: unknown
}

export interface SyncStatus {
  plan_id: string
  has_sync: boolean
  free_for_all: boolean
  granted_by: 'entitlement' | 'free_for_all' | 'default'
  beta_joined_at: string | null
  entitlement_status: 'active' | 'past_due' | 'canceled' | null
  current_period_end: string | null
  limits: PlanFeatures
  vault: {
    vault_id: string
    header_rev: number
    record_count: number
    total_bytes: number
    last_seq: number
  } | null
  devices_count: number
}

export interface CloudDevice {
  device_id: string
  label: string
  created_at: string
  last_seen_at: string
  removed_at: string | null
}

export interface CloudVault {
  vault_id: string
  header: VaultHeaderV2
  header_rev: number
}

export interface CloudVaultRef {
  vault_id: string
  header_rev: number
}

export type PushRecordResult =
  | { record_key: string; status: 'accepted'; seq: number }
  | { record_key: string; status: 'stale'; current: CloudRecordRow }

export interface PushResult {
  results: Array<PushRecordResult>
  last_seq: number
}

export interface PullResult {
  records: Array<CloudRecordRow>
  has_more: boolean
  last_seq: number
  vault_id: string
}

export interface DeleteCloudDataResult {
  deleted_records: number
}
