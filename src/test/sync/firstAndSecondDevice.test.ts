// No CONTRACT_GAPs: the first-device upload and the second-device restore are
// specified in plan sections 7, 8 and 12 (criteria 12, 14, 29, 30). Real
// modules per device (simDevice.ts), real run 2 SQL functions on PGlite.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SeedResult, SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { storeState } from '@/test/sync/memoryIdb'
import {
  PLAINTEXT_MARKERS,
  cloudVaultOf,
  createSimDevice,
  seedSampleData,
} from '@/test/sync/simDevice'
import { recordKeyFor } from '@/lib/cloud/recordCrypto'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PW = 'first device password'
const NEW_PW = 'brand new password 99'

let ctx: SqlTestDb
let userId: string
let rpc: ReturnType<SqlTestDb['rpcAs']>
let d1: SimDevice
let seed: SeedResult
let recoveryKey: string
let turnOn: { kind: string; pushed?: number }

async function serverCount(): Promise<number> {
  const rows = await ctx.admin<{ n: number }>(
    'select count(*)::int as n from public.sync_records where user_id = $1',
    [userId],
  )
  return rows[0].n
}

async function activeDevices(): Promise<number> {
  const rows = await ctx.admin<{ n: number }>(
    'select count(*)::int as n from public.devices where user_id = $1 and removed_at is null',
    [userId],
  )
  return rows[0].n
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code
}

function metaSettings(device: SimDevice): Record<string, unknown> {
  return (storeState(device.store()).data.get('meta:settings') ?? {}) as Record<string, unknown>
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  ctx = await startDb()
  userId = await ctx.createUser()
  rpc = ctx.rpcAs(userId)

  d1 = await createSimDevice({ name: 'Laptop', rpc, userId })
  recoveryKey = await d1.createAndUnlockVault(PW)
  seed = await seedSampleData(d1)
  // A per-device setting that must stay on this device.
  const store = storeState(d1.store())
  store.data.set('meta:settings', { ...metaSettings(d1), autoLockMinutes: 1 })
  turnOn = await d1.actions.turnOn()
}, 120_000)

afterAll(async () => {
  vi.useRealTimers()
  d1.dispose()
  await ctx.close()
})

describe('the first device turns on sync', () => {
  it('creates the cloud vault and pushes the full snapshot', async () => {
    const local = await d1.localDb.listChangedRecords(-1)

    expect(turnOn.kind).toBe('created')
    expect(turnOn.pushed).toBe(local.records.length)
    expect(local.records.length).toBeGreaterThanOrEqual(8)
    expect(await serverCount()).toBe(local.records.length)
    expect(await activeDevices()).toBe(1)
    expect(d1.engine.getState().status).toBe('synced')
  })

  it('calls the gate before anything moves', () => {
    const names = d1.calls.map((c) => c.fn)
    const gate = names.indexOf('get_sync_status')
    expect(gate).toBe(0)
    for (const fn of ['register_device', 'get_vault', 'create_vault', 'push_records']) {
      expect(names.indexOf(fn), fn).toBeGreaterThan(gate)
    }
    expect(names.indexOf('register_device')).toBeLessThan(names.indexOf('create_vault'))
    expect(names.indexOf('create_vault')).toBeLessThan(names.indexOf('push_records'))
  })

  it('saves the sync fields and pushedRev equals localRev', async () => {
    const meta = await d1.syncMeta.readSyncMeta()
    const header = await d1.vault.getVaultHeader()

    expect(d1.syncMeta.isSyncOn(meta)).toBe(true)
    expect(meta.userId).toBe(userId)
    expect(meta.deviceId).toBe(d1.deviceIds.id())
    expect(meta.vaultId).toBe(header.vaultId)
    expect(meta.pushedRev).toBe(meta.localRev)
    expect(meta.localRev).toBeGreaterThan(0)
    expect(meta.lastSyncAt).not.toBeNull()
    expect(meta.lastError).toBeNull()
  })

  it('every live record and tombstone is on the server under its keyed hash', async () => {
    const keys = await d1.vault.getSyncKeys()
    const local = await d1.localDb.listChangedRecords(-1)
    const expected = await Promise.all(local.records.map((r) => recordKeyFor(keys, r.type, r.id)))
    const rows = await ctx.admin<{ record_key: string }>(
      'select record_key from public.sync_records where user_id = $1',
      [userId],
    )

    expect(rows.map((r) => r.record_key).sort()).toEqual([...expected].sort())
    expect(local.records.some((r) => r.id === seed.deletedExpenseId && r.deletedAt)).toBe(true)
    expect(local.records.map((r) => r.type)).toEqual(
      expect.arrayContaining(['expense', 'income', 'category', 'incomeCategory', 'budget', 'recurring', 'settings']),
    )
  })

  it('stores only ciphertext: no amount, description, category name or record type in any column', async () => {
    const records = await ctx.admin('select * from public.sync_records where user_id = $1', [userId])
    const vaults = await ctx.admin('select * from public.vaults where user_id = $1', [userId])
    const devices = await ctx.admin('select * from public.devices where user_id = $1', [userId])
    const stored = JSON.stringify({ records, vaults: vaults.map((v) => ({ ...v, header: undefined })) })
    const everything = `${stored}${JSON.stringify(devices)}`

    for (const marker of PLAINTEXT_MARKERS) expect(everything).not.toContain(marker)
    expect(everything).not.toContain('removed again')
    for (const word of ['"expense"', '"income"', '"category"', '"budget"', '"recurring"', '"settings"']) {
      expect(stored).not.toContain(word)
    }
    for (const amount of ['123457', '98765', '5550000', '424242', '313131']) {
      for (const row of records) {
        const r = row as { ciphertext: string; iv: string; record_key: string }
        expect(`${r.ciphertext}${r.iv}${r.record_key}`).not.toContain(amount)
      }
    }
    // The header copy holds only wrapped keys and salts.
    const header = JSON.stringify((vaults[0] as { header: unknown }).header)
    for (const marker of PLAINTEXT_MARKERS) expect(header).not.toContain(marker)
    expect(records.length).toBeGreaterThan(0)
  })

  it('each row carries the edit time of its record in the clear and nothing else about it', async () => {
    const rows = await ctx.admin<{ updated_at_ms: string; size: number }>(
      'select updated_at_ms, size from public.sync_records where user_id = $1',
      [userId],
    )
    const local = await d1.localDb.listChangedRecords(-1)
    const times = local.records.map((r) => Date.parse(r.updatedAt)).sort((a, b) => a - b)
    expect(rows.map((r) => Number(r.updated_at_ms)).sort((a, b) => a - b)).toEqual(times)
    expect(rows.every((r) => r.size > 0)).toBe(true)
  })

  it('a second cycle with nothing new pushes nothing', async () => {
    const before = d1.count('push_records')
    const result = await d1.actions.syncNow()
    expect(result.status).toBe('synced')
    expect(result.pushed).toBe(0)
    expect(d1.count('push_records')).toBe(before)
  })
})

describe('a second device restores from the cloud', () => {
  let d2: SimDevice

  it('refuses a wrong password, registers nothing and writes nothing', async () => {
    d2 = await createSimDevice({ name: 'Phone', rpc, userId })
    expect(await d2.vault.getVaultState()).toBe('none')
    const cloud = await cloudVaultOf(d2)
    const devicesBefore = await activeDevices()

    expect(await codeOf(d2.actions.restoreFromCloud(cloud, { password: 'wrong password' }))).toBe(
      'incorrect-password',
    )

    expect(await d2.vault.getVaultState()).toBe('none')
    expect(await activeDevices()).toBe(devicesBefore)
    expect(d2.count('register_device')).toBe(0)
    expect(d2.count('pull_records')).toBe(0)
    expect(d2.localDb.getLocalDbKey()).toBeNull()
  })

  it('with the password it restores identical live data', async () => {
    const cloud = await cloudVaultOf(d2)
    const before = await serverCount()
    const result = await d2.actions.restoreFromCloud(cloud, { password: PW })

    expect(result.status).toBe('synced')
    expect(result.pulled).toBe(before)
    expect(d2.localDb.getLocalDbKey()).not.toBeNull()
    expect(await d2.snapshot()).toEqual(await d1.snapshot())
    expect((await d2.snapshot()).expenses).toHaveLength(2)
    expect((await d2.snapshot()).settings.fetchExchangeRates).toBe(false)
  })

  it('shows progress while it pulls', () => {
    const progress = d2.events.flatMap((e) =>
      e.type === 'state' && e.state.status === 'syncing' && e.state.progress ? [e.state.progress] : [],
    )
    expect(progress.some((p) => p.phase === 'pull' && p.done > 0)).toBe(true)
  })

  it('brings the tombstone too, so a later delete elsewhere stays deleted', async () => {
    const { records } = await d2.localDb.listChangedRecords(-1)
    const tomb = records.find((r) => r.id === seed.deletedExpenseId)
    expect(tomb?.deletedAt).toBeTruthy()
  })

  it('registered itself and duplicated nothing on the server', async () => {
    expect(await activeDevices()).toBe(2)
    expect(await serverCount()).toBe((await d1.localDb.listChangedRecords(-1)).records.length)
    const meta = await d2.syncMeta.readSyncMeta()
    expect(d2.syncMeta.isSyncOn(meta)).toBe(true)
    expect(meta.userId).toBe(userId)
    expect(meta.deviceId).toBe(d2.deviceIds.id())
    expect(meta.deviceId).not.toBe(d1.deviceIds.id())
  })

  it('leaves the per-device settings of both devices alone', () => {
    expect(metaSettings(d1).autoLockMinutes).toBe(1)
    expect(metaSettings(d2).autoLockMinutes).toBeUndefined()
    expect('recoveryKeyConfirmed' in metaSettings(d2)).toBe(false)
  })

  it('the restored device unlocks with the same password later', async () => {
    d2.vault.lockVault()
    await d2.vault.unlockWithPassword(PW)
    expect(d2.localDb.getLocalDbKey()).not.toBeNull()
  })

  it('both devices keep syncing in both directions', async () => {
    vi.setSystemTime(new Date('2026-10-24T10:00:00.000Z'))
    const fromD1 = await d1.localDb.addExpense({
      amount: 1111,
      currency: 'UAH',
      categoryId: seed.categoryId,
      description: 'added on the laptop',
      createdAt: '2026-10-24T09:30:00.000Z',
    })
    await d1.actions.syncNow()
    await d2.actions.syncNow()
    expect((await d2.snapshot()).expenses.map((e) => e.id)).toContain(fromD1.id)

    vi.setSystemTime(new Date('2026-10-24T11:00:00.000Z'))
    const fromD2 = await d2.localDb.addIncome({
      categoryId: seed.incomeCategoryId,
      amount: 222,
      currency: 'UAH',
      description: 'added on the phone',
      createdAt: '2026-10-24T10:30:00.000Z',
    })
    await d2.actions.syncNow()
    await d1.actions.syncNow()

    expect((await d1.snapshot()).income.map((i) => i.id)).toContain(fromD2.id)
    expect(await d1.snapshot()).toEqual(await d2.snapshot())
  })

  it('a wrong password keeps being refused with the unlock delay, then the right one works', async () => {
    const d3 = await createSimDevice({ name: 'Tablet', rpc, userId })
    const cloud = await cloudVaultOf(d3)
    for (let i = 0; i < 5; i++) {
      expect(await codeOf(d3.actions.restoreFromCloud(cloud, { password: `wrong ${i}` }))).toBe(
        'incorrect-password',
      )
    }
    expect(await codeOf(d3.actions.restoreFromCloud(cloud, { password: PW }))).toBe('throttled')
    expect(await d3.vault.getVaultState()).toBe('none')

    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'))
    const result = await d3.actions.restoreFromCloud(cloud, { password: PW })
    expect(result.status).toBe('synced')
    expect(await d3.snapshot()).toEqual(await d1.snapshot())
    d3.dispose()
  })

  it('the recovery key works too and sets a new password that is pushed as the cloud header', async () => {
    const d4 = await createSimDevice({ name: 'Desktop', rpc, userId })
    const cloud = await cloudVaultOf(d4)
    expect(await codeOf(d4.actions.restoreFromCloud(cloud, {
      recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GG',
      newPassword: NEW_PW,
    }))).toBe('incorrect-recovery-key')

    const result = await d4.actions.restoreFromCloud(cloud, { recoveryKey, newPassword: NEW_PW })
    expect(result.status).toBe('synced')
    expect(await d4.snapshot()).toEqual(await d1.snapshot())

    const meta = await d4.syncMeta.readSyncMeta()
    expect(meta.headerPending).toBeFalsy()
    const rows = await ctx.admin<{ header_rev: number }>(
      'select header_rev from public.vaults where user_id = $1',
      [userId],
    )
    expect(rows[0].header_rev).toBe(2)

    d4.vault.lockVault()
    expect(await codeOf(d4.vault.unlockWithPassword(PW))).toBe('incorrect-password')
    await d4.vault.unlockWithPassword(NEW_PW)
    expect(d4.localDb.getLocalDbKey()).not.toBeNull()
    d4.dispose()
  })
})
