// No CONTRACT_GAPs: states, gate and account rules are specified in plan
// sections 7 and 8 (criteria 3, 16, 20, 25, 34). "Remove data from this device"
// is the same two steps localWipe performs (lock the vault, clear the store),
// done on the device's own modules so the other simulated devices (and the
// shared localStorage) are not touched. The beta switch is a global server
// setting, so every test that flips it restores it in a finally block.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { setFreeForAll, startDb } from '@/test/sql/harness'
import { createSimDevice, createSyncedPair } from '@/test/sync/simDevice'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const PW = 'permissions password'

let ctx: SqlTestDb
const devices: Array<SimDevice> = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  ctx = await startDb()
}, 60_000)

afterEach(async () => {
  for (const d of devices.splice(0)) d.dispose()
  await setFreeForAll(ctx, true)
})

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

async function pair(withData = true) {
  const p = await createSyncedPair(ctx, PW, withData)
  devices.push(p.a, p.b)
  return p
}

async function count(sql: string, userId: string): Promise<number> {
  const rows = await ctx.admin<{ n: number }>(sql, [userId])
  return rows[0].n
}

const serverRecords = (userId: string) =>
  count('select count(*)::int as n from public.sync_records where user_id = $1', userId)
const serverVaults = (userId: string) =>
  count('select count(*)::int as n from public.vaults where user_id = $1', userId)
const activeDevices = (userId: string) =>
  count(
    'select count(*)::int as n from public.devices where user_id = $1 and removed_at is null',
    userId,
  )

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code
}

function names(d: SimDevice, from = 0): Array<string> {
  return d.calls.slice(from).map((c) => c.fn)
}

describe('sync is not included in the plan (paused)', () => {
  it('pauses, pushes nothing, keeps the local data and resumes when the plan is back', async () => {
    const p = await pair()
    const recordsBefore = await serverRecords(p.userId)
    const mark = p.a.calls.length

    await setFreeForAll(ctx, false)
    const edit = await p.a.localDb.addExpense({
      amount: 4321,
      currency: 'UAH',
      categoryId: p.seed!.categoryId,
      description: 'written while paused',
      createdAt: '2026-10-20T09:00:00.000Z',
    })
    const paused = await p.a.actions.syncNow()

    expect(paused.status).toBe('paused')
    expect(p.a.engine.getState().status).toBe('paused')
    expect(names(p.a, mark)).toEqual(['get_sync_status'])
    expect(await serverRecords(p.userId)).toBe(recordsBefore)
    expect((await p.a.localDb.getAllExpenses()).map((e) => e.id)).toContain(edit.id)

    const pausedB = await p.b.actions.syncNow()
    expect(pausedB.status).toBe('paused')
    expect((await p.b.localDb.getAllExpenses()).length).toBe(2)

    await setFreeForAll(ctx, true)
    const resumed = await p.a.actions.syncNow()
    expect(resumed.status).toBe('synced')
    expect(resumed.pushed).toBeGreaterThan(0)
    expect(await serverRecords(p.userId)).toBe(recordsBefore + 1)

    await p.b.actions.syncNow()
    expect((await p.b.localDb.getAllExpenses()).map((e) => e.id)).toContain(edit.id)
    expect(await p.a.snapshot()).toEqual(await p.b.snapshot())
  })

  it('every data-moving action refuses with sync_not_included and calls nothing else', async () => {
    const p = await pair(false)
    await setFreeForAll(ctx, false)
    const mark = p.a.calls.length

    expect(await codeOf(p.a.actions.turnOn())).toBe('sync_not_included')
    expect(await codeOf(p.a.actions.fetchCloudVault())).toBe('sync_not_included')
    expect(await codeOf(p.a.actions.replaceCloud('DELETE'))).toBe('sync_not_included')

    expect(new Set(names(p.a, mark))).toEqual(new Set(['get_sync_status']))
  })

  it('a fresh device cannot restore without the plan', async () => {
    const p = await pair(false)
    const c = await createSimDevice({ name: 'C', rpc: p.rpc, userId: p.userId })
    devices.push(c)
    await setFreeForAll(ctx, false)

    expect(await codeOf(c.actions.fetchCloudVault())).toBe('sync_not_included')
    expect(names(c)).toEqual(['get_sync_status'])
    expect(await c.vault.getVaultState()).toBe('none')
  })

  it('deleting cloud data, listing devices and turning sync off are never gated', async () => {
    const p = await pair()
    await setFreeForAll(ctx, false)
    const mark = p.a.calls.length

    expect((await p.a.actions.listDevices()).length).toBe(2)
    await p.a.actions.deleteCloudData(PW)

    expect(names(p.a, mark)).not.toContain('get_sync_status')
    expect(await serverRecords(p.userId)).toBe(0)
    expect(await serverVaults(p.userId)).toBe(0)
    expect(p.a.syncMeta.isSyncOn(await p.a.syncMeta.readSyncMeta())).toBe(false)
    expect((await p.a.localDb.getAllExpenses()).length).toBe(2)
  })
})

describe('a device removed from another device', () => {
  it('shows device-removed, pushes nothing and keeps the data; reconnecting uses a new device id', async () => {
    const p = await pair()
    const oldId = p.b.deviceIds.id()
    const removed = await p.a.actions.removeDevice(oldId)
    expect(removed.removed_at).not.toBeNull()
    expect((await p.a.actions.listDevices()).find((d) => d.device_id === oldId)?.removed_at).not.toBeNull()

    await p.b.localDb.addExpense({
      amount: 9090,
      currency: 'UAH',
      categoryId: p.seed!.categoryId,
      description: 'offline on the removed device',
      createdAt: '2026-10-21T09:00:00.000Z',
    })
    const recordsBefore = await serverRecords(p.userId)
    const pushesBefore = p.b.count('push_records')

    const result = await p.b.actions.syncNow()

    expect(result.status).toBe('device-removed')
    expect(p.b.engine.getState().status).toBe('device-removed')
    expect(p.b.count('push_records')).toBe(pushesBefore)
    expect(await serverRecords(p.userId)).toBe(recordsBefore)
    expect((await p.b.localDb.getAllExpenses()).length).toBe(3)

    // "Turn sync on again to reconnect": a new device id, then everything syncs.
    const reconnect = await p.b.actions.turnOn()
    expect(reconnect.kind).toBe('linked')
    expect(p.b.deviceIds.resets()).toBe(1)
    expect(p.b.deviceIds.id()).not.toBe(oldId)
    expect((await p.b.syncMeta.readSyncMeta()).deviceId).toBe(p.b.deviceIds.id())
    expect(p.b.engine.getState().status).toBe('synced')
    expect(await activeDevices(p.userId)).toBe(2)
    expect(await serverRecords(p.userId)).toBe(recordsBefore + 1)

    await p.a.actions.syncNow()
    expect(await p.a.snapshot()).toEqual(await p.b.snapshot())
    expect((await p.a.localDb.getAllExpenses()).length).toBe(3)
  })
})

describe('Delete cloud data', () => {
  it('asks for the password; a wrong one deletes nothing', async () => {
    const p = await pair()
    const records = await serverRecords(p.userId)

    expect(await codeOf(p.a.actions.deleteCloudData('not the password'))).toBe('incorrect-password')

    expect(await serverRecords(p.userId)).toBe(records)
    expect(await serverVaults(p.userId)).toBe(1)
    expect(p.a.syncMeta.isSyncOn(await p.a.syncMeta.readSyncMeta())).toBe(true)
  })

  it('empties the server, keeps local data everywhere, and the other device sees cloud-deleted', async () => {
    const p = await pair()
    const before = await p.a.snapshot()

    await p.a.actions.deleteCloudData(PW)

    expect(await serverRecords(p.userId)).toBe(0)
    expect(await serverVaults(p.userId)).toBe(0)
    expect(p.a.syncMeta.isSyncOn(await p.a.syncMeta.readSyncMeta())).toBe(false)
    expect(p.a.engine.getState().status).toBe('off')
    expect(await p.a.snapshot()).toEqual(before)
    expect(await p.b.snapshot()).toEqual(before)

    const pullsBefore = p.b.count('pull_records')
    const pushesBefore = p.b.count('push_records')
    const seen = await p.b.actions.syncNow()
    expect(seen.status).toBe('cloud-deleted')
    expect(p.b.engine.getState().status).toBe('cloud-deleted')
    expect(p.b.count('pull_records')).toBe(pullsBefore)
    expect(p.b.count('push_records')).toBe(pushesBefore)
    expect(await serverRecords(p.userId)).toBe(0)
    expect(await p.b.snapshot()).toEqual(before)
  })

  it('"Upload again" restores the server copy from the other device, and the first device can link back', async () => {
    const p = await pair()
    const before = await p.a.snapshot()
    await p.a.actions.deleteCloudData(PW)
    await p.b.actions.syncNow()
    expect(p.b.engine.getState().status).toBe('cloud-deleted')

    const upload = await p.b.actions.uploadAgain()

    expect(upload.kind).toBe('created')
    const local = (await p.b.localDb.listChangedRecords(-1)).records.length
    expect(await serverRecords(p.userId)).toBe(local)
    expect(await serverVaults(p.userId)).toBe(1)
    expect(p.b.engine.getState().status).toBe('synced')
    expect(await p.b.snapshot()).toEqual(before)

    // The first device turns sync on again: the same vault, so it just links.
    const linked = await p.a.actions.turnOn()
    expect(linked.kind).toBe('linked')
    expect(p.a.engine.getState().status).toBe('synced')
    expect(await p.a.snapshot()).toEqual(before)
    expect(await serverRecords(p.userId)).toBe(local)
  })

  it('"Turn off sync" is the other choice and leaves the device with its data', async () => {
    const p = await pair()
    await p.a.actions.deleteCloudData(PW)
    await p.b.actions.syncNow()

    await p.b.actions.turnOff({ removeDevice: false })

    expect(p.b.syncMeta.isSyncOn(await p.b.syncMeta.readSyncMeta())).toBe(false)
    expect(p.b.engine.getState().status).toBe('off')
    expect((await p.b.localDb.getAllExpenses()).length).toBe(2)
  })
})

describe('accounts', () => {
  it('another account: nothing is pushed or pulled, and Turn off keeps the data', async () => {
    const p = await pair()
    const records = await serverRecords(p.userId)
    const mark = p.b.calls.length
    p.b.state.userId = crypto.randomUUID()

    await p.b.localDb.addExpense({
      amount: 1,
      currency: 'UAH',
      categoryId: p.seed!.categoryId,
      description: 'under another account',
      createdAt: '2026-10-22T09:00:00.000Z',
    })
    const result = await p.b.actions.syncNow()

    expect(result.status).toBe('other-account')
    expect(p.b.engine.getState().status).toBe('other-account')
    expect(p.b.calls.length).toBe(mark)
    expect(await serverRecords(p.userId)).toBe(records)

    await p.b.actions.turnOff({ removeDevice: false })
    expect(p.b.syncMeta.isSyncOn(await p.b.syncMeta.readSyncMeta())).toBe(false)
    expect((await p.b.localDb.getAllExpenses()).length).toBe(3)
    expect(p.b.calls.length).toBe(mark)
  })

  it('signing out keeps local data and sync fields; the same user signing in resumes', async () => {
    const p = await pair()
    const mark = p.a.calls.length
    p.a.state.userId = null
    const added = await p.a.localDb.addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: p.seed!.categoryId,
      description: 'while signed out',
      createdAt: '2026-10-22T09:00:00.000Z',
    })

    const out = await p.a.actions.syncNow()
    expect(out.status).toBe('error')
    expect(p.a.engine.getState().errorCode).toBe('not_signed_in')
    expect(p.a.calls.length).toBe(mark)
    expect(p.a.syncMeta.isSyncOn(await p.a.syncMeta.readSyncMeta())).toBe(true)
    expect((await p.a.localDb.getAllExpenses()).map((e) => e.id)).toContain(added.id)

    p.a.state.userId = p.userId
    const back = await p.a.actions.syncNow()
    expect(back.status).toBe('synced')
    expect(back.pushed).toBeGreaterThan(0)
    await p.b.actions.syncNow()
    expect((await p.b.localDb.getAllExpenses()).map((e) => e.id)).toContain(added.id)
  })
})

describe('"Remove data from this device"', () => {
  it('keeps the cloud data, the account and the device registration, and drops the sync fields and keys', async () => {
    const p = await pair()
    const records = await serverRecords(p.userId)
    const devicesBefore = await activeDevices(p.userId)
    const mark = p.b.calls.length

    // What localWipe does on this device: lock, then empty the store.
    p.b.vault.lockVault()
    await p.b.localDb.clearLocalDb()

    expect(p.b.syncMeta.isSyncOn(await p.b.syncMeta.readSyncMeta())).toBe(false)
    expect(await p.b.vault.getVaultState()).toBe('none')
    await expect(p.b.vault.getSyncKeys()).rejects.toMatchObject({ code: 'invalid-state' })
    const cycle = await p.b.engine.runCycle()
    expect(cycle.status).toBe('off')
    expect(p.b.calls.length).toBe(mark)

    expect(await serverRecords(p.userId)).toBe(records)
    expect(await serverVaults(p.userId)).toBe(1)
    expect(await activeDevices(p.userId)).toBe(devicesBefore)
  })

  it('the same device restores everything from the cloud afterwards', async () => {
    const p = await pair()
    const before = await p.a.snapshot()
    p.b.vault.lockVault()
    await p.b.localDb.clearLocalDb()

    const cloud = await p.b.actions.fetchCloudVault()
    const restored = await p.b.actions.restoreFromCloud(cloud, { password: PW })

    expect(restored.status).toBe('synced')
    expect(await p.b.snapshot()).toEqual(before)
    expect(await activeDevices(p.userId)).toBe(2)
  })
})

describe('sync keys live in memory only', () => {
  it('locking drops them: nothing can be derived or pushed while locked', async () => {
    const p = await pair()
    const keys = await p.a.vault.getSyncKeys()
    expect(await p.a.vault.getSyncKeys()).toBe(keys)

    p.a.vault.lockVault()
    await expect(p.a.vault.getSyncKeys()).rejects.toMatchObject({ code: 'invalid-state' })

    const mark = p.a.calls.length
    const result = await p.a.engine.runCycle()
    expect(result.pushed).toBe(0)
    expect(p.a.calls.length).toBe(mark)

    await p.a.vault.unlockWithPassword(PW)
    const again = await p.a.vault.getSyncKeys()
    expect(again).toBeTruthy()
  })
})
