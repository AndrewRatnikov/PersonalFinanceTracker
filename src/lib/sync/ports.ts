// The real ports of the sync engine and actions: localDb, vault, meta:sync and
// the device id. Static imports, but nothing is called at import time (tests
// mock these modules partially). In tests, a fresh module registry
// (vi.resetModules() + a dynamic import of this file) gives a simulated device
// its own localDb / vault / meta:sync instances.

import { readFamilyMeta, updateFamilyMeta } from './familyMeta'
import { clearSyncFields, readSyncMeta, updateSyncMeta } from './syncMeta'
import type { DeviceIdPort, FamilyPorts, SyncPorts } from './types'
import {
  defaultDeviceLabel,
  getDeviceId,
  resetDeviceId,
} from '@/lib/cloud/deviceId'
import {
  adoptSpaceKey,
  applyIncomingRecords,
  compactTombstones,
  createLocalSpace,
  dedupeOccurrences,
  ensureIdentityKeyPair,
  ensureSpaceIndexKey,
  forgetLocalSpace,
  getLocalDbKey,
  getMemberProfiles,
  getSpaceInfo,
  getSpaceKeyEntry,
  listChangedRecords,
  listSpaceKeyEntries,
  onLocalChange,
  onSpaceLocalChange,
  spaceDb,
  updateSpaceEntry,
  updateSpaceInfo,
  upsertMemberProfile,
} from '@/lib/localDb'
import {
  clearPendingInvite,
  clearPendingJoin,
  readPendingJoin,
  savePendingJoin,
} from '@/lib/spaces/pendingInvite'
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

// The Family stream's and actions' ports: localDb's Family functions, the
// Family meta and the pending invite / join markers.
export function createFamilyPorts(): FamilyPorts {
  return {
    local: {
      isUnlocked: () => getLocalDbKey() !== null,
      listSpaceKeyEntries: () => listSpaceKeyEntries(),
      getSpaceKeyEntry: (spaceId) => getSpaceKeyEntry(spaceId),
      createLocalSpace: (input) => createLocalSpace(input),
      forgetLocalSpace: (spaceId) => forgetLocalSpace(spaceId),
      adoptSpaceKey: (input) => adoptSpaceKey(input),
      updateSpaceEntry: (spaceId, patch) => updateSpaceEntry(spaceId, patch),
      ensureSpaceIndexKey: (spaceId) => ensureSpaceIndexKey(spaceId),
      ensureIdentityKeyPair: () => ensureIdentityKeyPair(),
      listChangedRecords: (spaceId, sinceRev) => listChangedRecords(spaceId, sinceRev),
      applyIncomingRecords: (spaceId, records, options) =>
        applyIncomingRecords(spaceId, records, options),
      dedupeOccurrences: (spaceId, recurringIds) =>
        spaceDb(spaceId).dedupeOccurrences(recurringIds),
      compactTombstones: (spaceId, olderThan, options) =>
        spaceDb(spaceId).compactTombstones(olderThan, options),
      getSpaceInfo: (spaceId) => getSpaceInfo(spaceId),
      updateSpaceInfo: (spaceId, input) => updateSpaceInfo(spaceId, input),
      getMemberProfiles: (spaceId) => getMemberProfiles(spaceId),
      upsertMemberProfile: (spaceId, input) => upsertMemberProfile(spaceId, input),
      countEntries: async (spaceId) => {
        const db = spaceDb(spaceId)
        const [expenses, income] = await Promise.all([db.getAllExpenses(), db.getAllIncome()])
        return expenses.length + income.length
      },
      onSpaceLocalChange: (listener) => onSpaceLocalChange(listener),
    },
    meta: {
      read: (spaceId) => readFamilyMeta(spaceId),
      update: (spaceId, patch) => updateFamilyMeta(spaceId, patch),
    },
    pending: {
      readJoin: () => readPendingJoin(),
      saveJoin: (join) => {
        savePendingJoin(join)
      },
      clearJoin: () => {
        clearPendingJoin()
      },
      clearInvite: () => {
        clearPendingInvite()
      },
    },
  }
}
