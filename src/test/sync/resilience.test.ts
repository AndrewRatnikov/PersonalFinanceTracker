// No CONTRACT_GAPs: crash and failure behaviour is specified in plan section 7
// (criteria 5, 6, 32). The records are seeded with applyIncomingRecords (no rev,
// so the first push is the whole snapshot via pushedRev -1) and failures are
// injected by short-circuiting one rpc call on the device.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RpcResponse } from '@/lib/cloud/api'
import type { SyncRecord } from '@/lib/syncRecords'
import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb, wireRecord } from '@/test/sql/harness'
import { cloudVaultOf, createSimDevice } from '@/test/sync/simDevice'
import { deriveSyncKeys, encryptSyncRecord } from '@/lib/cloud/recordCrypto'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const PW = 'resilience password'
const T0 = '2026-10-01T10:00:00.000Z'

let ctx: SqlTestDb

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  ctx = await startDb()
}, 60_000)

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

const NETWORK_DOWN: RpcResponse = {
  data: null,
  error: { message: 'Failed to fetch' },
  status: 0,
}

function bulkRecords(n: number, categoryId: string): Array<SyncRecord> {
  return Array.from({ length: n }, (_, i) => {
    const id = crypto.randomUUID()
    const month = String((i % 12) + 1).padStart(2, '0')
    const createdAt = `2026-${month}-10T09:00:00.000Z`
    return {
      type: 'expense' as const,
      id,
      updatedAt: T0,
      data: {
        id,
        amount: i + 1,
        currency: 'UAH',
        categoryId,
        description: `bulk ${i}`,
        createdAt,
        updatedAt: T0,
      },
    }
  })
}

async function serverCount(userId: string): Promise<number> {
  const rows = await ctx.admin<{ n: number }>(
    'select count(*)::int as n from public.sync_records where user_id = $1',
    [userId],
  )
  return rows[0].n
}

async function newDevice(name: string, userId: string) {
  return createSimDevice({ name, rpc: ctx.rpcAs(userId), userId })
}

describe('an interrupted push resumes without duplicates', () => {
  let userId: string
  let a: SimDevice
  const TOTAL = 1200

  beforeAll(async () => {
    userId = await ctx.createUser()
    a = await newDevice('A', userId)
    await a.createAndUnlockVault(PW)
    const category = await a.localDb.addCategory({ name: 'Food' })
    await a.localDb.applyIncomingRecords(bulkRecords(TOTAL, category.id))
  })

  afterAll(() => {
    a.dispose()
  })

  it('pushedRev does not move when the second of three batches fails', async () => {
    let pushes = 0
    a.intercept = (call) => {
      if (call.fn !== 'push_records') return undefined
      pushes++
      return pushes === 2 ? NETWORK_DOWN : undefined
    }

    const turnOn = await a.actions.turnOn()

    expect(turnOn.kind).toBe('created')
    expect(a.count('push_records')).toBe(2)
    expect(a.engine.getState().status).toBe('error')
    expect(a.engine.getState().errorCode).toBe('network')
    const meta = await a.syncMeta.readSyncMeta()
    expect(meta.pushedRev).toBe(-1)
    expect(meta.lastError).toMatchObject({ code: 'network' })
    expect(await serverCount(userId)).toBe(500)
  })

  it('the next cycle pushes everything again; the server ends with each record once', async () => {
    a.intercept = null
    const before = a.count('push_records')
    const result = await a.actions.syncNow()

    expect(result.status).toBe('synced')
    expect(a.count('push_records') - before).toBe(3)
    expect(result.stale).toBeGreaterThanOrEqual(500)
    const total = (await a.localDb.listChangedRecords(-1)).records.length
    expect(await serverCount(userId)).toBe(total)
    expect(total).toBeGreaterThanOrEqual(TOTAL)

    const meta = await a.syncMeta.readSyncMeta()
    expect(meta.pushedRev).toBe(meta.localRev)
    expect(meta.lastError).toBeNull()
    expect(a.engine.getState().status).toBe('synced')
    const dupes = await ctx.admin<{ n: number }>(
      'select count(*)::int as n from (select record_key from public.sync_records where user_id = $1 group by record_key having count(*) > 1) d',
      [userId],
    )
    expect(dupes[0].n).toBe(0)
  })

  it('the data on the first device is unchanged by the stale answers', async () => {
    expect((await a.localDb.getAllExpenses()).length).toBe(TOTAL)
  })
})

describe('an interrupted pull resumes from pullCursor', () => {
  let userId: string
  let a: SimDevice
  const TOTAL = 1100

  beforeAll(async () => {
    userId = await ctx.createUser()
    a = await newDevice('A', userId)
    await a.createAndUnlockVault(PW)
    const category = await a.localDb.addCategory({ name: 'Food' })
    await a.localDb.applyIncomingRecords(bulkRecords(TOTAL, category.id))
    await a.actions.turnOn()
  })

  afterAll(() => {
    a.dispose()
  })

  it('keeps the first page and the cursor when the second page fails', async () => {
    const b = await newDevice('B', userId)
    let pulls = 0
    b.intercept = (call) => {
      if (call.fn !== 'pull_records') return undefined
      pulls++
      return pulls === 2 ? NETWORK_DOWN : undefined
    }
    const cloud = await cloudVaultOf(b)
    const result = await b.actions.restoreFromCloud(cloud, { password: PW })

    expect(result.status).toBe('error')
    expect(b.count('pull_records')).toBe(2)
    expect(b.engine.getState().errorCode).toBe('network')

    const meta = await b.syncMeta.readSyncMeta()
    const fiveHundredth = await ctx.admin<{ seq: string }>(
      'select seq from public.sync_records where user_id = $1 order by seq limit 1 offset 499',
      [userId],
    )
    expect(meta.pullCursor).toBe(Number(fiveHundredth[0].seq))
    expect(meta.pullCursor).toBeGreaterThan(0)
    const partial = await b.localDb.getAllExpenses()
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(TOTAL)

    // Resume: the next pull starts at the saved cursor, not at 0.
    b.intercept = null
    const callsBefore = b.calls.length
    const resumed = await b.actions.syncNow()
    expect(resumed.status).toBe('synced')
    const firstPull = b.calls.slice(callsBefore).find((c) => c.fn === 'pull_records')
    expect(firstPull?.args.p_since).toBe(meta.pullCursor)
    expect((await b.localDb.getAllExpenses()).length).toBe(TOTAL)
    expect(await b.snapshot()).toEqual(await a.snapshot())
    b.dispose()
  })

  it('applying the same page twice (a crash before the cursor was saved) changes nothing', async () => {
    const b = await newDevice('B2', userId)
    const cloud = await cloudVaultOf(b)
    await b.actions.restoreFromCloud(cloud, { password: PW })
    const before = await b.snapshot()

    // Roll the cursor back as if the app had died before saving it.
    await b.syncMeta.updateSyncMeta({ pullCursor: 0 })
    const result = await b.actions.syncNow()

    expect(result.status).toBe('synced')
    expect(await b.snapshot()).toEqual(before)
    expect((await b.localDb.getAllExpenses()).length).toBe(TOTAL)
    b.dispose()
  })
})

describe('an undecryptable row is skipped, counted and reported', () => {
  it('applies the other rows and does not block the cursor', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    const a = await newDevice('A', userId)
    await a.createAndUnlockVault(PW)
    const category = await a.localDb.addCategory({ name: 'Food' })
    const good = await a.localDb.addExpense({
      amount: 10,
      currency: 'UAH',
      categoryId: category.id,
      description: 'good one',
      createdAt: '2026-10-01T09:00:00.000Z',
    })
    await a.actions.turnOn()

    // Two bad rows from another "device": garbage, and a record sealed with a key
    // of some other vault.
    const header = await a.vault.getVaultHeader()
    const other = crypto.randomUUID()
    await rpc('register_device', { p_device_id: other, p_label: 'Stranger' })
    const foreignKeys = await deriveSyncKeys(crypto.getRandomValues(new Uint8Array(32)))
    const foreign = await encryptSyncRecord(foreignKeys, {
      type: 'expense',
      id: crypto.randomUUID(),
      updatedAt: '2026-10-02T10:00:00.000Z',
      data: { id: 'x', amount: 1, createdAt: '2026-10-02T10:00:00.000Z' },
    })
    const pushed = await rpc('push_records', {
      p_device_id: other,
      p_vault_id: header.vaultId,
      p_records: [wireRecord(1, 5000), foreign],
    })
    expect(pushed.error).toBeNull()

    // A second device that also has a good new record waiting on the server.
    const b = await newDevice('B', userId)
    const cloud = await cloudVaultOf(b)
    const restored = await b.actions.restoreFromCloud(cloud, { password: PW })

    expect(restored.status).toBe('synced')
    expect(restored.skipped).toBe(2)
    expect((await b.localDb.getAllExpenses()).map((e) => e.id)).toEqual([good.id])
    const meta = await b.syncMeta.readSyncMeta()
    expect(meta.lastError).toMatchObject({ code: 'undecryptable', count: 2 })
    expect(b.engine.getState().lastError).toMatchObject({ code: 'undecryptable', count: 2 })

    const maxSeq = await ctx.admin<{ m: string }>(
      'select max(seq) as m from public.sync_records where user_id = $1',
      [userId],
    )
    expect(meta.pullCursor).toBe(Number(maxSeq[0].m))

    // The next cycle does not read the bad rows again and the report clears.
    const next = await b.actions.syncNow()
    expect(next.skipped).toBe(0)
    expect((await b.syncMeta.readSyncMeta()).lastError).toBeNull()
    a.dispose()
    b.dispose()
  })

  it('one good row among many bad ones still arrives', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    const a = await newDevice('A', userId)
    await a.createAndUnlockVault(PW)
    await a.actions.turnOn()
    const header = await a.vault.getVaultHeader()
    const keys = await a.vault.getSyncKeys()
    const other = crypto.randomUUID()
    await rpc('register_device', { p_device_id: other, p_label: 'Stranger' })
    const id = crypto.randomUUID()
    const goodWire = await encryptSyncRecord(keys, {
      type: 'expense',
      id,
      updatedAt: '2026-10-03T10:00:00.000Z',
      data: {
        id,
        amount: 77,
        currency: 'UAH',
        categoryId: 'c',
        createdAt: '2026-10-03T10:00:00.000Z',
        updatedAt: '2026-10-03T10:00:00.000Z',
      },
    })
    await rpc('push_records', {
      p_device_id: other,
      p_vault_id: header.vaultId,
      p_records: [wireRecord(11, 1000), wireRecord(12, 1000), goodWire, wireRecord(13, 1000)],
    })

    const result = await a.actions.syncNow()

    expect(result.skipped).toBe(3)
    expect((await a.localDb.getAllExpenses()).map((e) => e.id)).toEqual([id])
    expect((await a.syncMeta.readSyncMeta()).lastError).toMatchObject({ code: 'undecryptable', count: 3 })
    a.dispose()
  })
})
