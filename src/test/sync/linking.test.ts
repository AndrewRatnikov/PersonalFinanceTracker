// No CONTRACT_GAPs: the linking flows are specified in plan sections 3, 4 and 8
// (criterion 15, decisions D3 and D7). Device A owns the cloud vault (password
// CLOUD_PW). Device L is a third device with its own vault and data (password
// LOCAL_PW) of the same Google user, so turning sync on there finds a cloud
// vault with a different id.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SyncRecord } from '@/lib/syncRecords'
import type { SimDevice, SyncedPair } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { failNextSetMany } from '@/test/sync/memoryIdb'
import { cloudVaultOf, createSimDevice, createSyncedPair } from '@/test/sync/simDevice'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const CLOUD_PW = 'the cloud password'
const LOCAL_PW = 'the local password'
const CLOUD_TIME = '2026-10-10T09:00:00.000Z'
const NEWER = '2026-10-15T09:00:00.000Z'
const OLDER = '2026-10-05T09:00:00.000Z'
const LATER = '2026-10-20T09:00:00.000Z'

let ctx: SqlTestDb
const devices: Array<SimDevice> = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(CLOUD_TIME))
  ctx = await startDb()
}, 60_000)

afterEach(() => {
  for (const d of devices.splice(0)) d.dispose()
})

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

function at(iso: string) {
  vi.setSystemTime(new Date(iso))
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code
}

async function serverRecords(userId: string): Promise<number> {
  const rows = await ctx.admin<{ n: number }>(
    'select count(*)::int as n from public.sync_records where user_id = $1',
    [userId],
  )
  return rows[0].n
}

async function serverVaultId(userId: string): Promise<string | undefined> {
  const rows = await ctx.admin<{ vault_id: string }>(
    'select vault_id from public.vaults where user_id = $1',
    [userId],
  )
  return rows[0]?.vault_id
}

interface Scenario {
  p: SyncedPair
  l: SimDevice
  localOnlyExpenseId: string
  deletedLocalId: string
  e1: string
  e2: string
  cloudAmounts: { e1: number; e2: number }
}

// A and B share the cloud vault; L has its own vault with: an entry only L
// knows, a deleted entry, a NEWER copy of cloud expense e1 and an OLDER copy of
// cloud expense e2 (same ids, as after a backup restore).
async function scenario(): Promise<Scenario> {
  at(CLOUD_TIME)
  const p = await createSyncedPair(ctx, CLOUD_PW, true)
  devices.push(p.a, p.b)
  const [e1, e2] = p.seed!.expenseIds
  const cloudRecords = (await p.a.localDb.listChangedRecords(-1)).records
  const cloud1 = cloudRecords.find((r) => r.id === e1) as SyncRecord
  const cloud2 = cloudRecords.find((r) => r.id === e2) as SyncRecord

  const l = await createSimDevice({ name: 'L', rpc: p.rpc, userId: p.userId })
  devices.push(l)
  await l.createAndUnlockVault(LOCAL_PW)
  at(OLDER)
  const localCategory = await l.localDb.addCategory({ name: 'Local only category' })
  const only = await l.localDb.addExpense({
    amount: 31337,
    currency: 'UAH',
    categoryId: localCategory.id,
    description: 'only on the local device',
    createdAt: '2026-10-04T09:00:00.000Z',
  })
  const doomed = await l.localDb.addExpense({
    amount: 1,
    currency: 'UAH',
    categoryId: localCategory.id,
    description: 'deleted before joining',
    createdAt: '2026-10-04T10:00:00.000Z',
  })
  await l.localDb.deleteExpense(doomed.id, doomed.createdAt)
  await l.localDb.applyIncomingRecords([
    { ...cloud1, updatedAt: NEWER, data: { ...cloud1.data, amount: 777777, updatedAt: NEWER } },
    { ...cloud2, updatedAt: OLDER, data: { ...cloud2.data, amount: 555555, updatedAt: OLDER } },
  ])
  at(LATER)
  return {
    p,
    l,
    localOnlyExpenseId: only.id,
    deletedLocalId: doomed.id,
    e1,
    e2,
    cloudAmounts: { e1: cloud1.data.amount as number, e2: cloud2.data.amount as number },
  }
}

describe('turning sync on where the cloud has another vault', () => {
  it('asks to link and changes nothing until the user chooses (Cancel)', async () => {
    const s = await scenario()
    const records = await serverRecords(s.p.userId)
    const header = await s.l.vault.getVaultHeader()

    const result = await s.l.actions.turnOn()

    expect(result.kind).toBe('needs-link')
    if (result.kind === 'needs-link') {
      expect(result.cloud.vault_id).not.toBe(header.vaultId)
      expect(result.cloud.vault_id).toBe(await serverVaultId(s.p.userId))
    }
    expect(s.l.syncMeta.isSyncOn(await s.l.syncMeta.readSyncMeta())).toBe(false)
    expect(await serverRecords(s.p.userId)).toBe(records)
    expect(s.l.count('push_records')).toBe(0)
    expect(s.l.count('pull_records')).toBe(0)
    expect(await s.l.vault.getVaultHeader()).toEqual(header)
  })
})

describe('Join cloud data and keep this device’s entries', () => {
  it('merges by newest edit and loses nothing', async () => {
    const s = await scenario()
    const turnOn = await s.l.actions.turnOn()
    if (turnOn.kind !== 'needs-link') throw new Error('expected needs-link')

    const result = await s.l.actions.joinAndKeep(turnOn.cloud, CLOUD_PW)

    expect(result.status).toBe('synced')
    const header = await s.p.a.vault.getVaultHeader()
    expect(await s.l.vault.getVaultHeader()).toEqual(header)
    const meta = await s.l.syncMeta.readSyncMeta()
    expect(s.l.syncMeta.isSyncOn(meta)).toBe(true)
    expect(meta.vaultId).toBe(header.vaultId)
    expect(meta.pushedRev).toBe(meta.localRev)

    const onL = await s.l.localDb.getAllExpenses()
    const byId = new Map(onL.map((e) => [e.id, e]))
    // Newest edit wins per record: the local copy of e1 is newer, the cloud copy of e2 is.
    expect(byId.get(s.e1)?.amount).toBe(777777)
    expect(byId.get(s.e2)?.amount).toBe(s.cloudAmounts.e2)
    expect(s.cloudAmounts.e2).not.toBe(555555)
    // The entry only this device had is kept, with its id and edit time.
    expect(byId.get(s.localOnlyExpenseId)?.amount).toBe(31337)
    expect(byId.get(s.localOnlyExpenseId)?.updatedAt).toBe(OLDER)

    // Everything the other device had is there too.
    await s.p.a.actions.syncNow()
    const onA = await s.p.a.localDb.getAllExpenses()
    expect(onA.map((e) => e.id).sort()).toEqual(onL.map((e) => e.id).sort())
    expect(onA.find((e) => e.id === s.e1)?.amount).toBe(777777)
    expect(onA.find((e) => e.id === s.localOnlyExpenseId)?.amount).toBe(31337)
    expect((await s.p.a.localDb.getAllCategories()).some((c) => c.name === 'Local only category')).toBe(true)

    await s.l.actions.syncNow()
    expect(await s.l.snapshot()).toEqual(await s.p.a.snapshot())
  })

  it('does not bring a tombstone of the old vault into the cloud', async () => {
    const s = await scenario()
    const turnOn = await s.l.actions.turnOn()
    if (turnOn.kind !== 'needs-link') throw new Error('expected needs-link')
    await s.l.actions.joinAndKeep(turnOn.cloud, CLOUD_PW)
    await s.p.a.actions.syncNow()

    for (const d of [s.l, s.p.a]) {
      const all = (await d.localDb.listChangedRecords(-1)).records
      expect(all.some((r) => r.id === s.deletedLocalId)).toBe(false)
    }
  })

  it('the device afterwards unlocks only with the cloud password and the third device sees the entries', async () => {
    const s = await scenario()
    const turnOn = await s.l.actions.turnOn()
    if (turnOn.kind !== 'needs-link') throw new Error('expected needs-link')
    await s.l.actions.joinAndKeep(turnOn.cloud, CLOUD_PW)

    s.l.vault.lockVault()
    expect(await codeOf(s.l.vault.unlockWithPassword(LOCAL_PW))).toBe('incorrect-password')
    await s.l.vault.unlockWithPassword(CLOUD_PW)
    expect((await s.l.localDb.getAllExpenses()).length).toBeGreaterThan(0)

    await s.p.b.actions.syncNow()
    expect((await s.p.b.localDb.getAllExpenses()).some((e) => e.id === s.localOnlyExpenseId)).toBe(true)
  })

  it('a wrong cloud password leaves the old vault exactly as it was', async () => {
    const s = await scenario()
    const turnOn = await s.l.actions.turnOn()
    if (turnOn.kind !== 'needs-link') throw new Error('expected needs-link')
    const header = await s.l.vault.getVaultHeader()
    const before = await s.l.snapshot()
    const records = await serverRecords(s.p.userId)

    expect(await codeOf(s.l.actions.joinAndKeep(turnOn.cloud, 'wrong password'))).toBe(
      'incorrect-password',
    )

    expect(await s.l.vault.getVaultHeader()).toEqual(header)
    expect(await s.l.snapshot()).toEqual(before)
    expect(s.l.syncMeta.isSyncOn(await s.l.syncMeta.readSyncMeta())).toBe(false)
    expect(await serverRecords(s.p.userId)).toBe(records)
    expect(s.l.count('pull_records')).toBe(0)
    s.l.vault.lockVault()
    await s.l.vault.unlockWithPassword(LOCAL_PW)
  })

  it('a failure injected before the commit leaves the old vault unlockable and sync off', async () => {
    const s = await scenario()
    const turnOn = await s.l.actions.turnOn()
    if (turnOn.kind !== 'needs-link') throw new Error('expected needs-link')
    const header = await s.l.vault.getVaultHeader()
    const before = await s.l.snapshot()
    const records = await serverRecords(s.p.userId)

    failNextSetMany(s.l.store())
    await expect(s.l.actions.joinAndKeep(turnOn.cloud, CLOUD_PW)).rejects.toThrow()

    expect(await s.l.vault.getVaultHeader()).toEqual(header)
    expect(await s.l.snapshot()).toEqual(before)
    expect(s.l.syncMeta.isSyncOn(await s.l.syncMeta.readSyncMeta())).toBe(false)
    expect(await serverRecords(s.p.userId)).toBe(records)
    s.l.vault.lockVault()
    await s.l.vault.unlockWithPassword(LOCAL_PW)
    expect((await s.l.localDb.getAllExpenses()).map((e) => e.id)).toContain(s.localOnlyExpenseId)
  })

  it('works again after the failed attempt', async () => {
    const s = await scenario()
    const turnOn = await s.l.actions.turnOn()
    if (turnOn.kind !== 'needs-link') throw new Error('expected needs-link')
    failNextSetMany(s.l.store())
    await expect(s.l.actions.joinAndKeep(turnOn.cloud, CLOUD_PW)).rejects.toThrow()

    const result = await s.l.actions.joinAndKeep(turnOn.cloud, CLOUD_PW)
    expect(result.status).toBe('synced')
    expect((await s.l.localDb.getAllExpenses()).map((e) => e.id)).toContain(s.localOnlyExpenseId)
  })
})

describe('Replace cloud data with this device', () => {
  it('needs DELETE typed exactly and calls nothing otherwise', async () => {
    const s = await scenario()
    const records = await serverRecords(s.p.userId)
    const mark = s.l.calls.length

    for (const wrong of ['', 'delete', 'DELETE ', 'yes']) {
      expect(await codeOf(s.l.actions.replaceCloud(wrong))).toBe('confirmation_required')
    }

    expect(s.l.calls.length).toBe(mark)
    expect(await serverRecords(s.p.userId)).toBe(records)
  })

  it('empties the cloud, uploads this device and leaves the old owner on cloud-deleted with its data', async () => {
    const s = await scenario()
    const header = await s.l.vault.getVaultHeader()
    const aBefore = await s.p.a.snapshot()

    const result = await s.l.actions.replaceCloud('DELETE')

    expect(result.status).toBe('synced')
    expect(await serverVaultId(s.p.userId)).toBe(header.vaultId)
    const local = (await s.l.localDb.listChangedRecords(-1)).records.length
    expect(await serverRecords(s.p.userId)).toBe(local)
    expect(s.l.syncMeta.isSyncOn(await s.l.syncMeta.readSyncMeta())).toBe(true)

    // The old owner meets an empty-then-different cloud: its copy is gone.
    const seen = await s.p.a.actions.syncNow()
    expect(seen.status).toBe('cloud-deleted')
    expect(await s.p.a.snapshot()).toEqual(aBefore)
    expect(await s.p.b.actions.syncNow().then((r) => r.status)).toBe('cloud-deleted')

    // "Upload again" there now meets a different vault and asks to link.
    const again = await s.p.a.actions.uploadAgain()
    expect(again.kind).toBe('needs-link')
  })

  it('another device that links afterwards gets this device’s data only', async () => {
    const s = await scenario()
    await s.l.actions.replaceCloud('DELETE')

    const fresh = await createSimDevice({ name: 'N', rpc: s.p.rpc, userId: s.p.userId })
    devices.push(fresh)
    const cloud = await cloudVaultOf(fresh)
    await fresh.actions.restoreFromCloud(cloud, { password: LOCAL_PW })

    const byId = new Map((await fresh.localDb.getAllExpenses()).map((e) => [e.id, e]))
    expect(byId.get(s.localOnlyExpenseId)?.amount).toBe(31337)
    // The old cloud's copy of e2 is gone; this device's older copy is what is stored now.
    expect(byId.get(s.e2)?.amount).toBe(555555)
    expect(byId.get(s.e2)?.amount).not.toBe(s.cloudAmounts.e2)
    expect(await fresh.snapshot()).toEqual(await s.l.snapshot())
  })
})
