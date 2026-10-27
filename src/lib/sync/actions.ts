// The user actions of sync (docs/free-tier-spec.md §19): turning sync on and
// off, linking a second device (fresh restore, "Join and keep", "Replace cloud
// data"), Delete cloud data, devices and local header changes. Like the engine
// they get the api, the engine and the ports injected; nothing happens at
// import time.
//
// The gate: every action that moves data or keys first asks the server for a
// fresh status and checks hasFeature(status, 'sync'). Deleting cloud data,
// listing / renaming / removing devices and turning sync off are never gated:
// a user must always be able to manage and delete their own data.

import { isSyncOn } from './syncMeta'
import type { CloudDevice, CloudVault } from '@/lib/cloud/types'
import type { CloudVaultSecret, VaultHeaderV2 } from '@/lib/vault'
import type {
  SyncActions,
  SyncActionsDeps,
  SyncCycleResult,
  SyncFields,
  SyncPorts,
  TurnOnResult,
} from './types'
import { hasFeature } from '@/lib/cloud/entitlements'
import { CloudError } from '@/lib/cloud/api'

export type SyncActionErrorCode =
  | 'sync_not_included'
  | 'not_signed_in'
  | 'locked'
  | 'confirmation_required'
  | 'not_fresh'

export class SyncActionError extends Error {
  readonly code: SyncActionErrorCode

  constructor(code: SyncActionErrorCode, message: string = code) {
    super(message)
    this.name = 'SyncActionError'
    this.code = code
  }
}

/** What "Replace cloud data with this device" needs typed. */
export const REPLACE_CONFIRMATION = 'DELETE'

function isDeviceRemoved(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'CloudError' &&
    (err as { code?: unknown }).code === 'device_removed'
  )
}

// Forwards every local header change (password, recovery key) to the actions.
export function connectHeaderChanges(
  ports: SyncPorts,
  actions: SyncActions,
): () => void {
  return ports.vault.onHeaderChange(() => {
    actions.handleLocalHeaderChange().catch((err: unknown) => {
      console.error(
        'Could not mark the header change:',
        err instanceof Error ? err.name : typeof err,
      )
    })
  })
}

export function createSyncActions(deps: SyncActionsDeps): SyncActions {
  const { api, engine, ports, deviceIds, getUserId } = deps

  // The gate: signed in, then a fresh server status that includes sync.
  async function requireSync(): Promise<string> {
    const userId = getUserId()
    if (userId === null) throw new SyncActionError('not_signed_in')
    const status = await api.getSyncStatus()
    if (!hasFeature(status, 'sync')) throw new SyncActionError('sync_not_included')
    return userId
  }

  // Registers this device; a device removed from another device gets a new id.
  async function registerThisDevice(): Promise<string> {
    let deviceId = deviceIds.get()
    try {
      await api.registerDevice(deviceId, deviceIds.defaultLabel())
    } catch (err) {
      if (!isDeviceRemoved(err)) throw err
      deviceId = deviceIds.reset()
      await api.registerDevice(deviceId, deviceIds.defaultLabel())
    }
    return deviceId
  }

  function freshFields(
    userId: string,
    vaultId: string,
    deviceId: string,
    headerRev: number,
    headerPending = false,
  ): SyncFields {
    return {
      enabled: true,
      userId,
      vaultId,
      deviceId,
      pushedRev: -1,
      pullCursor: 0,
      headerRev,
      lastSyncAt: null,
      lastError: null,
      headerPending,
    }
  }

  async function turnOn(): Promise<TurnOnResult> {
    if (!ports.local.isUnlocked()) throw new SyncActionError('locked')
    const userId = await requireSync()
    const deviceId = await registerThisDevice()
    const cloud = await api.getVault()
    const header: VaultHeaderV2 = await ports.vault.getVaultHeader()

    if (cloud === null) {
      // This device becomes the source: the full snapshot (pushedRev -1).
      const ref = await api.createVault(deviceId, header.vaultId, header)
      await ports.meta.update(freshFields(userId, header.vaultId, deviceId, ref.header_rev))
      const result = await engine.runCycle({ reason: 'turn-on' })
      return { kind: 'created', pushed: result.pushed }
    }
    if (cloud.vault_id === header.vaultId) {
      if ((await ports.vault.adoptHeaderIfSameDek(cloud.header)) === 'mismatch') {
        throw new CloudError('vault_mismatch')
      }
      await ports.meta.update(freshFields(userId, header.vaultId, deviceId, cloud.header_rev))
      await engine.runCycle({ reason: 'turn-on' })
      return { kind: 'linked' }
    }
    // This device holds separate data: the link dialog decides.
    return { kind: 'needs-link', cloud }
  }

  async function restoreFromCloud(
    cloud: CloudVault,
    secret: CloudVaultSecret,
  ): Promise<SyncCycleResult> {
    if ((await ports.vault.getVaultState()) !== 'none') {
      throw new SyncActionError('not_fresh')
    }
    const userId = await requireSync()
    // Nothing is written before the secret is verified.
    const { headerChanged } = await ports.vault.adoptCloudVault(cloud.header, secret)
    const deviceId = await registerThisDevice()
    await ports.meta.update(
      freshFields(userId, cloud.vault_id, deviceId, cloud.header_rev, headerChanged),
    )
    return engine.runCycle({ reason: 'restore' })
  }

  return {
    turnOn,
    uploadAgain: turnOn,

    async joinAndKeep(cloud, password) {
      const userId = await requireSync()
      const deviceId = deviceIds.get()
      // No pushedRev: rekeyLiveData writes the rev before the re-stamp, so
      // every re-inserted record is pushed after the pull.
      await ports.vault.joinCloudVault(cloud.header, password, {
        enabled: true,
        userId,
        vaultId: cloud.vault_id,
        deviceId,
        pullCursor: 0,
        headerRev: cloud.header_rev,
        lastSyncAt: null,
        lastError: null,
        headerPending: false,
      })
      return engine.runCycle({ reason: 'turn-on' })
    },

    async replaceCloud(confirmation) {
      if (confirmation !== REPLACE_CONFIRMATION) {
        throw new SyncActionError('confirmation_required')
      }
      const userId = await requireSync()
      await api.deleteCloudData()
      // Deleting the cloud data also removed the device rows.
      const deviceId = await registerThisDevice()
      const header = await ports.vault.getVaultHeader()
      const ref = await api.createVault(deviceId, header.vaultId, header)
      await ports.meta.update(freshFields(userId, header.vaultId, deviceId, ref.header_rev))
      return engine.runCycle({ reason: 'turn-on' })
    },

    async turnOff({ removeDevice }) {
      const meta = await ports.meta.read()
      await ports.meta.clear()
      await engine.refreshFromMeta()
      // Sync is already off here, so a failure only means the row stays.
      if (removeDevice && getUserId() !== null) {
        await api.removeDevice(meta.deviceId ?? deviceIds.get())
      }
    },

    async fetchCloudVault() {
      await requireSync()
      return api.getVault()
    },

    restoreFromCloud,

    async deleteCloudData(password) {
      await ports.vault.verifyPassword(password)
      await api.deleteCloudData()
      await ports.meta.clear()
      await engine.refreshFromMeta()
    },

    syncNow() {
      return engine.runCycle({ reason: 'manual' })
    },

    listDevices(): Promise<Array<CloudDevice>> {
      return api.listDevices()
    },

    renameDevice(deviceId, label) {
      return api.renameDevice(deviceId, label)
    },

    removeDevice(deviceId) {
      return api.removeDevice(deviceId)
    },

    async handleLocalHeaderChange() {
      const meta = await ports.meta.read()
      if (!isSyncOn(meta)) return
      await ports.meta.update({ headerPending: true })
      engine.requestCycle('header')
    },
  }
}
