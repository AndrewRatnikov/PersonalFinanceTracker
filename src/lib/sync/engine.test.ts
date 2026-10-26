// No CONTRACT_GAPs: engine exports, constants, the cycle order and the state
// names are specified in plan section 7 and the Interface Contract (module:
// engine). The engine runs against fake api / ports / crypto / clock / locks, so
// no network, storage or real crypto is touched; the PGlite end-to-end flows
// live in src/test/sync/.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudApi } from '@/lib/cloud/api'
import type {
  CloudErrorCode,
  CloudRecordRow,
  EncryptedSyncRecord,
  PullResult,
  PushResult,
  SyncStatus,
} from '@/lib/cloud/types'
import type { ChangedRecords } from '@/lib/localDb'
import type { SyncRecord } from '@/lib/syncRecords'
import type {
  SyncClock,
  SyncCryptoPort,
  SyncEngineEvent,
  SyncEnv,
  SyncLockManager,
  SyncMeta,
  SyncPorts,
  SyncState,
} from '@/lib/sync/types'
import type { VaultHeaderV2 } from '@/lib/vault'
import { CloudError } from '@/lib/cloud/api'
import {
  INITIAL_SYNC_STATE,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_MAX_MS,
  SYNC_DEBOUNCE_MS,
  SYNC_INTERVAL_MS,
  SYNC_LOCK_NAME,
  SYNC_PULL_LIMIT,
  TOMBSTONE_RETENTION_MS,
  createSyncEngine,
  nextBackoffMs,
  planPushBatches,
  statusForCloudError,
} from '@/lib/sync/engine'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const USER = 'user-1'
const DEVICE = 'device-1'
const VAULT = 'vault-1'

const ON_META: SyncMeta = {
  localRev: 9,
  enabled: true,
  userId: USER,
  vaultId: VAULT,
  deviceId: DEVICE,
  pushedRev: 2,
  pullCursor: 10,
  headerRev: 1,
  lastSyncAt: null,
  lastError: null,
}

const HEADER = {
  v: 2,
  vaultId: VAULT,
  createdAt: '2026-10-01T00:00:00.000Z',
  kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==' },
  wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
  recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
  verifier: { iv: 'aXY=', ct: 'Y3Q=' },
} as VaultHeaderV2

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    plan_id: 'beta',
    has_sync: true,
    free_for_all: true,
    granted_by: 'free_for_all',
    beta_joined_at: null,
    entitlement_status: null,
    current_period_end: null,
    limits: { sync: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
    vault: {
      vault_id: VAULT,
      header_rev: 1,
      record_count: 0,
      total_bytes: 0,
      last_seq: 10,
    },
    devices_count: 1,
    ...overrides,
  }
}

function record(id: string, extra: Partial<SyncRecord> = {}): SyncRecord {
  return {
    type: 'expense',
    id,
    updatedAt: '2026-10-20T10:00:00.000Z',
    data: { id, createdAt: '2026-10-20T10:00:00.000Z', amount: 100 },
    ...extra,
  }
}

// The fake crypto turns a record into JSON "ciphertext"; 'BAD' cannot be read.
const fakeCrypto: SyncCryptoPort = {
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}

function wire(r: SyncRecord): EncryptedSyncRecord {
  return {
    record_key: `key-${r.type}-${r.id}`,
    ciphertext: JSON.stringify(r),
    iv: 'iv',
    enc_v: 1,
    updated_at_ms: Date.parse(r.updatedAt),
  }
}

function row(r: SyncRecord | 'BAD', seq: number): CloudRecordRow {
  const base =
    r === 'BAD'
      ? { record_key: `key-bad-${seq}`, ciphertext: 'BAD', iv: 'iv', enc_v: 1, updated_at_ms: 1 }
      : wire(r)
  return { ...base, device_id: 'other-device', seq }
}

function page(rows: Array<CloudRecordRow>, hasMore: boolean): PullResult {
  return {
    records: rows,
    has_more: hasMore,
    last_seq: rows.at(-1)?.seq ?? 0,
    vault_id: VAULT,
  }
}

function accepted(records: Array<EncryptedSyncRecord>, from = 100): PushResult {
  return {
    results: records.map((r, i) => ({
      record_key: r.record_key,
      status: 'accepted' as const,
      seq: from + i,
    })),
    last_seq: from + records.length,
  }
}

interface Harness {
  engine: ReturnType<typeof createSyncEngine>
  api: { [K in keyof CloudApi]: ReturnType<typeof vi.fn> }
  local: {
    [K in keyof SyncPorts['local']]: ReturnType<typeof vi.fn>
  }
  vault: { [K in keyof SyncPorts['vault']]: ReturnType<typeof vi.fn> }
  meta: { [K in keyof SyncPorts['meta']]: ReturnType<typeof vi.fn> }
  metaValue: () => SyncMeta
  order: Array<string>
  states: Array<SyncState>
  events: Array<SyncEngineEvent>
  state: { userId: string | null; online: boolean; unlocked: boolean; visible: boolean }
  locks: { held: boolean; requested: Array<string> }
  timers: {
    advance: (ms: number) => Promise<void>
    pending: () => Array<number>
    set: Array<number>
  }
  env: { fire: (target: 'window' | 'document', type: string) => void; count: () => number }
  localChange: () => void
}

function createHarness(
  options: {
    meta?: Partial<SyncMeta>
    local?: Record<string, unknown>
  } = {},
): Harness {
  let metaValue: SyncMeta = { ...ON_META, ...options.meta }
  const order: Array<string> = []
  const states: Array<SyncState> = []
  const events: Array<SyncEngineEvent> = []
  const state = { userId: USER as string | null, online: true, unlocked: true, visible: true }

  const api = {
    getSyncStatus: vi.fn(() => Promise.resolve(syncStatus())),
    getVault: vi.fn(() => Promise.resolve(null)),
    registerDevice: vi.fn(),
    listDevices: vi.fn(),
    renameDevice: vi.fn(),
    removeDevice: vi.fn(),
    createVault: vi.fn(),
    updateVaultHeader: vi.fn(() => Promise.resolve({ vault_id: VAULT, header_rev: 2 })),
    pushRecords: vi.fn((_d: string, _v: string, recs: Array<EncryptedSyncRecord>) => {
      order.push('push')
      return Promise.resolve(accepted(recs))
    }),
    pullRecords: vi.fn(() => {
      order.push('pull')
      return Promise.resolve(page([], false))
    }),
    deleteCloudData: vi.fn(),
  }

  const local = {
    isUnlocked: vi.fn(() => state.unlocked),
    listChangedRecords: vi.fn(
      (): Promise<ChangedRecords> => Promise.resolve({ maxRev: 9, records: [] }),
    ),
    applyIncomingRecords: vi.fn((recs: Array<SyncRecord>) =>
      Promise.resolve({
        applied: recs.length,
        kept: 0,
        conflicts: 0,
      }),
    ),
    compactTombstones: vi.fn(() => Promise.resolve(0)),
    dedupeOccurrences: vi.fn(() => Promise.resolve(0)),
    onLocalChange: vi.fn((listener: () => void) => {
      localListener = listener
      return () => {
        localListener = null
      }
    }),
    ...options.local,
  }
  let localListener: (() => void) | null = null

  const vault = {
    getSyncKeys: vi.fn(() => Promise.resolve({} as never)),
    getVaultHeader: vi.fn(() => Promise.resolve(HEADER)),
    getVaultState: vi.fn(() => Promise.resolve('v2' as const)),
    adoptHeaderIfSameDek: vi.fn(() => Promise.resolve('unchanged' as const)),
    headerMatchesDek: vi.fn(() => Promise.resolve(true)),
    adoptCloudVault: vi.fn(),
    joinCloudVault: vi.fn(),
    verifyPassword: vi.fn(),
    onHeaderChange: vi.fn(() => () => undefined),
  }

  const meta = {
    read: vi.fn(() => Promise.resolve({ ...metaValue })),
    update: vi.fn((patch: Partial<SyncMeta>) => {
      if ('pushedRev' in patch) order.push('meta:pushedRev')
      if ('pullCursor' in patch) order.push('meta:pullCursor')
      metaValue = { ...metaValue, ...patch }
      return Promise.resolve({ ...metaValue })
    }),
    clear: vi.fn(() => {
      metaValue = { localRev: metaValue.localRev }
      return Promise.resolve({ ...metaValue })
    }),
  }

  // A tiny timer scheduler: nothing runs until `advance`.
  let virtual = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; fn: () => void }>()
  const setDelays: Array<number> = []
  const clock: SyncClock = {
    now: () => NOW,
    setTimeout(fn, ms) {
      const id = nextId++
      setDelays.push(ms)
      scheduled.set(id, { at: virtual + ms, fn })
      return id
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number)
    },
    yieldToUi: () => Promise.resolve(),
  }
  const timers: Harness['timers'] = {
    set: setDelays,
    pending: () => Array.from(scheduled.values()).map((t) => t.at - virtual),
    async advance(ms) {
      const target = virtual + ms
      for (;;) {
        const due = Array.from(scheduled.entries())
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
          .shift()
        if (!due) break
        scheduled.delete(due[0])
        virtual = Math.max(virtual, due[1].at)
        due[1].fn()
        await flush()
      }
      virtual = target
    },
  }

  const lockState = { held: false, requested: [] as Array<string> }
  const locks: SyncLockManager = {
    request<T>(
      name: string,
      _options: { ifAvailable: true },
      callback: (lock: unknown) => Promise<T>,
    ): Promise<T> {
      lockState.requested.push(name)
      return callback(lockState.held ? null : { name })
    },
  }

  const listeners = new Map<string, Set<() => void>>()
  const env: SyncEnv = {
    listen(target, type, listener) {
      const key = `${target}:${type}`
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
      }
    },
    isVisible: () => state.visible,
  }

  const ports = { local, vault, meta } as unknown as SyncPorts
  const engine = createSyncEngine({
    api: api as unknown as CloudApi,
    ports,
    getUserId: () => state.userId,
    crypto: fakeCrypto,
    clock,
    isOnline: () => state.online,
    locks,
    env,
  })
  engine.onEvent((e) => {
    events.push(e)
    if (e.type === 'state') states.push(e.state)
  })

  return {
    engine,
    api,
    local,
    vault,
    meta,
    metaValue: () => metaValue,
    order,
    states,
    events,
    state,
    locks: lockState as Harness['locks'] & { held: boolean },
    timers,
    env: {
      fire(target, type) {
        for (const l of Array.from(listeners.get(`${target}:${type}`) ?? [])) l()
      },
      count: () => Array.from(listeners.values()).reduce((n, s) => n + s.size, 0),
    },
    localChange: () => localListener?.(),
  }
}

// One macrotask: every pending microtask chain (a whole fake cycle) has run.
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

beforeEach(() => {
  vi.mocked(fakeCrypto.encrypt).mockReset()
  vi.mocked(fakeCrypto.decrypt).mockReset()
  vi.mocked(fakeCrypto.encrypt).mockImplementation((_keys, r) => Promise.resolve(wire(r)))
  vi.mocked(fakeCrypto.decrypt).mockImplementation((_keys, r) => {
    if (r.ciphertext === 'BAD') return Promise.reject(new Error('cannot decrypt'))
    return Promise.resolve(JSON.parse(r.ciphertext) as SyncRecord)
  })
})

describe('constants', () => {
  it('has the documented values', () => {
    expect(SYNC_LOCK_NAME).toBe('minima-sync')
    expect(SYNC_DEBOUNCE_MS).toBe(2000)
    expect(SYNC_INTERVAL_MS).toBe(60_000)
    expect(SYNC_BACKOFF_BASE_MS).toBe(5000)
    expect(SYNC_BACKOFF_MAX_MS).toBe(300_000)
    expect(TOMBSTONE_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000)
    expect(SYNC_PULL_LIMIT).toBe(500)
    expect(INITIAL_SYNC_STATE.status).toBe('off')
    expect(INITIAL_SYNC_STATE.progress).toBeNull()
    expect(INITIAL_SYNC_STATE.errorCode).toBeNull()
  })
})

describe('planPushBatches', () => {
  const recs = (n: number, size = 10): Array<EncryptedSyncRecord> =>
    Array.from({ length: n }, (_, i) => ({
      record_key: `k${i}`,
      ciphertext: 'c'.repeat(size),
      iv: 'iv',
      enc_v: 1,
      updated_at_ms: i,
    }))

  it('splits by record count and keeps the order', () => {
    const batches = planPushBatches(recs(5), 2)
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1])
    expect(batches.flat().map((r) => r.record_key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4'])
  })

  it('splits by total ciphertext characters', () => {
    const batches = planPushBatches(recs(5, 40), 500, 100)
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1])
  })

  it('a different limit gives a different split', () => {
    expect(planPushBatches(recs(6), 3).map((b) => b.length)).toEqual([3, 3])
    expect(planPushBatches(recs(6), 4).map((b) => b.length)).toEqual([4, 2])
  })

  it('puts a single oversize record in its own batch', () => {
    const list = [...recs(1, 5), ...recs(1, 500).map((r) => ({ ...r, record_key: 'big' })), ...recs(1, 5).map((r) => ({ ...r, record_key: 'tail' }))]
    const batches = planPushBatches(list, 500, 100)
    expect(batches.map((b) => b.map((r) => r.record_key))).toEqual([['k0'], ['big'], ['tail']])
  })

  it('defaults to 500 records and 1 MB', () => {
    expect(planPushBatches(recs(501)).map((b) => b.length)).toEqual([500, 1])
    expect(planPushBatches(recs(3, 400_000)).map((b) => b.length)).toEqual([2, 1])
  })

  it('returns no batches for no records', () => {
    expect(planPushBatches([])).toEqual([])
  })
})

describe('nextBackoffMs', () => {
  it('starts at 5 s, doubles and caps at 5 minutes', () => {
    expect(nextBackoffMs(1)).toBe(5000)
    expect(nextBackoffMs(2)).toBe(10_000)
    expect(nextBackoffMs(3)).toBe(20_000)
    expect(nextBackoffMs(6)).toBe(160_000)
    expect(nextBackoffMs(7)).toBe(300_000)
    expect(nextBackoffMs(30)).toBe(300_000)
  })

  it('is 0 for attempt 0 or below', () => {
    expect(nextBackoffMs(0)).toBe(0)
    expect(nextBackoffMs(-3)).toBe(0)
  })
})

describe('statusForCloudError', () => {
  const cases: Array<[CloudErrorCode, string, boolean]> = [
    ['device_removed', 'device-removed', false],
    ['no_vault', 'cloud-deleted', false],
    ['device_not_registered', 'cloud-deleted', false],
    ['vault_mismatch', 'cloud-deleted', false],
    ['sync_not_included', 'paused', false],
    ['network', 'error', true],
    ['unknown', 'error', true],
    ['not_signed_in', 'error', false],
    ['quota_exceeded', 'error', false],
    ['batch_too_large', 'error', false],
    ['invalid_input', 'error', false],
    ['header_conflict', 'error', false],
    ['device_limit', 'error', false],
    ['vault_exists', 'error', false],
  ]
  it.each(cases)('%s -> %s (retry %s)', (code, status, retry) => {
    expect(statusForCloudError(code)).toEqual({ status, retry })
  })
})

describe('preconditions', () => {
  it('state off when sync is not on in meta, with no cloud call', async () => {
    const h = createHarness({ meta: { enabled: false } })
    const result = await h.engine.runCycle()

    expect(result.status).toBe('off')
    expect(h.engine.getState().status).toBe('off')
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })

  it('missing fields mean off', async () => {
    const h = createHarness({ meta: { vaultId: undefined } })
    expect((await h.engine.runCycle()).status).toBe('off')
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
  })

  it('locked: no state change and no call', async () => {
    const h = createHarness()
    h.state.unlocked = false
    const before = h.engine.getState()
    const result = await h.engine.runCycle()

    expect(result.ran).toBe(true)
    expect(result.pushed).toBe(0)
    expect(h.engine.getState()).toBe(before)
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
  })

  it('not signed in: error not_signed_in', async () => {
    const h = createHarness()
    h.state.userId = null
    await h.engine.runCycle()

    expect(h.engine.getState().status).toBe('error')
    expect(h.engine.getState().errorCode).toBe('not_signed_in')
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
  })

  it('another account: other-account and nothing is pushed', async () => {
    const h = createHarness()
    h.state.userId = 'user-2'
    const result = await h.engine.runCycle()

    expect(result.status).toBe('other-account')
    expect(h.engine.getState().status).toBe('other-account')
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })

  it('the same user id as in meta is not another account', async () => {
    const h = createHarness({ meta: { userId: 'user-9' } })
    h.state.userId = 'user-9'
    expect((await h.engine.runCycle()).status).toBe('synced')
  })

  it('offline: state offline and no call', async () => {
    const h = createHarness()
    h.state.online = false
    const result = await h.engine.runCycle()

    expect(result.status).toBe('offline')
    expect(h.engine.getState().status).toBe('offline')
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
  })
})

describe('the gate', () => {
  it('paused when the plan does not include sync: nothing moves', async () => {
    const h = createHarness()
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({ limits: { sync: false, max_devices: 0, max_records: 0, max_bytes: 0 } }),
    )
    const result = await h.engine.runCycle()

    expect(result.status).toBe('paused')
    expect(h.engine.getState().status).toBe('paused')
    expect(h.api.pullRecords).not.toHaveBeenCalled()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
    expect(h.api.updateVaultHeader).not.toHaveBeenCalled()
  })

  it('cloud-deleted when the server has no vault', async () => {
    const h = createHarness()
    h.api.getSyncStatus.mockResolvedValue(syncStatus({ vault: null }))
    expect((await h.engine.runCycle()).status).toBe('cloud-deleted')
    expect(h.api.pullRecords).not.toHaveBeenCalled()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })

  it('cloud-deleted when the vault id differs from the one in meta', async () => {
    const h = createHarness()
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({
        vault: { vault_id: 'other', header_rev: 1, record_count: 0, total_bytes: 0, last_seq: 0 },
      }),
    )
    expect((await h.engine.runCycle()).status).toBe('cloud-deleted')
    expect(h.api.pullRecords).not.toHaveBeenCalled()
  })

  it('asks for a fresh status at the start of every cycle', async () => {
    const h = createHarness()
    await h.engine.runCycle()
    await h.engine.runCycle()
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(2)
  })

  it('a plan lost between two cycles pauses the second one', async () => {
    const h = createHarness()
    expect((await h.engine.runCycle()).status).toBe('synced')
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({ limits: { sync: false, max_devices: 0, max_records: 0, max_bytes: 0 } }),
    )
    h.api.pushRecords.mockClear()
    expect((await h.engine.runCycle()).status).toBe('paused')
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })
})

describe('a normal cycle', () => {
  it('pulls every page from pullCursor, then pushes, and saves the cursor per page', async () => {
    const h = createHarness()
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({
        vault: { vault_id: VAULT, header_rev: 1, record_count: 4, total_bytes: 1, last_seq: 25 },
      }),
    )
    h.api.pullRecords
      .mockImplementationOnce(() => {
        h.order.push('pull')
        return Promise.resolve(page([row(record('a'), 11), row(record('b'), 12)], true))
      })
      .mockImplementationOnce(() => {
        h.order.push('pull')
        return Promise.resolve(page([row(record('c'), 20)], false))
      })
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 9, records: [record('mine')] })

    const result = await h.engine.runCycle()

    expect(h.api.pullRecords).toHaveBeenCalledTimes(2)
    expect(h.api.pullRecords.mock.calls[0]).toEqual([DEVICE, VAULT, 10, SYNC_PULL_LIMIT])
    expect(h.api.pullRecords.mock.calls[1]).toEqual([DEVICE, VAULT, 12, SYNC_PULL_LIMIT])
    expect(h.meta.update).toHaveBeenCalledWith({ pullCursor: 12 })
    expect(h.meta.update).toHaveBeenCalledWith({ pullCursor: 20 })
    expect(h.local.applyIncomingRecords).toHaveBeenCalledTimes(2)
    expect(
      h.local.applyIncomingRecords.mock.calls.map((c) => (c[0] as Array<SyncRecord>).map((r) => r.id)),
    ).toEqual([['a', 'b'], ['c']])
    expect(h.local.listChangedRecords).toHaveBeenCalledWith(2)
    expect(h.api.pushRecords).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ran: true, status: 'synced', pulled: 3, applied: 3, pushed: 1, skipped: 0 })
    expect(h.order.indexOf('push')).toBeGreaterThan(h.order.lastIndexOf('pull'))
    expect(h.metaValue().pullCursor).toBe(20)
    expect(h.metaValue().pushedRev).toBe(9)
  })

  it('saves lastSyncAt and ends synced', async () => {
    const h = createHarness()
    await h.engine.runCycle()

    expect(h.metaValue().lastSyncAt).toBe(new Date(NOW).toISOString())
    expect(h.metaValue().lastError).toBeNull()
    expect(h.engine.getState().status).toBe('synced')
    expect(h.engine.getState().lastSyncAt).toBe(new Date(NOW).toISOString())
    expect(h.engine.getState().progress).toBeNull()
  })

  it('goes through syncing with pull and push progress', async () => {
    const h = createHarness()
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({
        vault: { vault_id: VAULT, header_rev: 1, record_count: 0, total_bytes: 0, last_seq: 25 },
      }),
    )
    h.api.pullRecords
      .mockResolvedValueOnce(page([row(record('a'), 11), row(record('b'), 12)], true))
      .mockResolvedValueOnce(page([row(record('c'), 13)], false))
    h.local.listChangedRecords.mockResolvedValue({
      maxRev: 9,
      records: [record('x'), record('y'), record('z'), record('w')],
    })
    await h.engine.runCycle()

    const syncing = h.states.filter((s) => s.status === 'syncing')
    expect(syncing.length).toBeGreaterThan(0)
    const pulls = syncing.filter((s) => s.progress?.phase === 'pull')
    expect(pulls.map((s) => s.progress?.done)).toContain(2)
    expect(pulls.at(-1)?.progress?.done).toBe(3)
    expect(pulls[0].progress?.total).toBe(15)
    const pushes = syncing.filter((s) => s.progress?.phase === 'push')
    expect(pushes.at(-1)?.progress).toEqual({ phase: 'push', done: 4, total: 4 })
  })

  it('splits a big push into batches and sets pushedRev only after all of them', async () => {
    const h = createHarness()
    const many = Array.from({ length: 501 }, (_, i) => record(`r${i}`))
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 77, records: many })
    await h.engine.runCycle()

    expect(h.api.pushRecords).toHaveBeenCalledTimes(2)
    expect((h.api.pushRecords.mock.calls[0][2] as Array<unknown>).length).toBe(500)
    expect((h.api.pushRecords.mock.calls[1][2] as Array<unknown>).length).toBe(1)
    const pushedRevUpdates = h.meta.update.mock.calls.filter((c) => 'pushedRev' in (c[0] as object))
    expect(pushedRevUpdates).toHaveLength(1)
    expect(pushedRevUpdates[0][0]).toEqual({ pushedRev: 77 })
    expect(h.order.lastIndexOf('push')).toBeLessThan(h.order.indexOf('meta:pushedRev'))
  })

  it('a failing second batch leaves pushedRev unchanged and schedules a retry', async () => {
    const h = createHarness()
    const many = Array.from({ length: 501 }, (_, i) => record(`r${i}`))
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 77, records: many })
    h.api.pushRecords
      .mockImplementationOnce((_d: string, _v: string, recs: Array<EncryptedSyncRecord>) =>
        Promise.resolve(accepted(recs)),
      )
      .mockRejectedValueOnce(new CloudError('network'))
    // start() runs the first cycle (and arms the retry timer) on its own.
    h.engine.start()
    await flush()

    expect(h.api.pushRecords).toHaveBeenCalledTimes(2)
    expect(h.engine.getState().status).toBe('error')
    expect(h.engine.getState().errorCode).toBe('network')
    expect(h.metaValue().pushedRev).toBe(2)
    expect(h.meta.update.mock.calls.some((c) => 'pushedRev' in (c[0] as object))).toBe(false)
    expect(h.metaValue().lastError).toMatchObject({ code: 'network' })
    expect(h.timers.set).toContain(SYNC_BACKOFF_BASE_MS)
    h.engine.stop()
  })

  it('applies the current copy of a stale result with preferIncomingOnTie', async () => {
    const h = createHarness()
    const mine = record('e1')
    const theirs = record('e1', { data: { id: 'e1', createdAt: '2026-10-20T10:00:00.000Z', amount: 999 } })
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 9, records: [mine] })
    h.api.pushRecords.mockResolvedValue({
      results: [{ record_key: wire(mine).record_key, status: 'stale', current: row(theirs, 50) }],
      last_seq: 50,
    })
    const result = await h.engine.runCycle()

    const calls = h.local.applyIncomingRecords.mock.calls
    const staleCall = calls.find((c) => (c[1] as { preferIncomingOnTie?: boolean } | undefined)?.preferIncomingOnTie === true)
    expect(staleCall).toBeTruthy()
    expect((staleCall?.[0] as Array<SyncRecord>)[0].data.amount).toBe(999)
    expect(result.stale).toBe(1)
    // The pull itself does not prefer the incoming record on a tie.
    const pullCalls = calls.filter((c) => (c[1] as { preferIncomingOnTie?: boolean } | undefined)?.preferIncomingOnTie !== true)
    expect(pullCalls).toHaveLength(0)
  })

  it('compacts old tombstones up to the pushed rev only', async () => {
    const h = createHarness()
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 31, records: [] })
    h.local.compactTombstones.mockResolvedValue(4)
    const result = await h.engine.runCycle()

    expect(h.local.compactTombstones).toHaveBeenCalledTimes(1)
    expect(h.local.compactTombstones).toHaveBeenCalledWith(
      new Date(NOW - TOMBSTONE_RETENTION_MS).toISOString(),
      { maxRev: 31 },
    )
    expect(result.compacted).toBe(4)
  })

  it('never calls anything but get_sync_status, pull and push for a plain cycle', async () => {
    const h = createHarness()
    await h.engine.runCycle()
    expect(h.api.deleteCloudData).not.toHaveBeenCalled()
    expect(h.api.createVault).not.toHaveBeenCalled()
    expect(h.api.registerDevice).not.toHaveBeenCalled()
    expect(h.api.updateVaultHeader).not.toHaveBeenCalled()
    expect(h.api.getVault).not.toHaveBeenCalled()
  })

  it('fetches the sync keys per cycle and does not cache them', async () => {
    const h = createHarness()
    await h.engine.runCycle()
    await h.engine.runCycle()
    expect(h.vault.getSyncKeys).toHaveBeenCalledTimes(2)
  })
})

describe('bad rows and bad data', () => {
  it('skips an undecryptable row, applies the others and reports it', async () => {
    const h = createHarness()
    h.api.pullRecords.mockResolvedValueOnce(
      page([row(record('a'), 11), row('BAD', 12), row(record('c'), 13)], false),
    )
    const result = await h.engine.runCycle()

    expect(
      (h.local.applyIncomingRecords.mock.calls[0][0] as Array<SyncRecord>).map((r) => r.id),
    ).toEqual(['a', 'c'])
    expect(result.skipped).toBe(1)
    expect(h.metaValue().pullCursor).toBe(13)
    expect(h.metaValue().lastError).toMatchObject({ code: 'undecryptable', count: 1 })
    expect(h.engine.getState().lastError).toMatchObject({ code: 'undecryptable', count: 1 })
    expect(h.engine.getState().status).toBe('synced')
  })

  it('counts every undecryptable row', async () => {
    const h = createHarness()
    h.api.pullRecords.mockResolvedValueOnce(
      page([row('BAD', 11), row('BAD', 12), row('BAD', 13)], false),
    )
    await h.engine.runCycle()
    expect(h.metaValue().lastError).toMatchObject({ code: 'undecryptable', count: 3 })
    expect(h.local.applyIncomingRecords).not.toHaveBeenCalled()
  })

  it('a clean cycle clears an earlier lastError', async () => {
    const h = createHarness({ meta: { lastError: { code: 'undecryptable', count: 2, at: 'x' } } })
    await h.engine.runCycle()
    expect(h.metaValue().lastError).toBeNull()
  })

  it('falls back to one-by-one apply when a batch is rejected, skipping the invalid record', async () => {
    const h = createHarness()
    h.api.pullRecords.mockResolvedValueOnce(
      page([row(record('a'), 11), row(record('bad'), 12), row(record('c'), 13)], false),
    )
    h.local.applyIncomingRecords.mockImplementation((recs: Array<SyncRecord>) => {
      if (recs.length > 1) {
        return Promise.reject(new Error('applyIncomingRecords: invalid record 1'))
      }
      if (recs[0].id === 'bad') {
        return Promise.reject(new Error('applyIncomingRecords: invalid record 0'))
      }
      return Promise.resolve({ applied: 1, kept: 0, conflicts: 0 })
    })
    const result = await h.engine.runCycle()

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(2)
    expect(h.metaValue().pullCursor).toBe(13)
    expect(h.engine.getState().status).toBe('synced')
  })

  it('a DecryptError from local data is a data problem, not a skip', async () => {
    const h = createHarness()
    class DecryptError extends Error {
      constructor() {
        super('x')
        this.name = 'DecryptError'
      }
    }
    h.api.pullRecords.mockResolvedValueOnce(page([row(record('a'), 11)], false))
    h.local.applyIncomingRecords.mockRejectedValue(new DecryptError())
    const result = await h.engine.runCycle()

    expect(result.status).toBe('error')
    expect(h.engine.getState().errorCode).toBe('decrypt')
    expect(h.events.some((e) => e.type === 'data-problem')).toBe(true)
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })
})

describe('recurring duplicates', () => {
  it('dedupes once per cycle for the recurring ids of pulled entries', async () => {
    const h = createHarness()
    const withRecurring = (id: string, recurringId: string) =>
      record(id, { data: { id, createdAt: '2026-10-20T10:00:00.000Z', recurringId } })
    h.api.pullRecords
      .mockImplementationOnce(() => {
        h.order.push('pull')
        return Promise.resolve(
          page([row(withRecurring('a', 'r1'), 11), row(withRecurring('b', 'r1'), 12)], true),
        )
      })
      .mockImplementationOnce(() => {
        h.order.push('pull')
        return Promise.resolve(
          page([row(withRecurring('c', 'r2'), 13), row(record('d'), 14)], false),
        )
      })
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 9, records: [record('mine')] })
    h.local.dedupeOccurrences.mockResolvedValue(1)
    const result = await h.engine.runCycle()

    expect(h.local.dedupeOccurrences).toHaveBeenCalledTimes(1)
    expect([...(h.local.dedupeOccurrences.mock.calls[0][0] as Array<string>)].sort()).toEqual(['r1', 'r2'])
    expect(result.deduped).toBe(1)
    expect(h.order.indexOf('push')).toBeGreaterThan(h.order.lastIndexOf('pull'))
  })

  it('does not dedupe when nothing pulled carries a recurringId', async () => {
    const h = createHarness()
    h.api.pullRecords.mockResolvedValueOnce(page([row(record('a'), 11)], false))
    await h.engine.runCycle()
    expect(h.local.dedupeOccurrences).not.toHaveBeenCalled()
  })
})

describe('header handling', () => {
  it('pushes a pending header with the expected rev, then clears the flag', async () => {
    const h = createHarness({ meta: { headerPending: true, headerRev: 3 } })
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({
        vault: { vault_id: VAULT, header_rev: 3, record_count: 0, total_bytes: 0, last_seq: 10 },
      }),
    )
    h.api.updateVaultHeader.mockResolvedValue({ vault_id: VAULT, header_rev: 4 })
    await h.engine.runCycle()

    expect(h.api.updateVaultHeader).toHaveBeenCalledWith(DEVICE, VAULT, HEADER, 3)
    expect(h.metaValue().headerRev).toBe(4)
    expect(h.metaValue().headerPending).toBe(false)
    const headerCallIndex = h.api.updateVaultHeader.mock.invocationCallOrder[0]
    expect(headerCallIndex).toBeLessThan(h.api.pullRecords.mock.invocationCallOrder[0])
  })

  it('on header_conflict with a header of the same DEK it retries once with the cloud rev', async () => {
    const h = createHarness({ meta: { headerPending: true, headerRev: 1 } })
    h.api.updateVaultHeader
      .mockRejectedValueOnce(new CloudError('header_conflict'))
      .mockResolvedValueOnce({ vault_id: VAULT, header_rev: 6 })
    h.api.getVault.mockResolvedValue({ vault_id: VAULT, header: HEADER, header_rev: 5 })
    await h.engine.runCycle()

    expect(h.api.updateVaultHeader).toHaveBeenCalledTimes(2)
    expect(h.api.updateVaultHeader.mock.calls[0][3]).toBe(1)
    expect(h.api.updateVaultHeader.mock.calls[1][3]).toBe(5)
    expect(h.vault.headerMatchesDek).toHaveBeenCalledWith(HEADER)
    expect(h.metaValue().headerRev).toBe(6)
    expect(h.metaValue().headerPending).toBe(false)
  })

  it('on header_conflict with a header of another DEK it ends in vault-mismatch', async () => {
    const h = createHarness({ meta: { headerPending: true, headerRev: 1 } })
    h.api.updateVaultHeader.mockRejectedValueOnce(new CloudError('header_conflict'))
    h.api.getVault.mockResolvedValue({ vault_id: VAULT, header: HEADER, header_rev: 5 })
    h.vault.headerMatchesDek.mockResolvedValue(false)
    const result = await h.engine.runCycle()

    expect(result.status).toBe('vault-mismatch')
    expect(h.engine.getState().status).toBe('vault-mismatch')
    expect(h.api.updateVaultHeader).toHaveBeenCalledTimes(1)
    expect(h.api.pullRecords).not.toHaveBeenCalled()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })

  it('a second header_conflict is an error and the header stays pending', async () => {
    const h = createHarness({ meta: { headerPending: true, headerRev: 1 } })
    h.api.updateVaultHeader.mockRejectedValue(new CloudError('header_conflict'))
    h.api.getVault.mockResolvedValue({ vault_id: VAULT, header: HEADER, header_rev: 5 })
    const result = await h.engine.runCycle()

    expect(h.api.updateVaultHeader).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('error')
    expect(h.engine.getState().errorCode).toBe('header_conflict')
    expect(h.metaValue().headerPending).toBe(true)
  })

  it('adopts a newer cloud header that wraps the same DEK and tells the UI', async () => {
    const h = createHarness({ meta: { headerRev: 1 } })
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({
        vault: { vault_id: VAULT, header_rev: 4, record_count: 0, total_bytes: 0, last_seq: 10 },
      }),
    )
    h.api.getVault.mockResolvedValue({ vault_id: VAULT, header: HEADER, header_rev: 4 })
    h.vault.adoptHeaderIfSameDek.mockResolvedValue('adopted')
    await h.engine.runCycle()

    expect(h.vault.adoptHeaderIfSameDek).toHaveBeenCalledWith(HEADER)
    expect(h.events.some((e) => e.type === 'header-adopted')).toBe(true)
    expect(h.metaValue().headerRev).toBe(4)
  })

  it('a newer cloud header of another DEK is vault-mismatch and nothing moves', async () => {
    const h = createHarness({ meta: { headerRev: 1 } })
    h.api.getSyncStatus.mockResolvedValue(
      syncStatus({
        vault: { vault_id: VAULT, header_rev: 4, record_count: 0, total_bytes: 0, last_seq: 10 },
      }),
    )
    h.api.getVault.mockResolvedValue({ vault_id: VAULT, header: HEADER, header_rev: 4 })
    h.vault.adoptHeaderIfSameDek.mockResolvedValue('mismatch')
    const result = await h.engine.runCycle()

    expect(result.status).toBe('vault-mismatch')
    expect(h.events.some((e) => e.type === 'header-adopted')).toBe(false)
    expect(h.metaValue().headerRev).toBe(1)
    expect(h.api.pullRecords).not.toHaveBeenCalled()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })

  it('does not fetch the cloud header when the rev did not move', async () => {
    const h = createHarness({ meta: { headerRev: 1 } })
    await h.engine.runCycle()
    expect(h.api.getVault).not.toHaveBeenCalled()
    expect(h.vault.adoptHeaderIfSameDek).not.toHaveBeenCalled()
  })
})

describe('locking, cross-tab and re-entry', () => {
  it('skips the cycle when another tab holds the lock, with no call', async () => {
    const h = createHarness()
    h.locks.held = true
    const result = await h.engine.runCycle()

    expect(result.ran).toBe(false)
    expect(h.locks.requested).toEqual([SYNC_LOCK_NAME])
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
  })

  it('runs again once the lock is free', async () => {
    const h = createHarness()
    h.locks.held = true
    await h.engine.runCycle()
    h.locks.held = false
    const result = await h.engine.runCycle()
    expect(result.ran).toBe(true)
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('a second runCycle during a cycle in this tab does not start a parallel cycle', async () => {
    const h = createHarness()
    let release!: () => void
    h.api.getSyncStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(syncStatus())
        }),
    )
    const first = h.engine.runCycle()
    await flush()
    const second = await h.engine.runCycle()

    expect(second.ran).toBe(false)
    release()
    expect((await first).ran).toBe(true)
  })

  it('stops at the next checkpoint when the vault is locked mid-cycle: nothing is pushed', async () => {
    const h = createHarness()
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 9, records: [record('x')] })
    h.api.pullRecords.mockImplementationOnce(() => {
      h.state.unlocked = false
      return Promise.resolve(page([], false))
    })
    await h.engine.runCycle()

    expect(h.api.pushRecords).not.toHaveBeenCalled()
    expect(h.metaValue().pushedRev).toBe(2)
    expect(h.engine.getState().progress).toBeNull()
  })

  it('does not push anything when the vault is locked before the push', async () => {
    const h = createHarness()
    h.local.listChangedRecords.mockImplementation(() => {
      h.state.unlocked = false
      return Promise.resolve({ maxRev: 9, records: [record('x')] })
    })
    await h.engine.runCycle()
    expect(h.api.pushRecords).not.toHaveBeenCalled()
  })

  it('never rejects, even when a port throws', async () => {
    const h = createHarness()
    h.meta.read.mockRejectedValueOnce(new Error('boom'))
    const result = await h.engine.runCycle()
    expect(result.status).toBe('error')
    expect(h.engine.getState().errorCode).toBe('unexpected')
  })
})

describe('errors', () => {
  it('device_removed from the server', async () => {
    const h = createHarness()
    h.api.pullRecords.mockRejectedValue(new CloudError('device_removed'))
    const result = await h.engine.runCycle()

    expect(result.status).toBe('device-removed')
    expect(h.engine.getState().status).toBe('device-removed')
    expect(h.meta.update.mock.calls.some((c) => 'lastError' in (c[0] as object))).toBe(false)
  })

  it('device_not_registered is cloud-deleted', async () => {
    const h = createHarness()
    h.api.pullRecords.mockRejectedValue(new CloudError('device_not_registered'))
    expect((await h.engine.runCycle()).status).toBe('cloud-deleted')
  })

  it('sync_not_included from a call is paused', async () => {
    const h = createHarness()
    h.api.pushRecords.mockRejectedValue(new CloudError('sync_not_included'))
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 9, records: [record('x')] })
    expect((await h.engine.runCycle()).status).toBe('paused')
  })

  it('a non-retryable error is saved as lastError and schedules no retry', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.pushRecords.mockRejectedValue(new CloudError('quota_exceeded'))
    h.local.listChangedRecords.mockResolvedValue({ maxRev: 9, records: [record('x')] })
    const before = h.timers.set.length
    await h.engine.runCycle()

    expect(h.engine.getState()).toMatchObject({ status: 'error', errorCode: 'quota_exceeded' })
    expect(h.metaValue().lastError).toMatchObject({ code: 'quota_exceeded' })
    expect(h.timers.set.slice(before)).not.toContain(SYNC_BACKOFF_BASE_MS)
    h.engine.stop()
  })

  it('network errors back off 5 s, 10 s, then reset after a success', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockRejectedValue(new CloudError('network'))
    const before = h.timers.set.length
    await h.engine.runCycle()
    await h.engine.runCycle()
    expect(h.timers.set.slice(before)).toEqual(expect.arrayContaining([5000, 10_000]))

    h.api.getSyncStatus.mockResolvedValue(syncStatus())
    await h.engine.runCycle()
    h.api.getSyncStatus.mockRejectedValue(new CloudError('network'))
    const afterSuccess = h.timers.set.length
    await h.engine.runCycle()
    expect(h.timers.set.slice(afterSuccess)).toContain(5000)
    expect(h.timers.set.slice(afterSuccess)).not.toContain(20_000)
    h.engine.stop()
  })

  it('the retry timer runs a cycle', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockRejectedValueOnce(new CloudError('network'))
    await h.engine.runCycle()
    const calls = h.api.getSyncStatus.mock.calls.length
    await h.timers.advance(5000)
    expect(h.api.getSyncStatus.mock.calls.length).toBeGreaterThan(calls)
    h.engine.stop()
  })
})

describe('triggers', () => {
  it('start() runs one unlock cycle immediately and is idempotent', async () => {
    const h = createHarness()
    h.engine.start()
    h.engine.start()
    await flush()

    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    expect(h.local.onLocalChange).toHaveBeenCalledTimes(1)
    h.engine.stop()
  })

  it('five quick local changes give one cycle after the debounce', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockClear()

    for (let i = 0; i < 5; i++) {
      h.localChange()
      await h.timers.advance(500)
    }
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
    // The last change was 500 ms ago (virtual time 2500, debounce fires at 4000).
    await h.timers.advance(SYNC_DEBOUNCE_MS - 500 - 1)
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
    await h.timers.advance(1)
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    h.engine.stop()
  })

  it('a single change waits the full debounce', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockClear()
    h.localChange()
    await h.timers.advance(1999)
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
    await h.timers.advance(1)
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    h.engine.stop()
  })

  it('the online event runs a cycle', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockClear()
    h.env.fire('window', 'online')
    await flush()
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    h.engine.stop()
  })

  it('visibilitychange runs a cycle only when the tab is visible', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockClear()

    h.state.visible = false
    h.env.fire('document', 'visibilitychange')
    await flush()
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()

    h.state.visible = true
    h.env.fire('document', 'visibilitychange')
    await flush()
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    h.engine.stop()
  })

  it('runs every 60 s while visible and not while hidden', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.api.getSyncStatus.mockClear()

    await h.timers.advance(SYNC_INTERVAL_MS)
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    h.state.visible = false
    await h.timers.advance(SYNC_INTERVAL_MS)
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    h.state.visible = true
    await h.timers.advance(SYNC_INTERVAL_MS)
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(2)
    h.engine.stop()
  })

  it('requestCycle("manual") runs now, without a debounce', async () => {
    const h = createHarness()
    h.engine.requestCycle('manual')
    await flush()
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('offline: no calls, and the online event brings the sync back', async () => {
    const h = createHarness()
    h.state.online = false
    h.engine.start()
    await flush()
    expect(h.engine.getState().status).toBe('offline')
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()

    h.state.online = true
    h.env.fire('window', 'online')
    await flush()
    expect(h.api.getSyncStatus).toHaveBeenCalledTimes(1)
    expect(h.engine.getState().status).toBe('synced')
    h.engine.stop()
  })

  it('stop() removes listeners and timers and is idempotent', async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.localChange()
    expect(h.timers.pending().length).toBeGreaterThan(0)
    h.engine.stop()
    h.engine.stop()

    expect(h.env.count()).toBe(0)
    expect(h.timers.pending()).toEqual([])
    h.api.getSyncStatus.mockClear()
    await h.timers.advance(10 * SYNC_INTERVAL_MS)
    h.env.fire('window', 'online')
    h.localChange()
    await flush()
    expect(h.api.getSyncStatus).not.toHaveBeenCalled()
  })
})

describe('state store', () => {
  it('getState returns the same object until the state changes', async () => {
    const h = createHarness({ meta: { enabled: false } })
    const a = h.engine.getState()
    expect(h.engine.getState()).toBe(a)
    await h.engine.runCycle()
    expect(h.engine.getState()).toBe(h.engine.getState())
  })

  it('notifies subscribers on change and stops after unsubscribe', async () => {
    const h = createHarness()
    const listener = vi.fn()
    const off = h.engine.subscribe(listener)
    await h.engine.runCycle()
    expect(listener).toHaveBeenCalled()

    const calls = listener.mock.calls.length
    off()
    await h.engine.runCycle()
    h.state.online = false
    await h.engine.runCycle()
    expect(listener.mock.calls.length).toBe(calls)
  })

  it('emits a state event for every change', async () => {
    const h = createHarness()
    await h.engine.runCycle()
    const statuses = h.events.filter((e) => e.type === 'state').map((e) => (e as { state: SyncState }).state.status)
    expect(statuses).toContain('syncing')
    expect(statuses.at(-1)).toBe('synced')
  })

  it('refreshFromMeta is off when sync is off', async () => {
    const h = createHarness({ meta: { enabled: false } })
    expect((await h.engine.refreshFromMeta()).status).toBe('off')
  })

  it('refreshFromMeta reads lastSyncAt, deviceId and lastError from meta', async () => {
    const h = createHarness({
      meta: {
        lastSyncAt: '2026-10-23T09:00:00.000Z',
        lastError: { code: 'undecryptable', count: 2, at: '2026-10-23T09:00:00.000Z' },
      },
    })
    const state = await h.engine.refreshFromMeta()
    expect(state.status).toBe('synced')
    expect(state.lastSyncAt).toBe('2026-10-23T09:00:00.000Z')
    expect(state.deviceId).toBe(DEVICE)
    expect(state.lastError?.count).toBe(2)
  })

  it('refreshFromMeta is syncing when it never synced', async () => {
    const h = createHarness()
    expect((await h.engine.refreshFromMeta()).status).toBe('syncing')
  })

  it('refreshFromMeta keeps a problem status', async () => {
    const h = createHarness()
    h.api.getSyncStatus.mockResolvedValue(syncStatus({ vault: null }))
    await h.engine.runCycle()
    expect(h.engine.getState().status).toBe('cloud-deleted')
    expect((await h.engine.refreshFromMeta()).status).toBe('cloud-deleted')
  })
})
