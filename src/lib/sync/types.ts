// Types of the sync engine (docs/free-tier-spec.md §19). Types only: nothing
// here runs, and the api, vault and localDb modules are imported as types, so
// importing this file never loads them.

import type { CloudApi } from '@/lib/cloud/api'
import type { InviteInfo, MySpace, SpacesApi } from '@/lib/cloud/spacesApi'
import type {
  CloudDevice,
  CloudVault,
  EncryptedSpaceRow,
  EncryptedSyncRecord,
  SyncKeys,
  SyncStatus,
} from '@/lib/cloud/types'
import type {
  AdoptSpaceKeyInput,
  ApplyIncomingOptions,
  ApplyIncomingResult,
  ChangedRecords,
  SpaceEntryPatch,
} from '@/lib/localDb'
import type { PendingInvite, PendingJoin } from '@/lib/spaces/pendingInvite'
import type { IdentityKeyPair } from '@/lib/spaces/spaceCrypto'
import type {
  LocalSpace,
  MemberProfile,
  SpaceInfoRecord,
  SpaceKeyEntry,
  SpaceRole,
} from '@/lib/spaces/types'
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
  | 'family'

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
  /** The Family stream's part of the cycle (only with a Family stream). */
  family?: FamilyCycleResult
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
  /** The Family stream, run after the personal part of every cycle. */
  family?: FamilyStream
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

// ── Family stream (spec §22) ──────────────────────────────────────────────────

export type FamilySyncStatus =
  | 'none'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'paused'
  | 'pending-approval'
  | 'removed'
  | 'space-gone'
  | 'rotation-pending'
  | 'error'

export interface FamilyProgress {
  phase: 'pull' | 'push' | 'reencrypt'
  done: number
  total: number | null
}

export interface FamilySyncState {
  status: FamilySyncStatus
  spaceId: string | null
  role: SpaceRole | null
  name: string | null
  readOnly: boolean
  space: MySpace | null
  lastSyncAt: string | null
  progress: FamilyProgress | null
  errorCode: string | null
  lastError: SyncLastError | null
  pendingOwnerEmail: string | null
}

// The plaintext `space:<id>:meta:sync` record.
export interface FamilySyncMeta {
  localRev: number
  /** Missing = 0 (decision D6); -1 = the full snapshot is still to be pushed. */
  pushedRev?: number
  pullCursor?: number
  /** The key version this device last pushed with. */
  keyVersion?: number
  state?: FamilySyncStatus
  lastSyncAt?: string | null
  lastError?: SyncLastError | null
  /** A rotation must exceed this server key_version. */
  rotationPendingFrom?: number
  /** This device rotated: the full snapshot is still to be re-encrypted. */
  reencryptPending?: boolean
  /** Join requests already announced on this device. */
  notifiedRequests?: Array<string>
}

export type FamilySyncFields = Omit<FamilySyncMeta, 'localRev'>

export interface FamilyCycleResult {
  ran: boolean
  status: FamilySyncStatus
  pulled: number
  applied: number
  pushed: number
  stale: number
  skipped: number
  missingKey: number
  rotated: boolean
  reencrypted: number
  retry: boolean
}

export type FamilyStreamEvent =
  | { type: 'state'; state: FamilySyncState }
  | { type: 'joined'; spaceId: string; name: string }
  | { type: 'join-request'; spaceId: string; userId: string; email: string | null }
  | { type: 'data-problem'; error: unknown }

export interface FamilyLocalPort {
  isUnlocked: () => boolean
  listSpaceKeyEntries: () => Promise<Array<SpaceKeyEntry>>
  getSpaceKeyEntry: (spaceId: string) => Promise<SpaceKeyEntry | null>
  createLocalSpace: (input: { name: string }) => Promise<LocalSpace>
  forgetLocalSpace: (spaceId: string) => Promise<void>
  adoptSpaceKey: (input: AdoptSpaceKeyInput) => Promise<SpaceKeyEntry>
  updateSpaceEntry: (spaceId: string, patch: SpaceEntryPatch) => Promise<SpaceKeyEntry | null>
  ensureSpaceIndexKey: (spaceId: string) => Promise<SpaceKeyEntry>
  ensureIdentityKeyPair: () => Promise<IdentityKeyPair>
  listChangedRecords: (spaceId: string, sinceRev: number) => Promise<ChangedRecords>
  applyIncomingRecords: (
    spaceId: string,
    records: Array<SyncRecord>,
    options?: ApplyIncomingOptions,
  ) => Promise<ApplyIncomingResult>
  dedupeOccurrences: (spaceId: string, recurringIds: Array<string>) => Promise<number>
  compactTombstones: (
    spaceId: string,
    olderThan: string,
    options?: { maxRev?: number },
  ) => Promise<number>
  getSpaceInfo: (spaceId: string) => Promise<SpaceInfoRecord | null>
  updateSpaceInfo: (spaceId: string, input: { name: string }) => Promise<SpaceInfoRecord>
  getMemberProfiles: (spaceId: string) => Promise<Array<MemberProfile>>
  upsertMemberProfile: (
    spaceId: string,
    input: { id: string; displayName: string; color: string },
  ) => Promise<MemberProfile>
  countEntries: (spaceId: string) => Promise<number>
  onSpaceLocalChange: (listener: (spaceId: string) => void) => () => void
}

export interface FamilyMetaPort {
  read: (spaceId: string) => Promise<FamilySyncMeta>
  update: (spaceId: string, patch: Partial<FamilySyncFields>) => Promise<FamilySyncMeta>
}

export interface FamilyPendingPort {
  readJoin: () => PendingJoin | null
  saveJoin: (join: PendingJoin) => void
  clearJoin: () => void
  clearInvite: () => void
}

export interface FamilyPorts {
  local: FamilyLocalPort
  meta: FamilyMetaPort
  pending: FamilyPendingPort
}

export interface FamilyCryptoPort {
  deriveKeys: (indexKey: Uint8Array, sk: Uint8Array) => Promise<SyncKeys>
  encrypt: (keys: SyncKeys, record: SyncRecord, keyVersion: number) => Promise<EncryptedSyncRecord>
  decrypt: (keys: SyncKeys, row: EncryptedSpaceRow) => Promise<SyncRecord>
}

export interface FamilyRunContext {
  userId: string
  deviceId: string
  /** The fresh get_sync_status of this cycle. */
  status: SyncStatus
  /** Throws to end the cycle (vault locked, engine stopped). */
  checkpoint: () => void
}

export interface FamilyStreamDeps {
  spaces: SpacesApi
  ports: FamilyPorts
  getUserId: () => string | null
  /** Default: deriveSpaceSyncKeys / encryptSpaceRecord / decryptSpaceRecord. */
  crypto?: FamilyCryptoPort
  clock?: SyncClock
  /** The name a joiner's entry starts with. Default 'Family'. */
  defaultName?: () => string
}

export interface FamilyStream {
  getState: () => FamilySyncState
  /** useSyncExternalStore-compatible. */
  subscribe: (listener: () => void) => () => void
  onEvent: (listener: (event: FamilyStreamEvent) => void) => () => void
  /** Fires after a committed Family user write. */
  onLocalChange: (listener: () => void) => () => void
  /** One Family cycle; never rejects. */
  run: (ctx: FamilyRunContext) => Promise<FamilyCycleResult>
  markOffline: () => void
  /** The state from the entries and meta, no network. */
  refreshFromLocal: () => Promise<FamilySyncState>
  /** Stores a fresh get_my_space snapshot. */
  setSpace: (space: MySpace | null) => void
}

export type CreateFamilyResult =
  | { kind: 'created'; spaceId: string }
  | { kind: 'already-in-space'; space: MySpace | null }

export interface CreatedFamilyInvite {
  url: string
  inviteId: string
  expiresAt: string
}

export interface FamilyOverview {
  info: SpaceInfoRecord | null
  profiles: Array<MemberProfile>
  entryCount: number
}

export interface JoinRequestResult {
  spaceId: string
  safetyCode: string
}

export type FamilyActionErrorCode =
  | 'not_signed_in'
  | 'sync_off'
  | 'not_in_plan'
  | 'no_family'
  | 'not_owner'
  | 'name_mismatch'
  | 'invalid_name'

export interface FamilyActions {
  createFamily: (input: { name: string }) => Promise<CreateFamilyResult>
  createInvite: () => Promise<CreatedFamilyInvite>
  revokeInvite: (inviteId: string) => Promise<void>
  previewInvite: (invite: PendingInvite) => Promise<InviteInfo>
  requestJoin: (invite: PendingInvite, ownerEmail: string | null) => Promise<JoinRequestResult>
  approveMember: (userId: string) => Promise<void>
  rejectMember: (userId: string) => Promise<void>
  removeMember: (userId: string) => Promise<void>
  leaveFamily: () => Promise<void>
  transferOwnership: (userId: string) => Promise<void>
  deleteFamily: (confirmName: string) => Promise<void>
  forgetFamily: (spaceId: string) => Promise<void>
  renameFamily: (name: string) => Promise<void>
  setMyDisplayName: (displayName: string) => Promise<void>
  refresh: () => Promise<MySpace | null>
  mySafetyCode: () => Promise<string>
  getOverview: (spaceId: string) => Promise<FamilyOverview>
}

export interface FamilyActionsDeps {
  api: { getSyncStatus: () => Promise<SyncStatus> }
  spaces: SpacesApi
  engine: Pick<SyncEngine, 'runCycle'>
  family: FamilyStream
  ports: FamilyPorts
  personalMeta: SyncMetaPort
  getUserId: () => string | null
  /** Default: window.location.origin. */
  origin?: () => string
}
