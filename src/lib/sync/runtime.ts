// The production sync runtime: one engine and one action set wired to the real
// cloud api, localDb, vault and meta:sync. Built lazily on the first
// getSyncRuntime() call, which happens only when ENABLE_SYNC is on; importing
// this file does nothing. With ENABLE_SPACES it also builds the Family client,
// the Family stream (run by the engine) and the Family actions; without it no
// Family function can be called.

import { connectHeaderChanges, createSyncActions } from './actions'
import { createSyncEngine } from './engine'
import { createFamilyActions } from './familyActions'
import { createFamilyStream } from './familyStream'
import { createDeviceIdPort, createFamilyPorts, createSyncPorts } from './ports'
import type { RpcFn } from '@/lib/cloud/rpc'
import type {
  FamilyActions,
  FamilyStream,
  SyncActions,
  SyncEngine,
} from './types'
import { createCloudApi } from '@/lib/cloud/api'
import { createSpacesApi } from '@/lib/cloud/spacesApi'
import { ENABLE_SPACES } from '@/lib/featureFlags'
import { t } from '@/i18n/core'
import { createBrowserSupabaseClient } from '@/lib/supabase'

export interface SyncRuntime {
  engine: SyncEngine
  actions: SyncActions
  /** The Family stream; null without ENABLE_SPACES. */
  family: FamilyStream | null
  /** The Family flows; null without ENABLE_SPACES. */
  familyActions: FamilyActions | null
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
  let family: FamilyStream | null = null
  let spaces: ReturnType<typeof createSpacesApi> | null = null
  if (ENABLE_SPACES) {
    // The browser Supabase client, created at call time (never at import).
    const rpc: RpcFn = (fn, args) => createBrowserSupabaseClient().rpc(fn, args)
    spaces = createSpacesApi(rpc)
    family = createFamilyStream({
      spaces,
      ports: createFamilyPorts(),
      getUserId,
      defaultName: () => t('family.defaultName'),
    })
  }
  const engine = createSyncEngine({
    api,
    ports,
    getUserId,
    ...(family ? { family } : {}),
  })
  const actions = createSyncActions({
    api,
    engine,
    ports,
    deviceIds: createDeviceIdPort(),
    getUserId,
  })
  connectHeaderChanges(ports, actions)
  const familyActions =
    family && spaces
      ? createFamilyActions({
          api,
          spaces,
          engine,
          family,
          ports: createFamilyPorts(),
          personalMeta: ports.meta,
          getUserId,
        })
      : null
  void engine.refreshFromMeta()
  runtime = {
    engine,
    actions,
    family,
    familyActions,
    setUserId(next) {
      userId = next
    },
  }
  return runtime
}
