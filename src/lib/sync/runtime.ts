// The production sync runtime: one engine and one action set wired to the real
// cloud api, localDb, vault and meta:sync. Built lazily on the first
// getSyncRuntime() call, which happens only when ENABLE_SYNC is on; importing
// this file does nothing.

import { connectHeaderChanges, createSyncActions } from './actions'
import { createSyncEngine } from './engine'
import { createDeviceIdPort, createSyncPorts } from './ports'
import type { SyncActions, SyncEngine } from './types'
import { createCloudApi } from '@/lib/cloud/api'

export interface SyncRuntime {
  engine: SyncEngine
  actions: SyncActions
  /** The signed-in Supabase user (null when signed out). */
  setUserId: (userId: string | null) => void
}

let runtime: SyncRuntime | null = null

export function getSyncRuntime(): SyncRuntime {
  if (runtime) return runtime
  let userId: string | null = null
  const getUserId = () => userId
  const api = createCloudApi()
  const ports = createSyncPorts()
  const engine = createSyncEngine({ api, ports, getUserId })
  const actions = createSyncActions({
    api,
    engine,
    ports,
    deviceIds: createDeviceIdPort(),
    getUserId,
  })
  connectHeaderChanges(ports, actions)
  void engine.refreshFromMeta()
  runtime = {
    engine,
    actions,
    setUserId(next) {
      userId = next
    },
  }
  return runtime
}
