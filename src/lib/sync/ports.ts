// The real ports of the sync engine and actions: localDb, vault, meta:sync and
// the device id. Static imports, but nothing is called at import time (tests
// mock these modules partially). In tests, a fresh module registry
// (vi.resetModules() + a dynamic import of this file) gives a simulated device
// its own localDb / vault / meta:sync instances.

import { clearSyncFields, readSyncMeta, updateSyncMeta } from './syncMeta'
import type { DeviceIdPort, SyncPorts } from './types'
import {
  defaultDeviceLabel,
  getDeviceId,
  resetDeviceId,
} from '@/lib/cloud/deviceId'
import {
  applyIncomingRecords,
  compactTombstones,
  dedupeOccurrences,
  getLocalDbKey,
  listChangedRecords,
  onLocalChange,
} from '@/lib/localDb'
import {
  adoptCloudVault,
  adoptHeaderIfSameDek,
  getSyncKeys,
  getVaultHeader,
  getVaultState,
  headerMatchesDek,
  joinCloudVault,
  subscribeHeaderChanges,
  verifyPassword,
} from '@/lib/vault'

export function createSyncPorts(): SyncPorts {
  return {
    local: {
      isUnlocked: () => getLocalDbKey() !== null,
      listChangedRecords: (sinceRev) => listChangedRecords(sinceRev),
      applyIncomingRecords: (records, options) =>
        applyIncomingRecords(records, options),
      compactTombstones: (olderThan, options) =>
        compactTombstones(olderThan, options),
      dedupeOccurrences: (recurringIds) => dedupeOccurrences(recurringIds),
      onLocalChange: (listener) => onLocalChange(listener),
    },
    vault: {
      getSyncKeys: () => getSyncKeys(),
      getVaultHeader: () => getVaultHeader(),
      getVaultState: () => getVaultState(),
      adoptHeaderIfSameDek: (header) => adoptHeaderIfSameDek(header),
      headerMatchesDek: (header) => headerMatchesDek(header),
      adoptCloudVault: (header, secret) => adoptCloudVault(header, secret),
      joinCloudVault: (header, password, syncPatch) =>
        joinCloudVault(header, password, syncPatch),
      verifyPassword: (password) => verifyPassword(password),
      onHeaderChange: (listener) => subscribeHeaderChanges(listener),
    },
    meta: {
      read: () => readSyncMeta(),
      update: (patch) => updateSyncMeta(patch),
      clear: () => clearSyncFields(),
    },
  }
}

export function createDeviceIdPort(): DeviceIdPort {
  return {
    get: () => getDeviceId(),
    reset: () => resetDeviceId(),
    defaultLabel: () => defaultDeviceLabel(),
  }
}
