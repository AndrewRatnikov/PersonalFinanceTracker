// No CONTRACT_GAPs: action behaviour, error codes and call order are specified
// in plan section 8 and the Interface Contract (module: actions). The actions
// run against fake api / engine / ports / device ids; nothing touches the
// network or storage. Vault failures are plain errors named "VaultError" (the
// real class is not needed to prove the actions pass them through).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudApi } from '@/lib/cloud/api'
import type {
  CloudDevice,
  CloudVault,
  SyncStatus,
} from '@/lib/cloud/types'
import type { VaultHeaderV2 } from '@/lib/vault'
import type {
  SyncCycleResult,
  SyncEngine,
  SyncMeta,
  SyncPorts,
} from '@/lib/sync/types'
import { CloudError } from '@/lib/cloud/api'
import {
  REPLACE_CONFIRMATION,
  SyncActionError,
  connectHeaderChanges,
  createSyncActions,
} from '@/lib/sync/actions'

const USER = 'user-1'
const DEVICE = 'device-1'

function header(vaultId: string): VaultHeaderV2 {
  return {
    v: 2,
    vaultId,
    createdAt: '2026-10-01T00:00:00.000Z',
    kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==' },
    wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
    recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
    verifier: { iv: 'aXY=', ct: 'Y3Q=' },
  }
}

const LOCAL_HEADER = header('local-vault')

function status(sync = true): SyncStatus {
  return {
    plan_id: sync ? 'beta' : 'free',
    has_sync: sync,
    free_for_all: sync,
    granted_by: sync ? 'free_for_all' : 'default',
    beta_joined_at: null,
    entitlement_status: null,
    current_period_end: null,
    limits: { sync, max_devices: 5, max_records: 1000, max_bytes: 1000000 },
    vault: null,
    devices_count: 0,
  }
}

function cloudVault(vaultId: string, headerRev = 3): CloudVault {
  return { vault_id: vaultId, header: header(vaultId), header_rev: headerRev }
}

function device(id: string): CloudDevice {
  return {
    device_id: id,
    label: 'Device',
    created_at: '2026-10-01T00:00:00.000Z',
    last_seen_at: '2026-10-01T00:00:00.000Z',
    removed_at: null,
  }
}

function cycle(overrides: Partial<SyncCycleResult> = {}): SyncCycleResult {
  return {
    ran: true,
    status: 'synced',
    pulled: 0,
    applied: 0,
    pushed: 0,
    stale: 0,
    skipped: 0,
    deduped: 0,
    compacted: 0,
    ...overrides,
  }
}

function vaultError(code: string): Error {
  return Object.assign(new Error(code), { name: 'VaultError', code })
}

const ON_META: SyncMeta = {
  localRev: 4,
  enabled: true,
  userId: USER,
  vaultId: 'local-vault',
  deviceId: DEVICE,
  pushedRev: 3,
  pullCursor: 8,
  headerRev: 1,
  lastSyncAt: null,
  lastError: null,
}

interface Setup {
  actions: ReturnType<typeof createSyncActions>
  api: { [K in keyof CloudApi]: ReturnType<typeof vi.fn> }
  engine: { [K in keyof SyncEngine]: ReturnType<typeof vi.fn> }
  local: { isUnlocked: ReturnType<typeof vi.fn> }
  vault: { [K in keyof SyncPorts['vault']]: ReturnType<typeof vi.fn> }
  meta: { read: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }
  deviceIds: { get: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; defaultLabel: ReturnType<typeof vi.fn> }
  ports: SyncPorts
  user: { id: string | null }
}

function setup(): Setup {
  const user: { id: string | null } = { id: USER }
  const api = {
    getSyncStatus: vi.fn(async () => status()),
    getVault: vi.fn(async (): Promise<CloudVault | null> => null),
    registerDevice: vi.fn(async (id: string) => device(id)),
    listDevices: vi.fn(async () => [device('a'), device('b')]),
    renameDevice: vi.fn(async (id: string) => device(id)),
    removeDevice: vi.fn(async (id: string) => device(id)),
    createVault: vi.fn(async (_d: string, vaultId: string) => ({ vault_id: vaultId, header_rev: 1 })),
    updateVaultHeader: vi.fn(),
    pushRecords: vi.fn(),
    pullRecords: vi.fn(),
    deleteCloudData: vi.fn(async () => ({ deleted_records: 0 })),
  }
  const engine = {
    getState: vi.fn(),
    subscribe: vi.fn(),
    onEvent: vi.fn(),
    refreshFromMeta: vi.fn(async () => ({})),
    runCycle: vi.fn(async () => cycle()),
    requestCycle: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  const local = { isUnlocked: vi.fn(() => true) }
  const vault = {
    getSyncKeys: vi.fn(),
    getVaultHeader: vi.fn(async () => LOCAL_HEADER),
    getVaultState: vi.fn(async () => 'v2' as const),
    adoptHeaderIfSameDek: vi.fn(async () => 'adopted' as const),
    headerMatchesDek: vi.fn(),
    adoptCloudVault: vi.fn(async () => ({ header: LOCAL_HEADER, headerChanged: false })),
    joinCloudVault: vi.fn(async () => ({ records: 3, startRev: 4, localRev: 7 })),
    verifyPassword: vi.fn(async () => undefined),
    onHeaderChange: vi.fn(() => () => undefined),
  }
  const meta = {
    read: vi.fn(async () => ({ ...ON_META })),
    update: vi.fn(async () => ({ ...ON_META })),
    clear: vi.fn(async () => ({ localRev: 4 })),
  }
  const deviceIds = {
    get: vi.fn(() => DEVICE),
    reset: vi.fn(() => 'device-2'),
    defaultLabel: vi.fn(() => 'Chrome on macOS'),
  }
  const ports = { local, vault, meta } as unknown as SyncPorts
  const actions = createSyncActions({
    api: api as unknown as CloudApi,
    engine: engine as unknown as SyncEngine,
    ports,
    deviceIds,
    getUserId: () => user.id,
  })
  return { actions, api, engine, local, vault, meta, deviceIds, ports, user }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code
}

let s: Setup

beforeEach(() => {
  s = setup()
})

describe('SyncActionError', () => {
  it('has the documented name and code', () => {
    const err = new SyncActionError('locked')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SyncActionError')
    expect(err.code).toBe('locked')
    expect(new SyncActionError('not_fresh').code).toBe('not_fresh')
  })

  it('the replace confirmation is DELETE', () => {
    expect(REPLACE_CONFIRMATION).toBe('DELETE')
  })
})

describe('the gate in front of every data-moving action', () => {
  const calls: Array<[string, (x: Setup) => Promise<unknown>]> = [
    ['turnOn', (x) => x.actions.turnOn()],
    ['uploadAgain', (x) => x.actions.uploadAgain()],
    ['joinAndKeep', (x) => x.actions.joinAndKeep(cloudVault('cloud'), 'pw')],
    ['replaceCloud', (x) => x.actions.replaceCloud('DELETE')],
    ['fetchCloudVault', (x) => x.actions.fetchCloudVault()],
    [
      'restoreFromCloud',
      async (x) => {
        x.vault.getVaultState.mockResolvedValue('none')
        return x.actions.restoreFromCloud(cloudVault('cloud'), { password: 'pw' })
      },
    ],
  ]

  it.each(calls)('%s: sync_not_included moves nothing', async (_name, run) => {
    s.api.getSyncStatus.mockResolvedValue(status(false))
    expect(await codeOf(run(s))).toBe('sync_not_included')

    expect(s.api.getSyncStatus).toHaveBeenCalledTimes(1)
    expect(s.api.registerDevice).not.toHaveBeenCalled()
    expect(s.api.createVault).not.toHaveBeenCalled()
    expect(s.api.getVault).not.toHaveBeenCalled()
    expect(s.api.deleteCloudData).not.toHaveBeenCalled()
    expect(s.vault.joinCloudVault).not.toHaveBeenCalled()
    expect(s.vault.adoptCloudVault).not.toHaveBeenCalled()
    expect(s.meta.update).not.toHaveBeenCalled()
    expect(s.engine.runCycle).not.toHaveBeenCalled()
  })

  it.each(calls)('%s: signed out is not_signed_in with no cloud call', async (_name, run) => {
    s.user.id = null
    expect(await codeOf(run(s))).toBe('not_signed_in')

    expect(s.api.getSyncStatus).not.toHaveBeenCalled()
    expect(s.api.registerDevice).not.toHaveBeenCalled()
    expect(s.api.getVault).not.toHaveBeenCalled()
    expect(s.engine.runCycle).not.toHaveBeenCalled()
  })

  it('asks for a fresh status on every call', async () => {
    await s.actions.fetchCloudVault()
    await s.actions.fetchCloudVault()
    expect(s.api.getSyncStatus).toHaveBeenCalledTimes(2)
  })
})

describe('turnOn', () => {
  it('refuses while the vault is locked', async () => {
    s.local.isUnlocked.mockReturnValue(false)
    expect(await codeOf(s.actions.turnOn())).toBe('locked')
    expect(s.api.registerDevice).not.toHaveBeenCalled()
  })

  it('creates the cloud vault when there is none and pushes the full snapshot', async () => {
    s.api.createVault.mockResolvedValue({ vault_id: 'local-vault', header_rev: 1 })
    s.engine.runCycle.mockResolvedValue(cycle({ pushed: 12 }))

    const result = await s.actions.turnOn()

    expect(result).toEqual({ kind: 'created', pushed: 12 })
    expect(s.api.registerDevice).toHaveBeenCalledWith(DEVICE, 'Chrome on macOS')
    expect(s.api.createVault).toHaveBeenCalledWith(DEVICE, 'local-vault', LOCAL_HEADER)
    expect(s.meta.update).toHaveBeenCalledWith({
      enabled: true,
      userId: USER,
      vaultId: 'local-vault',
      deviceId: DEVICE,
      pushedRev: -1,
      pullCursor: 0,
      headerRev: 1,
      lastSyncAt: null,
      lastError: null,
      headerPending: false,
    })
    expect(s.engine.runCycle).toHaveBeenCalledWith({ reason: 'turn-on' })
    const order = [
      s.api.getSyncStatus,
      s.api.registerDevice,
      s.api.getVault,
      s.api.createVault,
      s.meta.update,
      s.engine.runCycle,
    ].map((fn) => fn.mock.invocationCallOrder[0])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('a different pushed count gives a different result', async () => {
    s.engine.runCycle.mockResolvedValue(cycle({ pushed: 3 }))
    expect(await s.actions.turnOn()).toEqual({ kind: 'created', pushed: 3 })
  })

  it('links to a cloud vault with the same vault_id and syncs', async () => {
    s.api.getVault.mockResolvedValue(cloudVault('local-vault', 6))
    const result = await s.actions.turnOn()

    expect(result).toEqual({ kind: 'linked' })
    expect(s.vault.adoptHeaderIfSameDek).toHaveBeenCalledWith(header('local-vault'))
    expect(s.api.createVault).not.toHaveBeenCalled()
    expect(s.meta.update).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: 'local-vault', headerRev: 6, pullCursor: 0, enabled: true }),
    )
    expect(s.engine.runCycle).toHaveBeenCalledWith({ reason: 'turn-on' })
  })

  it('a same-id vault with another DEK stays off and throws vault_mismatch', async () => {
    s.api.getVault.mockResolvedValue(cloudVault('local-vault', 6))
    s.vault.adoptHeaderIfSameDek.mockResolvedValue('mismatch')

    const err = await s.actions.turnOn().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CloudError)
    expect((err as CloudError).code).toBe('vault_mismatch')
    expect(s.meta.update).not.toHaveBeenCalled()
    expect(s.engine.runCycle).not.toHaveBeenCalled()
  })

  it('asks for the link dialog when the cloud vault has another id', async () => {
    const cloud = cloudVault('someone-elses', 2)
    s.api.getVault.mockResolvedValue(cloud)
    const result = await s.actions.turnOn()

    expect(result).toEqual({ kind: 'needs-link', cloud })
    expect(s.meta.update).not.toHaveBeenCalled()
    expect(s.engine.runCycle).not.toHaveBeenCalled()
    expect(s.api.createVault).not.toHaveBeenCalled()
  })

  it('a removed device registers again with a new device id', async () => {
    s.api.registerDevice
      .mockRejectedValueOnce(new CloudError('device_removed'))
      .mockImplementation(async (id: string) => device(id))
    await s.actions.turnOn()

    expect(s.deviceIds.reset).toHaveBeenCalledTimes(1)
    expect(s.api.registerDevice).toHaveBeenCalledTimes(2)
    expect(s.api.registerDevice.mock.calls[1][0]).toBe('device-2')
    expect(s.api.createVault.mock.calls[0][0]).toBe('device-2')
    expect(s.meta.update).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-2' }))
  })

  it('other register errors are passed on and nothing is saved', async () => {
    s.api.registerDevice.mockRejectedValue(new CloudError('device_limit'))
    expect(await codeOf(s.actions.turnOn())).toBe('device_limit')
    expect(s.meta.update).not.toHaveBeenCalled()
    expect(s.deviceIds.reset).not.toHaveBeenCalled()
  })

  it('uploadAgain runs the same flow', async () => {
    s.engine.runCycle.mockResolvedValue(cycle({ pushed: 5 }))
    expect(await s.actions.uploadAgain()).toEqual({ kind: 'created', pushed: 5 })
    expect(s.api.createVault).toHaveBeenCalledTimes(1)
  })
})

describe('joinAndKeep', () => {
  it('joins with the password, patches meta without pushedRev, then runs a cycle', async () => {
    s.engine.runCycle.mockResolvedValue(cycle({ pulled: 9 }))
    const cloud = cloudVault('cloud-vault', 4)
    const result = await s.actions.joinAndKeep(cloud, 'my password')

    expect(result.pulled).toBe(9)
    expect(s.vault.joinCloudVault).toHaveBeenCalledTimes(1)
    const [h, password, patch] = s.vault.joinCloudVault.mock.calls[0] as [VaultHeaderV2, string, Record<string, unknown>]
    expect(h).toEqual(cloud.header)
    expect(password).toBe('my password')
    expect(patch).toEqual({
      enabled: true,
      userId: USER,
      vaultId: 'cloud-vault',
      deviceId: DEVICE,
      pullCursor: 0,
      headerRev: 4,
      lastSyncAt: null,
      lastError: null,
      headerPending: false,
    })
    expect('pushedRev' in patch).toBe(false)
    expect(s.engine.runCycle).toHaveBeenCalledWith({ reason: 'turn-on' })
    expect(s.vault.joinCloudVault.mock.invocationCallOrder[0]).toBeLessThan(
      s.engine.runCycle.mock.invocationCallOrder[0],
    )
  })

  it('a wrong password is passed on and no cycle runs', async () => {
    s.vault.joinCloudVault.mockRejectedValue(vaultError('incorrect-password'))
    expect(await codeOf(s.actions.joinAndKeep(cloudVault('c'), 'bad'))).toBe('incorrect-password')
    expect(s.engine.runCycle).not.toHaveBeenCalled()
  })
})

describe('replaceCloud', () => {
  it.each(['', 'delete', 'DELET', 'DELETE ', 'yes'])(
    'refuses %j without touching the cloud',
    async (text) => {
      expect(await codeOf(s.actions.replaceCloud(text))).toBe('confirmation_required')
      expect(s.api.getSyncStatus).not.toHaveBeenCalled()
      expect(s.api.deleteCloudData).not.toHaveBeenCalled()
      expect(s.api.createVault).not.toHaveBeenCalled()
    },
  )

  it('deletes the cloud data, registers again, creates the vault and pushes everything', async () => {
    s.api.createVault.mockResolvedValue({ vault_id: 'local-vault', header_rev: 1 })
    s.engine.runCycle.mockResolvedValue(cycle({ pushed: 20 }))
    const result = await s.actions.replaceCloud('DELETE')

    expect(result.pushed).toBe(20)
    expect(s.api.deleteCloudData).toHaveBeenCalledTimes(1)
    expect(s.api.registerDevice).toHaveBeenCalledWith(DEVICE, 'Chrome on macOS')
    expect(s.api.createVault).toHaveBeenCalledWith(DEVICE, 'local-vault', LOCAL_HEADER)
    expect(s.meta.update).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        vaultId: 'local-vault',
        pushedRev: -1,
        pullCursor: 0,
        headerRev: 1,
      }),
    )
    expect(s.engine.runCycle).toHaveBeenCalled()
    const order = [s.api.deleteCloudData, s.api.registerDevice, s.api.createVault, s.meta.update, s.engine.runCycle].map(
      (fn) => fn.mock.invocationCallOrder[0],
    )
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

describe('turnOff', () => {
  it('clears the sync fields, refreshes the state and leaves the device registered', async () => {
    await s.actions.turnOff({ removeDevice: false })

    expect(s.meta.clear).toHaveBeenCalledTimes(1)
    expect(s.engine.refreshFromMeta).toHaveBeenCalledTimes(1)
    expect(s.api.removeDevice).not.toHaveBeenCalled()
    expect(s.api.getSyncStatus).not.toHaveBeenCalled()
  })

  it('also removes this device when asked, after sync is off', async () => {
    await s.actions.turnOff({ removeDevice: true })

    expect(s.api.removeDevice).toHaveBeenCalledWith(DEVICE)
    expect(s.meta.clear.mock.invocationCallOrder[0]).toBeLessThan(
      s.api.removeDevice.mock.invocationCallOrder[0],
    )
    expect(s.api.getSyncStatus).not.toHaveBeenCalled()
  })

  it('rethrows a remove_device failure but sync is already off', async () => {
    s.api.removeDevice.mockRejectedValue(new CloudError('network'))
    expect(await codeOf(s.actions.turnOff({ removeDevice: true }))).toBe('network')
    expect(s.meta.clear).toHaveBeenCalledTimes(1)
    expect(s.engine.refreshFromMeta).toHaveBeenCalledTimes(1)
  })

  it('signed out: does not call remove_device', async () => {
    s.user.id = null
    await s.actions.turnOff({ removeDevice: true })
    expect(s.api.removeDevice).not.toHaveBeenCalled()
    expect(s.meta.clear).toHaveBeenCalledTimes(1)
  })
})

describe('fetchCloudVault and restoreFromCloud', () => {
  it('fetchCloudVault returns the cloud vault or null', async () => {
    expect(await s.actions.fetchCloudVault()).toBeNull()
    const cloud = cloudVault('cloud')
    s.api.getVault.mockResolvedValue(cloud)
    expect(await s.actions.fetchCloudVault()).toBe(cloud)
  })

  it('restoreFromCloud refuses a device that already has a vault', async () => {
    s.vault.getVaultState.mockResolvedValue('v2')
    expect(await codeOf(s.actions.restoreFromCloud(cloudVault('cloud'), { password: 'pw' }))).toBe('not_fresh')
    expect(s.vault.adoptCloudVault).not.toHaveBeenCalled()
    expect(s.api.registerDevice).not.toHaveBeenCalled()
  })

  it.each(['v1', 'orphaned'] as const)('restoreFromCloud refuses state %s', async (state) => {
    s.vault.getVaultState.mockResolvedValue(state)
    expect(await codeOf(s.actions.restoreFromCloud(cloudVault('cloud'), { password: 'pw' }))).toBe('not_fresh')
  })

  it('adopts the header, registers, saves meta from the start and runs a restore cycle', async () => {
    s.vault.getVaultState.mockResolvedValue('none')
    const cloud = cloudVault('cloud', 5)
    s.engine.runCycle.mockResolvedValue(cycle({ pulled: 50 }))
    const result = await s.actions.restoreFromCloud(cloud, { password: 'pw' })

    expect(result.pulled).toBe(50)
    expect(s.vault.adoptCloudVault).toHaveBeenCalledWith(cloud.header, { password: 'pw' })
    expect(s.api.registerDevice).toHaveBeenCalledWith(DEVICE, 'Chrome on macOS')
    expect(s.meta.update).toHaveBeenCalledWith({
      enabled: true,
      userId: USER,
      vaultId: 'cloud',
      deviceId: DEVICE,
      pushedRev: -1,
      pullCursor: 0,
      headerRev: 5,
      lastSyncAt: null,
      lastError: null,
      headerPending: false,
    })
    expect(s.engine.runCycle).toHaveBeenCalledWith({ reason: 'restore' })
    expect(s.vault.adoptCloudVault.mock.invocationCallOrder[0]).toBeLessThan(
      s.api.registerDevice.mock.invocationCallOrder[0],
    )
  })

  it('a recovery-key restore marks the re-wrapped header as pending', async () => {
    s.vault.getVaultState.mockResolvedValue('none')
    s.vault.adoptCloudVault.mockResolvedValue({ header: LOCAL_HEADER, headerChanged: true })
    await s.actions.restoreFromCloud(cloudVault('cloud'), {
      recoveryKey: 'AAAAA-BBBBB',
      newPassword: 'a new password',
    })
    expect(s.meta.update).toHaveBeenCalledWith(expect.objectContaining({ headerPending: true }))
  })

  it('a wrong password writes and registers nothing', async () => {
    s.vault.getVaultState.mockResolvedValue('none')
    s.vault.adoptCloudVault.mockRejectedValue(vaultError('incorrect-password'))
    expect(await codeOf(s.actions.restoreFromCloud(cloudVault('cloud'), { password: 'bad' }))).toBe(
      'incorrect-password',
    )
    expect(s.api.registerDevice).not.toHaveBeenCalled()
    expect(s.meta.update).not.toHaveBeenCalled()
    expect(s.engine.runCycle).not.toHaveBeenCalled()
  })

  it('a removed device id is replaced while restoring', async () => {
    s.vault.getVaultState.mockResolvedValue('none')
    s.api.registerDevice
      .mockRejectedValueOnce(new CloudError('device_removed'))
      .mockImplementation(async (id: string) => device(id))
    await s.actions.restoreFromCloud(cloudVault('cloud'), { password: 'pw' })

    expect(s.deviceIds.reset).toHaveBeenCalledTimes(1)
    expect(s.meta.update).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-2' }))
  })
})

describe('deleteCloudData', () => {
  it('checks the password, deletes the cloud data, then turns sync off', async () => {
    await s.actions.deleteCloudData('my password')

    expect(s.vault.verifyPassword).toHaveBeenCalledWith('my password')
    expect(s.api.deleteCloudData).toHaveBeenCalledTimes(1)
    expect(s.meta.clear).toHaveBeenCalledTimes(1)
    expect(s.engine.refreshFromMeta).toHaveBeenCalledTimes(1)
    const order = [s.vault.verifyPassword, s.api.deleteCloudData, s.meta.clear].map(
      (fn) => fn.mock.invocationCallOrder[0],
    )
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('is not behind the plan gate', async () => {
    s.api.getSyncStatus.mockResolvedValue(status(false))
    await s.actions.deleteCloudData('pw')
    expect(s.api.getSyncStatus).not.toHaveBeenCalled()
    expect(s.api.deleteCloudData).toHaveBeenCalledTimes(1)
  })

  it('a wrong password deletes nothing and keeps sync on', async () => {
    s.vault.verifyPassword.mockRejectedValue(vaultError('incorrect-password'))
    expect(await codeOf(s.actions.deleteCloudData('bad'))).toBe('incorrect-password')
    expect(s.api.deleteCloudData).not.toHaveBeenCalled()
    expect(s.meta.clear).not.toHaveBeenCalled()
  })

  it('a failing server call keeps sync on', async () => {
    s.api.deleteCloudData.mockRejectedValue(new CloudError('network'))
    expect(await codeOf(s.actions.deleteCloudData('pw'))).toBe('network')
    expect(s.meta.clear).not.toHaveBeenCalled()
  })
})

describe('syncNow and device management', () => {
  it('syncNow runs a manual cycle', async () => {
    s.engine.runCycle.mockResolvedValue(cycle({ pushed: 2 }))
    const result = await s.actions.syncNow()
    expect(result.pushed).toBe(2)
    expect(s.engine.runCycle).toHaveBeenCalledWith({ reason: 'manual' })
  })

  it('lists, renames and removes devices without the plan gate', async () => {
    s.api.getSyncStatus.mockResolvedValue(status(false))
    expect((await s.actions.listDevices()).map((d) => d.device_id)).toEqual(['a', 'b'])
    expect((await s.actions.renameDevice('a', 'New name')).device_id).toBe('a')
    expect((await s.actions.removeDevice('b')).device_id).toBe('b')

    expect(s.api.renameDevice).toHaveBeenCalledWith('a', 'New name')
    expect(s.api.removeDevice).toHaveBeenCalledWith('b')
    expect(s.api.getSyncStatus).not.toHaveBeenCalled()
  })
})

describe('header changes', () => {
  it('handleLocalHeaderChange marks the header pending and asks for a cycle', async () => {
    await s.actions.handleLocalHeaderChange()
    expect(s.meta.update).toHaveBeenCalledWith({ headerPending: true })
    expect(s.engine.requestCycle).toHaveBeenCalledWith('header')
  })

  it('does nothing while sync is off', async () => {
    s.meta.read.mockResolvedValue({ localRev: 2 })
    await s.actions.handleLocalHeaderChange()
    expect(s.meta.update).not.toHaveBeenCalled()
    expect(s.engine.requestCycle).not.toHaveBeenCalled()
  })

  it('connectHeaderChanges subscribes to the vault and forwards each event', async () => {
    let fire: () => void = () => undefined
    const off = vi.fn()
    s.vault.onHeaderChange.mockImplementation((listener: () => void) => {
      fire = listener
      return off
    })
    const actions = { handleLocalHeaderChange: vi.fn(async () => undefined) }
    const dispose = connectHeaderChanges(s.ports, actions as never)

    expect(s.vault.onHeaderChange).toHaveBeenCalledTimes(1)
    fire()
    fire()
    expect(actions.handleLocalHeaderChange).toHaveBeenCalledTimes(2)
    dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
