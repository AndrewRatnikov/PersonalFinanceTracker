// The sync engine (docs/free-tier-spec.md §19). Pure orchestration: the cloud
// api, the local data, the vault, meta:sync, the crypto, the clock, the
// cross-tab lock and the window/document events are all injected, so the same
// code runs in the app (runtime.ts) and against fakes or the PGlite server in
// tests. Nothing happens at import time.
//
// One cycle (runCycle), inside navigator.locks 'minima-sync' (ifAvailable; a
// cycle that finds the lock held is skipped):
//   1. preconditions: sync on in meta, vault unlocked, signed in as meta.userId,
//      online; otherwise the matching state and no cloud call;
//   2. the gate: a fresh get_sync_status + hasFeature(status, 'sync') every
//      cycle (never a cached status); a missing or different cloud vault is
//      'cloud-deleted';
//   3. the header: push a pending local change with the expected rev (one
//      retry after a header_conflict, only when the cloud header wraps the same
//      DEK), else adopt a newer cloud header that wraps the same DEK;
//   4. pull every page from pullCursor (undecryptable rows are skipped and
//      counted; the cursor is saved per page; re-applying a page is harmless);
//   5. reduce legacy duplicate occurrences of the pulled recurring items once;
//   6. push listChangedRecords(pushedRev) in batches (≤ 500 records, ≤ 1 MB);
//      'stale' answers are applied with preferIncomingOnTie (the server copy
//      wins an exact tie); pushedRev = snapshot.maxRev only after every batch;
//   7. compact tombstones that are pushed and older than 90 days; lastSyncAt.
// Locking the vault or stop() ends a cycle at its next checkpoint (after the
// current request). Never logs records, keys, headers or ciphertext.

import { isSyncOn } from './syncMeta'
import type { CloudErrorCode, EncryptedSyncRecord, SyncKeys } from '@/lib/cloud/types'
import type { ApplyIncomingOptions } from '@/lib/localDb'
import type { SyncRecord } from '@/lib/syncRecords'
import type {
  SyncClock,
  SyncCryptoPort,
  SyncCycleResult,
  SyncEngine,
  SyncEngineDeps,
  SyncEngineEvent,
  SyncEnv,
  SyncFields,
  SyncLockManager,
  SyncMeta,
  SyncProgress,
  SyncState,
  SyncStatusCode,
  SyncTrigger,
} from './types'
import {
  DEFAULT_PULL_LIMIT,
  MAX_PUSH_CIPHERTEXT_CHARS,
  MAX_RECORDS_PER_PUSH,
} from '@/lib/cloud/types'
import { decryptSyncRecord, encryptSyncRecord } from '@/lib/cloud/recordCrypto'
import { hasFeature } from '@/lib/cloud/entitlements'
import { CloudError } from '@/lib/cloud/api'

export const SYNC_LOCK_NAME = 'minima-sync'
export const SYNC_DEBOUNCE_MS = 2000
export const SYNC_INTERVAL_MS = 60_000
export const SYNC_BACKOFF_BASE_MS = 5000
export const SYNC_BACKOFF_MAX_MS = 300_000
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const SYNC_PULL_LIMIT = DEFAULT_PULL_LIMIT

export const INITIAL_SYNC_STATE: SyncState = {
  status: 'off',
  lastSyncAt: null,
  progress: null,
  errorCode: null,
  lastError: null,
  deviceId: null,
}

// Encrypting is CPU work: yield to the UI every this many records.
const ENCRYPT_YIELD_EVERY = 200

// Statuses that describe a problem with the link to the cloud; refreshFromMeta
// keeps them.
const PROBLEM_STATUSES: ReadonlySet<SyncStatusCode> = new Set<SyncStatusCode>([
  'device-removed',
  'cloud-deleted',
  'vault-mismatch',
  'other-account',
  'paused',
])

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Order kept. A batch closes before it would exceed `maxRecords` records or
// `maxChars` characters of ciphertext; a single oversize record still gets its
// own batch (the server refuses it, which is reported as an error).
export function planPushBatches(
  records: Array<EncryptedSyncRecord>,
  maxRecords: number = MAX_RECORDS_PER_PUSH,
  maxChars: number = MAX_PUSH_CIPHERTEXT_CHARS,
): Array<Array<EncryptedSyncRecord>> {
  const batches: Array<Array<EncryptedSyncRecord>> = []
  let current: Array<EncryptedSyncRecord> = []
  let chars = 0
  for (const record of records) {
    const size = record.ciphertext.length
    if (
      current.length > 0 &&
      (current.length + 1 > maxRecords || chars + size > maxChars)
    ) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(record)
    chars += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

// 5 s for the first retry, doubling, at most 5 minutes; 0 for attempt ≤ 0.
export function nextBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0
  return Math.min(
    SYNC_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    SYNC_BACKOFF_MAX_MS,
  )
}

export function statusForCloudError(code: CloudErrorCode): {
  status: SyncStatusCode
  retry: boolean
} {
  switch (code) {
    case 'device_removed':
      return { status: 'device-removed', retry: false }
    case 'no_vault':
    case 'device_not_registered':
    case 'vault_mismatch':
      return { status: 'cloud-deleted', retry: false }
    case 'sync_not_included':
      return { status: 'paused', retry: false }
    case 'network':
    case 'unknown':
      return { status: 'error', retry: true }
    default:
      return { status: 'error', retry: false }
  }
}

// Recognised by name + code, so an error from another module registry counts.
function asCloudError(err: unknown): { code: CloudErrorCode } | null {
  if (err instanceof CloudError) return err
  if (
    err instanceof Error &&
    err.name === 'CloudError' &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return err as Error & { code: CloudErrorCode }
  }
  return null
}

function isDecryptError(err: unknown): boolean {
  return err instanceof Error && err.name === 'DecryptError'
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

// ── Defaults (built per engine, never at import) ──────────────────────────────

function defaultClock(): SyncClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    yieldToUi: () =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0)
      }),
  }
}

function defaultIsOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

function defaultLocks(): SyncLockManager {
  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as { locks?: LockManager }).locks
  if (nav && typeof nav.request === 'function') {
    return {
      request: (name, options, callback) =>
        nav.request(name, options, (lock) => callback(lock)),
    }
  }
  // Same tab only: a held flag per name.
  const held = new Set<string>()
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null)
      held.add(name)
      try {
        return await callback({ name })
      } finally {
        held.delete(name)
      }
    },
  }
}

function defaultEnv(): SyncEnv {
  return {
    listen(target, type, listener) {
      const node =
        target === 'window'
          ? typeof window === 'undefined'
            ? null
            : window
          : typeof document === 'undefined'
            ? null
            : document
      if (!node) return () => undefined
      node.addEventListener(type, listener)
      return () => {
        node.removeEventListener(type, listener)
      }
    },
    isVisible: () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden',
  }
}

const defaultCrypto: SyncCryptoPort = {
  encrypt: encryptSyncRecord,
  decrypt: decryptSyncRecord,
}

// ── The engine ────────────────────────────────────────────────────────────────

function sameProgress(a: SyncProgress | null, b: SyncProgress | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.phase === b.phase && a.done === b.done && a.total === b.total
}

function sameLastError(a: SyncState['lastError'], b: SyncState['lastError']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.code === b.code && a.count === b.count && a.at === b.at
}

function sameState(a: SyncState, b: SyncState): boolean {
  return (
    a.status === b.status &&
    a.lastSyncAt === b.lastSyncAt &&
    a.errorCode === b.errorCode &&
    a.deviceId === b.deviceId &&
    sameProgress(a.progress, b.progress) &&
    sameLastError(a.lastError, b.lastError)
  )
}

// Thrown inside a cycle to end it quietly at a checkpoint.
class CycleHalted extends Error {
  constructor() {
    super('Sync cycle stopped')
    this.name = 'CycleHalted'
  }
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { api, ports, getUserId } = deps
  const syncCrypto = deps.crypto ?? defaultCrypto
  const clock = deps.clock ?? defaultClock()
  const isOnline = deps.isOnline ?? defaultIsOnline
  const locks = deps.locks ?? defaultLocks()
  const env = deps.env ?? defaultEnv()

  let state: SyncState = INITIAL_SYNC_STATE
  const subscribers = new Set<() => void>()
  const eventListeners = new Set<(event: SyncEngineEvent) => void>()

  let started = false
  let generation = 0
  let running: Promise<SyncCycleResult> | null = null
  let rerun = false
  let attempt = 0
  let retryTimer: unknown = null
  let debounceTimer: unknown = null
  let intervalTimer: unknown = null
  let removers: Array<() => void> = []

  // ── State store ────────────────────────────────────────────────────────────

  function emit(event: SyncEngineEvent): void {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(event)
      } catch (err) {
        console.error('Sync event listener failed:', errorName(err))
      }
    }
  }

  function setState(next: SyncState): void {
    if (sameState(state, next)) return
    state = next
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber()
      } catch (err) {
        console.error('Sync state subscriber failed:', errorName(err))
      }
    }
    emit({ type: 'state', state })
  }

  function fromMeta(meta: SyncMeta): Pick<SyncState, 'lastSyncAt' | 'lastError' | 'deviceId'> {
    return {
      lastSyncAt: meta.lastSyncAt ?? null,
      lastError: meta.lastError ?? null,
      deviceId: meta.deviceId ?? null,
    }
  }

  function setStatus(
    status: SyncStatusCode,
    meta: SyncMeta,
    extra: { errorCode?: string | null; progress?: SyncProgress | null } = {},
  ): void {
    setState({
      status,
      ...fromMeta(meta),
      progress: extra.progress ?? null,
      errorCode: extra.errorCode ?? null,
    })
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  function clearRetry(): void {
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function scheduleRetry(): void {
    clearRetry()
    attempt++
    retryTimer = clock.setTimeout(() => {
      retryTimer = null
      if (started) requestCycle('retry')
    }, nextBackoffMs(attempt))
  }

  function scheduleInterval(): void {
    intervalTimer = clock.setTimeout(() => {
      intervalTimer = null
      if (!started) return
      if (env.isVisible()) requestCycle('interval')
      scheduleInterval()
    }, SYNC_INTERVAL_MS)
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  function emptyResult(status: SyncStatusCode, ran: boolean): SyncCycleResult {
    return {
      ran,
      status,
      pulled: 0,
      applied: 0,
      pushed: 0,
      stale: 0,
      skipped: 0,
      deduped: 0,
      compacted: 0,
    }
  }

  async function cycle(): Promise<SyncCycleResult> {
    const gen = generation
    const result = emptyResult(state.status, true)
    let meta: SyncMeta = { localRev: 0 }

    const checkpoint = () => {
      if (gen !== generation || !ports.local.isUnlocked()) throw new CycleHalted()
    }

    // Applies records; a batch rejected as invalid is retried one by one and
    // the rejected records are skipped. A DecryptError (local data) propagates.
    const apply = async (
      records: Array<SyncRecord>,
      options?: ApplyIncomingOptions,
    ): Promise<number> => {
      const call = (list: Array<SyncRecord>) =>
        options
          ? ports.local.applyIncomingRecords(list, options)
          : ports.local.applyIncomingRecords(list)
      try {
        return (await call(records)).applied
      } catch (err) {
        if (isDecryptError(err)) throw err
        // Locked meanwhile: stop before the cursor moves past these rows.
        if (!ports.local.isUnlocked()) throw new CycleHalted()
        if (records.length === 1) {
          result.skipped++
          return 0
        }
        let applied = 0
        for (const record of records) {
          try {
            applied += (await call([record])).applied
          } catch (inner) {
            if (isDecryptError(inner)) throw inner
            result.skipped++
          }
        }
        return applied
      }
    }

    const decryptAll = async (
      keys: SyncKeys,
      rows: Array<Pick<EncryptedSyncRecord, 'record_key' | 'ciphertext' | 'iv' | 'enc_v'>>,
    ): Promise<Array<SyncRecord>> => {
      const out: Array<SyncRecord> = []
      for (const row of rows) {
        try {
          out.push(await syncCrypto.decrypt(keys, row))
        } catch {
          result.skipped++
        }
      }
      return out
    }

    const before = state.status

    try {
      // 1. Preconditions: no cloud call when one fails.
      meta = await ports.meta.read()
      if (!isSyncOn(meta)) {
        setState(INITIAL_SYNC_STATE)
        return { ...result, status: 'off' }
      }
      if (!ports.local.isUnlocked()) return { ...result, status: state.status }
      const userId = getUserId()
      if (userId === null) {
        setStatus('error', meta, { errorCode: 'not_signed_in' })
        return { ...result, status: 'error' }
      }
      if (userId !== meta.userId) {
        setStatus('other-account', meta)
        return { ...result, status: 'other-account' }
      }
      if (!isOnline()) {
        setStatus('offline', meta)
        return { ...result, status: 'offline' }
      }
      const on: SyncMeta & SyncFields = meta
      const { deviceId, vaultId } = on
      setStatus('syncing', meta)

      // 2. The gate, fresh every cycle.
      const status = await api.getSyncStatus()
      if (!hasFeature(status, 'sync')) {
        setStatus('paused', meta)
        return { ...result, status: 'paused' }
      }
      const cloudVault = status.vault
      if (!cloudVault || cloudVault.vault_id !== vaultId) {
        setStatus('cloud-deleted', meta)
        return { ...result, status: 'cloud-deleted' }
      }

      // 3. The header, before any record moves.
      if (on.headerPending === true) {
        const header = await ports.vault.getVaultHeader()
        let ref
        try {
          ref = await api.updateVaultHeader(deviceId, vaultId, header, on.headerRev)
        } catch (err) {
          if (asCloudError(err)?.code !== 'header_conflict') throw err
          const cloud = await api.getVault()
          if (!cloud || cloud.vault_id !== vaultId) throw new CloudError('no_vault')
          if (!(await ports.vault.headerMatchesDek(cloud.header))) {
            setStatus('vault-mismatch', meta)
            return { ...result, status: 'vault-mismatch' }
          }
          ref = await api.updateVaultHeader(deviceId, vaultId, header, cloud.header_rev)
        }
        meta = await ports.meta.update({ headerRev: ref.header_rev, headerPending: false })
      } else if (cloudVault.header_rev > on.headerRev) {
        const cloud = await api.getVault()
        if (!cloud || cloud.vault_id !== vaultId) {
          setStatus('cloud-deleted', meta)
          return { ...result, status: 'cloud-deleted' }
        }
        const adoption = await ports.vault.adoptHeaderIfSameDek(cloud.header)
        if (adoption === 'mismatch') {
          setStatus('vault-mismatch', meta)
          return { ...result, status: 'vault-mismatch' }
        }
        if (adoption === 'adopted') emit({ type: 'header-adopted' })
        meta = await ports.meta.update({ headerRev: cloud.header_rev })
      }

      checkpoint()
      // Fetched per cycle, never kept: it fails once the vault is locked.
      const keys = await ports.vault.getSyncKeys()

      // 4. Pull.
      let cursor = on.pullCursor
      const pullTotal = Math.max(0, cloudVault.last_seq - on.pullCursor)
      const recurringIds = new Set<string>()
      for (;;) {
        checkpoint()
        const page = await api.pullRecords(deviceId, vaultId, cursor, SYNC_PULL_LIMIT)
        result.pulled += page.records.length
        const decrypted = await decryptAll(keys, page.records)
        if (decrypted.length > 0) result.applied += await apply(decrypted)
        for (const record of decrypted) {
          const recurringId = record.data.recurringId
          if (
            (record.type === 'expense' || record.type === 'income') &&
            typeof recurringId === 'string' &&
            recurringId !== ''
          ) {
            recurringIds.add(recurringId)
          }
        }
        const last = page.records.at(-1)
        if (last) {
          cursor = last.seq
          meta = await ports.meta.update({ pullCursor: cursor })
        }
        setStatus('syncing', meta, {
          progress: { phase: 'pull', done: result.pulled, total: pullTotal },
        })
        await clock.yieldToUi()
        if (!page.has_more || page.records.length === 0) break
      }

      // 5. Legacy duplicate occurrences, once per cycle.
      if (recurringIds.size > 0) {
        checkpoint()
        result.deduped = await ports.local.dedupeOccurrences([...recurringIds])
      }

      // 6. Push.
      checkpoint()
      const snapshot = await ports.local.listChangedRecords(on.pushedRev)
      checkpoint()
      const encrypted: Array<EncryptedSyncRecord> = []
      for (const [i, record] of snapshot.records.entries()) {
        encrypted.push(await syncCrypto.encrypt(keys, record))
        if ((i + 1) % ENCRYPT_YIELD_EVERY === 0) {
          await clock.yieldToUi()
          checkpoint()
        }
      }
      const total = snapshot.records.length
      let done = 0
      for (const batch of planPushBatches(encrypted)) {
        checkpoint()
        const response = await api.pushRecords(deviceId, vaultId, batch)
        result.pushed += batch.length
        const currents: Array<EncryptedSyncRecord> = []
        for (const item of response.results) {
          if (item.status === 'stale') {
            result.stale++
            currents.push(item.current)
          }
        }
        const decrypted = await decryptAll(keys, currents)
        if (decrypted.length > 0) {
          result.applied += await apply(decrypted, { preferIncomingOnTie: true })
        }
        done += batch.length
        setStatus('syncing', meta, { progress: { phase: 'push', done, total } })
        await clock.yieldToUi()
      }
      if (snapshot.maxRev !== on.pushedRev) {
        meta = await ports.meta.update({ pushedRev: snapshot.maxRev })
      }

      // 7. Afterwards.
      result.compacted = await ports.local.compactTombstones(
        new Date(clock.now() - TOMBSTONE_RETENTION_MS).toISOString(),
        { maxRev: snapshot.maxRev },
      )
      const at = new Date(clock.now()).toISOString()
      meta = await ports.meta.update({
        lastSyncAt: at,
        lastError:
          result.skipped > 0 ? { code: 'undecryptable', count: result.skipped, at } : null,
      })
      attempt = 0
      clearRetry()
      setStatus('synced', meta)
      return { ...result, status: 'synced' }
    } catch (err) {
      if (err instanceof CycleHalted) {
        // Back to the baseline: nothing more is sent.
        const baseline: SyncStatusCode =
          before !== 'syncing' && before !== 'off'
            ? before
            : meta.lastSyncAt
              ? 'synced'
              : 'syncing'
        setStatus(baseline, meta)
        return { ...result, status: baseline }
      }
      const cloudError = asCloudError(err)
      if (cloudError) {
        const { status, retry } = statusForCloudError(cloudError.code)
        if (status === 'error') {
          try {
            meta = await ports.meta.update({
              lastError: { code: cloudError.code, at: new Date(clock.now()).toISOString() },
            })
          } catch (metaErr) {
            console.error('Could not save the sync error:', errorName(metaErr))
          }
          setStatus('error', meta, { errorCode: cloudError.code })
          if (retry && started) scheduleRetry()
        } else {
          setStatus(status, meta)
        }
        return { ...result, status }
      }
      if (isDecryptError(err)) {
        emit({ type: 'data-problem', error: err })
        setStatus('error', meta, { errorCode: 'decrypt' })
        return { ...result, status: 'error' }
      }
      console.error('Sync cycle failed:', errorName(err))
      setStatus('error', meta, { errorCode: 'unexpected' })
      return { ...result, status: 'error' }
    }
  }

  async function lockedCycle(): Promise<SyncCycleResult> {
    try {
      return await locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, (lock) =>
        lock === null
          ? Promise.resolve(emptyResult(state.status, false))
          : cycle(),
      )
    } catch (err) {
      console.error('Sync lock failed:', errorName(err))
      setState({ ...state, status: 'error', errorCode: 'unexpected', progress: null })
      return emptyResult('error', true)
    }
  }

  async function runCycle(
    options: { reason?: SyncTrigger } = {},
  ): Promise<SyncCycleResult> {
    const reason = options.reason
    if (running) {
      // A turn-on or restore must run its own cycle: wait for this one.
      if (reason === 'turn-on' || reason === 'restore') {
        await running.catch(() => undefined)
        return runCycle(options)
      }
      rerun = true
      return emptyResult(state.status, false)
    }
    const current = lockedCycle()
    running = current
    try {
      return await current
    } finally {
      running = null
      if (rerun) {
        rerun = false
        void runCycle({ reason: 'retry' })
      }
    }
  }

  function requestCycle(reason: SyncTrigger): void {
    if (reason === 'local-change') {
      if (debounceTimer !== null) clock.clearTimeout(debounceTimer)
      debounceTimer = clock.setTimeout(() => {
        debounceTimer = null
        void runCycle({ reason })
      }, SYNC_DEBOUNCE_MS)
      return
    }
    void runCycle({ reason })
  }

  return {
    getState: () => state,
    subscribe(listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    async refreshFromMeta() {
      let meta: SyncMeta
      try {
        meta = await ports.meta.read()
      } catch (err) {
        console.error('Could not read the sync state:', errorName(err))
        return state
      }
      if (!isSyncOn(meta)) {
        setState(INITIAL_SYNC_STATE)
        return state
      }
      const status: SyncStatusCode = PROBLEM_STATUSES.has(state.status)
        ? state.status
        : meta.lastSyncAt
          ? 'synced'
          : 'syncing'
      setStatus(status, meta)
      return state
    },
    runCycle,
    requestCycle,
    start() {
      if (started) return
      started = true
      generation++
      removers = [
        ports.local.onLocalChange(() => requestCycle('local-change')),
        env.listen('window', 'online', () => requestCycle('online')),
        env.listen('document', 'visibilitychange', () => {
          if (env.isVisible()) requestCycle('visible')
        }),
      ]
      scheduleInterval()
      requestCycle('unlock')
    },
    stop() {
      generation++
      started = false
      for (const remove of removers.splice(0)) {
        try {
          remove()
        } catch (err) {
          console.error('Could not remove a sync listener:', errorName(err))
        }
      }
      for (const timer of [debounceTimer, intervalTimer]) {
        if (timer !== null) clock.clearTimeout(timer)
      }
      debounceTimer = null
      intervalTimer = null
      clearRetry()
      attempt = 0
    },
  }
}
