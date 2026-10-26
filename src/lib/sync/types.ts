// Types of the sync engine (docs/free-tier-spec.md §19). Types only: nothing
// here runs, and the api, vault and localDb modules are imported as types, so
// importing this file never loads them.

import type { CloudApi } from '@/lib/cloud/api'
import type {
  CloudDevice,
  CloudVault,
  EncryptedSyncRecord,
  SyncKeys,
} from '@/lib/cloud/types'
import type {
  ApplyIncomingOptions,
  ApplyIncomingResult,
  ChangedRecords,
} from '@/lib/localDb'
import type { SyncRecord } from '@/lib/syncRecords'
import type {
  CloudVaultSecret,
  HeaderAdoption,
  JoinCloudVaultResult,
  VaultHeaderV2,
  VaultState,
} from '@/lib/vault'

// ── meta:sync (plaintext) ─────────────────────────────────────────────────────

export interface SyncLastError {
  code: string
  count?: number
  at: string
}

export interface SyncFields {
  enabled: boolean
  /** The Supabase user this device is linked to. */
  userId: string
  /** The cloud vault_id (= the local header's vaultId). */
  vaultId: string
  deviceId: string
  /** -1 = nothing pushed yet (the next push is the full snapshot). */
  pushedRev: number
  /** seq of the last applied pulled row (0 = from the start). */
  pullCursor: number
  /** The cloud header_rev this device has pushed or adopted. */
  headerRev: number
  lastSyncAt: string | null
  lastError: SyncLastError | null
  /** A local header change still has to be pushed. */
  headerPending?: boolean
}

export interface SyncMeta extends Partial<SyncFields> {
  localRev: number
}

// ── Engine state ──────────────────────────────────────────────────────────────

export type SyncStatusCode =
  | 'off'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'paused'
  | 'device-removed'
  | 'cloud-deleted'
  | 'vault-mismatch'
  | 'other-account'
  | 'error'

export interface SyncProgress {
  phase: 'pull' | 'push'
  done: number
  total: number | null
}

export interface SyncState {
  status: SyncStatusCode
  /** From meta. */
  lastSyncAt: string | null
  /** Only while 'syncing'. */
  progress: SyncProgress | null
  /** Only for 'error': a CloudError code, 'not_signed_in', 'decrypt' or 'unexpected'. */
  errorCode: string | null
  /** From meta, e.g. { code: 'undecryptable', count: 3, at }. */
  lastError: SyncLastError | null
  /** From meta (the "This device" marker). */
  deviceId: string | null
}

export type SyncTrigger =
  | 'unlock'
  | 'local-change'
  | 'online'
  | 'visible'
  | 'interval'
  | 'manual'
  | 'retry'
  | 'turn-on'
  | 'restore'
  | 'header'

export interface SyncCycleResult {
  /** false: skipped (lock held by another tab, or a cycle already running here). */
  ran: boolean
  status: SyncStatusCode
  /** Rows received. */
  pulled: number
  /** ApplyIncomingResult.applied summed (pull + stale). */
  applied: number
  /** Records sent. */
  pushed: number
  /** 'stale' push results. */
  stale: number
  /** Undecryptable or invalid rows skipped. */
  skipped: number
  deduped: number
  compacted: number
}

export type SyncEngineEvent =
  | { type: 'header-adopted' }
  | { type: 'state'; state: SyncState }
  /** A DecryptError from local data. */
  | { type: 'data-problem'; error: unknown }

// ── Ports ─────────────────────────────────────────────────────────────────────

export interface SyncLocalPort {
  isUnlocked: () => boolean
  listChangedRecords: (sinceRev: number) => Promise<ChangedRecords>
  applyIncomingRecords: (
    records: Array<SyncRecord>,
    options?: ApplyIncomingOptions,
  ) => Promise<ApplyIncomingResult>
  compactTombstones: (
    olderThan: string,
    options?: { maxRev?: number },
  ) => Promise<number>
  dedupeOccurrences: (recurringIds: Array<string>) => Promise<number>
  onLocalChange: (listener: () => void) => () => void
}

export interface SyncVaultPort {
  getSyncKeys: () => Promise<SyncKeys>
  getVaultHeader: () => Promise<VaultHeaderV2>
  getVaultState: () => Promise<VaultState>
  adoptHeaderIfSameDek: (header: VaultHeaderV2) => Promise<HeaderAdoption>
  headerMatchesDek: (header: VaultHeaderV2) => Promise<boolean>
  adoptCloudVault: (
    header: VaultHeaderV2,
    secret: CloudVaultSecret,
  ) => Promise<{ header: VaultHeaderV2; headerChanged: boolean }>
  joinCloudVault: (
    header: VaultHeaderV2,
    password: string,
    syncPatch: Record<string, unknown>,
  ) => Promise<JoinCloudVaultResult>
  verifyPassword: (password: string) => Promise<void>
  onHeaderChange: (listener: () => void) => () => void
}

export interface SyncMetaPort {
  read: () => Promise<SyncMeta>
  update: (patch: Partial<SyncFields>) => Promise<SyncMeta>
  clear: () => Promise<SyncMeta>
}

export interface SyncPorts {
  local: SyncLocalPort
  vault: SyncVaultPort
  meta: SyncMetaPort
}

export interface SyncCryptoPort {
  encrypt: (keys: SyncKeys, record: SyncRecord) => Promise<EncryptedSyncRecord>
  decrypt: (
    keys: SyncKeys,
    row: Pick<EncryptedSyncRecord, 'record_key' | 'ciphertext' | 'iv' | 'enc_v'>,
  ) => Promise<SyncRecord>
}

export interface SyncClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  yieldToUi: () => Promise<void>
}

export interface SyncLockManager {
  request: <T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ) => Promise<T>
}

export interface SyncEnv {
  /** Adds a listener on window ('online') or document ('visibilitychange'); returns the remover. */
  listen: (
    target: 'window' | 'document',
    type: string,
    listener: () => void,
  ) => () => void
  isVisible: () => boolean
}

export interface SyncEngineDeps {
  api: CloudApi
  ports: SyncPorts
  getUserId: () => string | null
  /** Default: encryptSyncRecord / decryptSyncRecord. */
  crypto?: SyncCryptoPort
  /** Default: Date.now, global timers, yieldToUi = setTimeout 0. */
  clock?: SyncClock
  /** Default: navigator.onLine (true when navigator is missing). */
  isOnline?: () => boolean
  /** Default: navigator.locks when present, else an in-memory lock. */
  locks?: SyncLockManager
  /** Default: the real window / document; a no-op on the server. */
  env?: SyncEnv
}

export interface SyncEngine {
  getState: () => SyncState
  /** useSyncExternalStore-compatible. */
  subscribe: (listener: () => void) => () => void
  onEvent: (listener: (event: SyncEngineEvent) => void) => () => void
  /** 'off' when sync is off in meta, else keeps a problem status or the 'synced' / 'syncing' baseline. */
  refreshFromMeta: () => Promise<SyncState>
  runCycle: (options?: { reason?: SyncTrigger }) => Promise<SyncCycleResult>
  /** 'local-change' is debounced (SYNC_DEBOUNCE_MS), every other trigger runs now. */
  requestCycle: (reason: SyncTrigger) => void
  /** Idempotent: listeners, timers and an immediate 'unlock' cycle. */
  start: () => void
  /** Idempotent: removes listeners and timers; a running cycle stops at its next checkpoint. */
  stop: () => void
}

// ── Actions ───────────────────────────────────────────────────────────────────

export interface DeviceIdPort {
  get: () => string
  reset: () => string
  defaultLabel: () => string
}

export interface SyncActionsDeps {
  api: CloudApi
  engine: SyncEngine
  ports: SyncPorts
  deviceIds: DeviceIdPort
  getUserId: () => string | null
}

export type TurnOnResult =
  /** No cloud vault: created and the full snapshot pushed. */
  | { kind: 'created'; pushed: number }
  /** A cloud vault with the same vault_id: synced. */
  | { kind: 'linked' }
  /** A cloud vault with a different vault_id: the link dialog decides. */
  | { kind: 'needs-link'; cloud: CloudVault }

export interface SyncActions {
  turnOn: () => Promise<TurnOnResult>
  /** Same as turnOn (from the cloud-deleted state). */
  uploadAgain: () => Promise<TurnOnResult>
  joinAndKeep: (cloud: CloudVault, password: string) => Promise<SyncCycleResult>
  replaceCloud: (confirmation: string) => Promise<SyncCycleResult>
  turnOff: (options: { removeDevice: boolean }) => Promise<void>
  /** Fresh-device restore: the gate, then get_vault. */
  fetchCloudVault: () => Promise<CloudVault | null>
  restoreFromCloud: (
    cloud: CloudVault,
    secret: CloudVaultSecret,
  ) => Promise<SyncCycleResult>
  deleteCloudData: (password: string) => Promise<void>
  syncNow: () => Promise<SyncCycleResult>
  listDevices: () => Promise<Array<CloudDevice>>
  renameDevice: (deviceId: string, label: string) => Promise<CloudDevice>
  removeDevice: (deviceId: string) => Promise<CloudDevice>
  handleLocalHeaderChange: () => Promise<void>
}
