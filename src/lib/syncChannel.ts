import type { QueryClient } from '@tanstack/react-query'

// Multi-tab consistency: after each committed write, localDb announces the
// storage keys it wrote on BroadcastChannel('minima'). Other tabs map those
// keys to React Query keys and invalidate them. Without BroadcastChannel
// everything here is a no-op.
//
// The same channel also carries `lock` (another tab locked the vault) and
// `wiped` (another tab removed all local data); see vaultSession.ts.

export const SYNC_CHANNEL_NAME = 'minima'

// `keys?: never` on lock / wiped lets callers read `message.keys` on any
// message (undefined unless it is `changed`).
export type SyncMessage =
  | { type: 'changed'; keys: Array<string> }
  | { type: 'lock'; keys?: never }
  | { type: 'wiped'; keys?: never }

export interface SyncChannel {
  postMessage: (message: SyncMessage) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent) => void,
  ) => void
  removeEventListener: (
    type: 'message',
    listener: (event: MessageEvent) => void,
  ) => void
  close: () => void
}

// `undefined` = no override (use the lazy default), `null` = syncing disabled.
let override: SyncChannel | null | undefined = undefined
let defaultChannel: SyncChannel | null | undefined = undefined

function createDefaultChannel(): SyncChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    const channel = new BroadcastChannel(SYNC_CHANNEL_NAME)
    // Node (vitest) keeps the process alive while a channel is open.
    ;(channel as unknown as { unref?: () => void }).unref?.()
    return channel as unknown as SyncChannel
  } catch {
    return null
  }
}

export function getSyncChannel(): SyncChannel | null {
  if (override !== undefined) return override
  if (defaultChannel === undefined) defaultChannel = createDefaultChannel()
  return defaultChannel
}

// Test injection: a channel replaces the default, null disables syncing,
// undefined restores the lazy default.
export function setSyncChannel(channel: SyncChannel | null | undefined): void {
  override = channel
}

function post(message: SyncMessage): void {
  const channel = getSyncChannel()
  if (!channel) return
  try {
    channel.postMessage(message)
  } catch {
    // A broadcast failure must never fail a write that already committed.
  }
}

export function postChanged(keys: Array<string>): void {
  if (keys.length === 0) return
  post({ type: 'changed', keys })
}

export function postLock(): void {
  post({ type: 'lock' })
}

export function postWiped(): void {
  post({ type: 'wiped' })
}

function queryKeysFor(storageKey: string): Array<Array<string>> {
  if (/^expenses_\d{4}_\d{2}$/.test(storageKey)) {
    return [['expenses'], ['analytics']]
  }
  switch (storageKey) {
    case 'categories':
      return [['categories'], ['expenses'], ['budgets']]
    case 'income':
      return [['income'], ['analytics']]
    case 'budgets':
      return [['budgets'], ['analytics']]
    default:
      return []
  }
}

export function queryKeysForStorageKeys(
  keys: Array<string>,
): Array<Array<string>> {
  const seen = new Set<string>()
  const result: Array<Array<string>> = []
  for (const storageKey of keys) {
    for (const queryKey of queryKeysFor(storageKey)) {
      const id = JSON.stringify(queryKey)
      if (seen.has(id)) continue
      seen.add(id)
      result.push(queryKey)
    }
  }
  return result
}

function messageType(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return undefined
  return (data as { type?: unknown }).type
}

function isChangedMessage(
  data: unknown,
): data is Extract<SyncMessage, { type: 'changed' }> {
  if (messageType(data) !== 'changed') return false
  const keys = (data as { keys?: unknown }).keys
  return Array.isArray(keys) && keys.every((k) => typeof k === 'string')
}

export function listenForChanges(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  channel: SyncChannel | null = getSyncChannel(),
): () => void {
  if (!channel) return () => {}
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data
    if (!isChangedMessage(data)) return
    for (const queryKey of queryKeysForStorageKeys(data.keys)) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
  channel.addEventListener('message', listener)
  return () => {
    channel.removeEventListener('message', listener)
  }
}

export function listenForLockAndWipe(
  handlers: { onLock: () => void; onWiped: () => void },
  channel: SyncChannel | null = getSyncChannel(),
): () => void {
  if (!channel) return () => {}
  const listener = (event: MessageEvent) => {
    const type = messageType(event.data)
    if (type === 'lock') handlers.onLock()
    else if (type === 'wiped') handlers.onWiped()
  }
  channel.addEventListener('message', listener)
  return () => {
    channel.removeEventListener('message', listener)
  }
}
