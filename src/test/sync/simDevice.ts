// Test helper (no CONTRACT_GAPs): one simulated device for the multi-device sync
// tests (plan section 12, decision D9).
//
// A device is a fresh module registry: `vi.resetModules()` followed by DYNAMIC
// imports of localDb, vault, syncMeta, ports, engine, actions and backup, so
// every device owns its own in-memory IndexedDB (the test file installs
// `vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))`), its own DEK,
// brute-force counters, write locks and engine. Everything the registry cannot
// separate is injected: the device id (jsdom's localStorage is shared), the
// signed-in user, online state, the cross-tab lock, the timers and the
// window/document events.
//
// The api is built from the device's own `@/lib/cloud/api` module over the
// PGlite `rpc` of the test (real run 2 SQL functions and permission checks), so
// every CloudError the engine sees is an instance of the class it checks for.

import { vi } from 'vitest'
import type { UseStore } from 'idb-keyval'
import type * as BackupModule from '@/lib/backup'
import type * as ConversionModule from '@/lib/conversion'
import type * as LocalDbModule from '@/lib/localDb'
import type * as VaultModule from '@/lib/vault'
import type * as SyncMetaModule from '@/lib/sync/syncMeta'
import type { CloudApi, RpcFn, RpcResponse } from '@/lib/cloud/api'
import type { CloudVault } from '@/lib/cloud/types'
import type {
  DeviceIdPort,
  SyncActions,
  SyncClock,
  SyncEngine,
  SyncEngineEvent,
  SyncEnv,
  SyncLockManager,
  SyncPorts,
} from '@/lib/sync/types'

export interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

export interface SimClock extends SyncClock {
  /** Runs every timer due within `ms` virtual milliseconds, in order. */
  advance: (ms: number) => Promise<void>
  /** Delays (ms from now) of the timers that are still waiting. */
  pending: () => Array<number>
}

export interface SimLocks extends SyncLockManager {
  /** While true another "tab" holds the lock: callbacks get null. */
  held: boolean
  requested: Array<string>
}

export interface SimEnv extends SyncEnv {
  visible: boolean
  fire: (target: 'window' | 'document', type: string) => void
  listenerCount: () => number
}

export interface SimDeviceOptions {
  name: string
  /** The PGlite rpc of the signed-in user (ctx.rpcAs(userId)). */
  rpc: RpcFn
  userId: string | null
  deviceId?: string
  label?: string
}

export interface DeviceSnapshot {
  expenses: Array<Record<string, unknown>>
  income: Array<Record<string, unknown>>
  categories: Array<Record<string, unknown>>
  incomeCategories: Array<Record<string, unknown>>
  budgets: Array<Record<string, unknown>>
  recurring: Array<Record<string, unknown>>
  settings: Record<string, unknown>
}

export interface SimDevice {
  name: string
  localDb: typeof LocalDbModule
  vault: typeof VaultModule
  syncMeta: typeof SyncMetaModule
  backup: typeof BackupModule
  conversion: typeof ConversionModule
  api: CloudApi
  ports: SyncPorts
  engine: SyncEngine
  actions: SyncActions
  deviceIds: DeviceIdPort & { id: () => string; resets: () => number }
  clock: SimClock
  locks: SimLocks
  env: SimEnv
  events: Array<SyncEngineEvent>
  calls: Array<RpcCall>
  /** Called before every rpc; return a response to short-circuit the call. */
  intercept: ((call: RpcCall) => RpcResponse | undefined | Promise<RpcResponse | undefined>) | null
  state: { userId: string | null; online: boolean }
  store: () => UseStore | null
  count: (fn: string) => number
  createAndUnlockVault: (password: string) => Promise<string>
  snapshot: () => Promise<DeviceSnapshot>
  dispose: () => void
}

const IGNORED_FIELDS = new Set([
  'rev',
  'conversion',
  'manualRate',
  'category',
  'incomeCategory',
])

function plain(list: ReadonlyArray<object>): Array<Record<string, unknown>> {
  return list
    .map((item) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(item)) {
        if (!IGNORED_FIELDS.has(k)) out[k] = v
      }
      return out
    })
    .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
}

function createClock(): SimClock {
  let virtual = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: virtual + ms, fn })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    yieldToUi: () => Promise.resolve(),
    async advance(ms) {
      const target = virtual + ms
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
          .shift()
        if (!due) break
        timers.delete(due[0])
        virtual = Math.max(virtual, due[1].at)
        due[1].fn()
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      virtual = target
    },
    pending: () => Array.from(timers.values()).map((t) => t.at - virtual),
  }
}

function createLocks(): SimLocks {
  const locks: SimLocks = {
    held: false,
    requested: [],
    request<T>(
      name: string,
      _options: { ifAvailable: true },
      callback: (lock: unknown) => Promise<T>,
    ): Promise<T> {
      locks.requested.push(name)
      return callback(locks.held ? null : { name })
    },
  }
  return locks
}

function createEnv(): SimEnv {
  const listeners = new Map<string, Set<() => void>>()
  const env: SimEnv = {
    visible: true,
    listen(target, type, listener) {
      const key = `${target}:${type}`
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
      }
    },
    isVisible: () => env.visible,
    fire(target, type) {
      for (const l of Array.from(listeners.get(`${target}:${type}`) ?? [])) l()
    },
    listenerCount: () =>
      Array.from(listeners.values()).reduce((n, s) => n + s.size, 0),
  }
  return env
}

// Strings that must never appear on the server in the clear.
export const PLAINTEXT_MARKERS = [
  'Marker lunch special',
  'Marker salary March',
  'Marker Groceries',
  'Marker Paycheck',
  'Marker rent monthly',
]

export interface SeedResult {
  categoryId: string
  incomeCategoryId: string
  expenseIds: Array<string>
  deletedExpenseId: string
  incomeId: string
  recurringId: string
}

// A small but complete data set: every record type, one tombstone and a
// synced-settings change. Amounts are distinctive (123457 etc.).
export async function seedSampleData(device: SimDevice): Promise<SeedResult> {
  const db = device.localDb
  const category = await db.addCategory({ name: 'Marker Groceries' })
  const incomeCategory = await db.addIncomeCategory({ name: 'Marker Paycheck' })
  const e1 = await db.addExpense({
    amount: 123457,
    currency: 'UAH',
    categoryId: category.id,
    description: 'Marker lunch special',
    createdAt: '2026-10-05T10:00:00.000Z',
  })
  const e2 = await db.addExpense({
    amount: 98765,
    currency: 'UAH',
    categoryId: category.id,
    description: 'Marker lunch special',
    createdAt: '2026-09-12T10:00:00.000Z',
  })
  const gone = await db.addExpense({
    amount: 777,
    currency: 'UAH',
    categoryId: category.id,
    description: 'removed again',
    createdAt: '2026-10-06T10:00:00.000Z',
  })
  await db.deleteExpense(gone.id, gone.createdAt)
  const income = await db.addIncome({
    categoryId: incomeCategory.id,
    amount: 5550000,
    currency: 'UAH',
    description: 'Marker salary March',
    createdAt: '2026-10-01T08:00:00.000Z',
  })
  await db.upsertBudget({ categoryId: category.id, monthlyLimit: 424242, currency: 'UAH' })
  const recurring = await db.addRecurring(
    {
      kind: 'expense',
      amount: 313131,
      currency: 'UAH',
      categoryId: category.id,
      description: 'Marker rent monthly',
      frequency: { unit: 'month', interval: 1 },
      startDate: '2026-12-01',
      end: { type: 'never' },
      mode: 'ask',
    },
    { createThroughToday: false, today: '2026-10-24' },
  )
  await db.updateSyncedSettings({ fetchExchangeRates: false })
  return {
    categoryId: category.id,
    incomeCategoryId: incomeCategory.id,
    expenseIds: [e1.id, e2.id],
    deletedExpenseId: gone.id,
    incomeId: income.id,
    recurringId: recurring.id,
  }
}

// The device's cloud vault, failing loudly when there is none (fetchCloudVault
// returns CloudVault | null; restoreFromCloud needs a CloudVault).
export async function cloudVaultOf(d: SimDevice): Promise<CloudVault> {
  const c = await d.actions.fetchCloudVault()
  if (!c) throw new Error('no cloud vault')
  return c
}

export interface SyncedPair {
  userId: string
  rpc: RpcFn
  a: SimDevice
  b: SimDevice
  seed: SeedResult | null
  /** The recovery key of the vault device A created. */
  recoveryKey: string
}

// Device A creates a vault (and optionally the sample data) and turns sync on;
// device B restores from the cloud with the same password. Both end up synced.
export async function createSyncedPair(
  ctx: { createUser: () => Promise<string>; rpcAs: (userId: string | null) => RpcFn },
  password: string,
  withData = true,
): Promise<SyncedPair> {
  const userId = await ctx.createUser()
  const rpc = ctx.rpcAs(userId)
  const a = await createSimDevice({ name: 'A', rpc, userId })
  const recoveryKey = await a.createAndUnlockVault(password)
  const seed = withData ? await seedSampleData(a) : null
  await a.actions.turnOn()
  const b = await createSimDevice({ name: 'B', rpc, userId })
  const cloud = await cloudVaultOf(b)
  await b.actions.restoreFromCloud(cloud, { password })
  return { userId, rpc, a, b, seed, recoveryKey }
}

export async function createSimDevice(
  options: SimDeviceOptions,
): Promise<SimDevice> {
  vi.resetModules()
  const localDb = await import('@/lib/localDb')
  const vault = await import('@/lib/vault')
  const syncMeta = await import('@/lib/sync/syncMeta')
  const backup = await import('@/lib/backup')
  const conversion = await import('@/lib/conversion')
  const cloudApi = await import('@/lib/cloud/api')
  const channel = await import('@/lib/syncChannel')
  const { createSyncPorts } = await import('@/lib/sync/ports')
  const { createSyncEngine } = await import('@/lib/sync/engine')
  const { createSyncActions, connectHeaderChanges } = await import(
    '@/lib/sync/actions'
  )

  // No cross-device BroadcastChannel traffic between simulated devices.
  channel.setSyncChannel(null)

  const calls: Array<RpcCall> = []
  const device: { intercept: SimDevice['intercept'] } = { intercept: null }
  const rpc: RpcFn = async (fn, args = {}) => {
    const call = { fn, args }
    calls.push(call)
    if (device.intercept) {
      const early = await device.intercept(call)
      if (early) return early
    }
    return options.rpc(fn, args)
  }
  const api = cloudApi.createCloudApi(rpc)

  const state = { userId: options.userId, online: true }
  let currentId = options.deviceId ?? crypto.randomUUID()
  let resets = 0
  const deviceIds: SimDevice['deviceIds'] = {
    get: () => currentId,
    reset: () => {
      resets++
      currentId = crypto.randomUUID()
      return currentId
    },
    defaultLabel: () => options.label ?? options.name,
    id: () => currentId,
    resets: () => resets,
  }

  const ports = createSyncPorts()
  const clock = createClock()
  const locks = createLocks()
  const env = createEnv()
  const getUserId = () => state.userId
  const engine = createSyncEngine({
    api,
    ports,
    getUserId,
    isOnline: () => state.online,
    locks,
    clock,
    env,
  })
  const actions = createSyncActions({ api, engine, ports, deviceIds, getUserId })
  const disconnect = connectHeaderChanges(ports, actions)

  const events: Array<SyncEngineEvent> = []
  const offEvents = engine.onEvent((e) => events.push(e))

  const result: SimDevice = {
    name: options.name,
    localDb,
    vault,
    syncMeta,
    backup,
    conversion,
    api,
    ports,
    engine,
    actions,
    deviceIds,
    clock,
    locks,
    env,
    events,
    calls,
    get intercept() {
      return device.intercept
    },
    set intercept(value) {
      device.intercept = value
    },
    state,
    store: () => localDb.getLocalStore(),
    count: (fn) => calls.filter((c) => c.fn === fn).length,
    async createAndUnlockVault(password) {
      const { recoveryKey } = await vault.createVault(password)
      return recoveryKey
    },
    async snapshot() {
      const settings = await localDb.readSyncedSettings()
      return {
        expenses: plain(await localDb.getAllExpenses()),
        income: plain(await localDb.getAllIncome()),
        categories: plain(await localDb.getAllCategories()),
        incomeCategories: plain(await localDb.getAllIncomeCategories()),
        budgets: plain(await localDb.getAllBudgets()),
        recurring: plain(await localDb.getAllRecurring()),
        settings: plain([settings])[0],
      }
    },
    dispose() {
      engine.stop()
      offEvents()
      disconnect()
    },
  }
  return result
}
