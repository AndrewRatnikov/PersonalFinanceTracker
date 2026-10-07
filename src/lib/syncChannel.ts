import type { QueryClient } from '@tanstack/react-query'

// Multi-tab consistency: after each committed write, localDb announces the
// storage keys it wrote on BroadcastChannel('minima'). Other tabs map those
// keys to React Query keys and invalidate them. Without BroadcastChannel
// everything here is a no-op.

export const SYNC_CHANNEL_NAME = 'minima'

export type SyncMessage = { type: 'changed'; keys: Array<string> }

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

export function postChanged(keys: Array<string>): void {
  if (keys.length === 0) return
  const channel = getSyncChannel()
  if (!channel) return
  try {
    channel.postMessage({ type: 'changed', keys })
  } catch {
    // A broadcast failure must never fail a write that already committed.
  }
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

function isSyncMessage(data: unknown): data is SyncMessage {
  if (typeof data !== 'object' || data === null) return false
  const candidate = data as { type?: unknown; keys?: unknown }
  return (
    candidate.type === 'changed' &&
    Array.isArray(candidate.keys) &&
    candidate.keys.every((k) => typeof k === 'string')
  )
}

export function listenForChanges(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  channel: SyncChannel | null = getSyncChannel(),
): () => void {
  if (!channel) return () => {}
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data
    if (!isSyncMessage(data)) return
    for (const queryKey of queryKeysForStorageKeys(data.keys)) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
  channel.addEventListener('message', listener)
  return () => {
    channel.removeEventListener('message', listener)
  }
}
