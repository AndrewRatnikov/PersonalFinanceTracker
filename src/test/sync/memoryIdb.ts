// Test helper (no CONTRACT_GAPs): an in-memory stand-in for `idb-keyval` used by
// the multi-device sync tests (plan section 12). Each multi-device test file
// installs it with
//
//   vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
//
// `createStore()` returns a NEW handle on every call and every handle owns its
// own Map, so two simulated devices (each with a fresh module registry, see
// simDevice.ts) never share data. The state lives on the handle itself, so the
// controls below work with a handle created in any module registry. Values are
// cloned on the way in and out like IndexedDB does. A store can be told to
// reject its next `setMany` calls (`failNextSetMany`), which behaves like an
// aborted transaction: nothing of that call is written.

import type { UseStore } from 'idb-keyval'

export interface MemoryStoreState {
  data: Map<string, unknown>
  /** How many of the next setMany calls reject without writing anything. */
  failSetMany: number
  /** The keys of every setMany call, in call order (also the failed ones). */
  setManyCalls: Array<Array<string>>
}

const STATE = Symbol.for('minima.test.memoryIdb.state')

function newHandle(): UseStore {
  const handle = (() => {
    throw new Error('memoryIdb: the store handle is not a real IndexedDB store')
  }) as unknown as Record<symbol, MemoryStoreState>
  handle[STATE] = { data: new Map(), failSetMany: 0, setManyCalls: [] }
  return handle as unknown as UseStore
}

const defaultHandle = newHandle()

function stateOf(store?: UseStore | null): MemoryStoreState {
  const found = (store ?? defaultHandle) as unknown as Record<
    symbol,
    MemoryStoreState | undefined
  >
  const state = found[STATE]
  if (!state) throw new Error('memoryIdb: unknown store handle')
  return state
}

// Realm-safe deep clone: under jsdom `structuredClone` returns typed arrays from
// another realm (so `instanceof Uint8Array` fails), so binary data is rebuilt
// with this realm's constructors.
function clone<T>(value: T): T {
  return cloneAny(value) as T
}

function cloneAny(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value
    return new Uint8Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    )
  }
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (value instanceof Date) return new Date(value.getTime())
  if (Array.isArray(value)) return value.map(cloneAny)
  if (value instanceof Map) {
    return new Map(
      Array.from(value.entries()).map(([k, v]) => [cloneAny(k), cloneAny(v)]),
    )
  }
  if (value instanceof Set) return new Set(Array.from(value).map(cloneAny))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneAny(v)
  }
  return out
}

export function createStore(_dbName?: string, _storeName?: string): UseStore {
  return newHandle()
}

export function get<T = unknown>(
  key: string,
  store?: UseStore,
): Promise<T | undefined> {
  const { data } = stateOf(store)
  return Promise.resolve(data.has(key) ? clone(data.get(key) as T) : undefined)
}

export function getMany<T = unknown>(
  keyList: Array<string>,
  store?: UseStore,
): Promise<Array<T | undefined>> {
  const { data } = stateOf(store)
  return Promise.resolve(
    keyList.map((k) => (data.has(k) ? clone(data.get(k) as T) : undefined)),
  )
}

export function set(key: string, value: unknown, store?: UseStore): Promise<void> {
  stateOf(store).data.set(key, clone(value))
  return Promise.resolve()
}

// All entries or none, like an IndexedDB transaction.
export function setMany(
  pairs: Array<[string, unknown]>,
  store?: UseStore,
): Promise<void> {
  const state = stateOf(store)
  state.setManyCalls.push(pairs.map(([k]) => k))
  if (state.failSetMany > 0) {
    state.failSetMany--
    return Promise.reject(new Error('transaction aborted'))
  }
  for (const [k, v] of pairs) state.data.set(k, clone(v))
  return Promise.resolve()
}

export function del(key: string, store?: UseStore): Promise<void> {
  stateOf(store).data.delete(key)
  return Promise.resolve()
}

export function delMany(keyList: Array<string>, store?: UseStore): Promise<void> {
  const { data } = stateOf(store)
  for (const k of keyList) data.delete(k)
  return Promise.resolve()
}

export function clear(store?: UseStore): Promise<void> {
  stateOf(store).data.clear()
  return Promise.resolve()
}

export function keys(store?: UseStore): Promise<Array<string>> {
  return Promise.resolve(Array.from(stateOf(store).data.keys()))
}

export function values<T = unknown>(store?: UseStore): Promise<Array<T>> {
  return Promise.resolve(
    Array.from(stateOf(store).data.values()).map((v) => clone(v as T)),
  )
}

export function entries<T = unknown>(
  store?: UseStore,
): Promise<Array<[string, T]>> {
  return Promise.resolve(
    Array.from(stateOf(store).data.entries()).map(
      ([k, v]) => [k, clone(v as T)] as [string, T],
    ),
  )
}

// ── Controls for tests (they take the handle, so they work in any registry) ───

export function storeState(store: UseStore | null): MemoryStoreState {
  if (!store) throw new Error('memoryIdb: no store')
  return stateOf(store)
}

export function failNextSetMany(store: UseStore | null, count = 1): void {
  storeState(store).failSetMany = count
}
