// No CONTRACT_GAPs: header changes are specified in plan sections 4, 7 and 8
// (criteria 17 and 18, decision D5). A header change on a synced device marks
// the header pending and asks the engine for a cycle (connectHeaderChanges), so
// the tests wait for the server to show the new header rev. Another account's
// "foreign header" is a header from a different vault forced onto this vault id.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { storeState } from '@/test/sync/memoryIdb'
import { createSimDevice, createSyncedPair } from '@/test/sync/simDevice'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const PW = 'header password'
const PW_A = 'password chosen on A'
const PW_B = 'password chosen on B'

let ctx: SqlTestDb
const devices: Array<SimDevice> = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  ctx = await startDb()
}, 60_000)

afterEach(() => {
  for (const d of devices.splice(0)) d.dispose()
})

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

async function pair() {
  const p = await createSyncedPair(ctx, PW, true)
  devices.push(p.a, p.b)
  return p
}

async function serverHeader(userId: string): Promise<{ rev: number; header: Record<string, unknown> }> {
  const rows = await ctx.admin<{ header_rev: number; header: Record<string, unknown> }>(
    'select header_rev, header from public.vaults where user_id = $1',
    [userId],
  )
  return { rev: rows[0].header_rev, header: rows[0].header }
}

// Polls with real timers (Date is frozen, so no deadline arithmetic on it).
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code
}

function updateCalls(d: SimDevice) {
  return d.calls.filter((c) => c.fn === 'update_vault_header')
}

describe('a password change on a synced device', () => {
  it('is pushed with the expected header rev and clears the pending flag', async () => {
    const p = await pair()
    expect((await serverHeader(p.userId)).rev).toBe(1)

    await p.a.vault.changePassword(PW, PW_A)
    await until(async () => (await serverHeader(p.userId)).rev === 2, 'header rev 2')

    const calls = updateCalls(p.a)
    expect(calls).toHaveLength(1)
    expect(calls[0].args.p_expected_rev).toBe(1)
    const local = await p.a.vault.getVaultHeader()
    expect((await serverHeader(p.userId)).header).toEqual(local)
    await until(async () => (await p.a.syncMeta.readSyncMeta()).headerPending === false, 'pending cleared')
    expect((await p.a.syncMeta.readSyncMeta()).headerRev).toBe(2)
  })

  it('a second device adopts it at the start of its next cycle, keeps its counters and shows a notice', async () => {
    const p = await pair()
    const store = storeState(p.b.store())
    store.data.set('meta:settings', {
      ...((store.data.get('meta:settings') ?? {}) as Record<string, unknown>),
      failedUnlockAttempts: 2,
      unlockBlockedUntil: null,
    })
    await p.a.vault.changePassword(PW, PW_A)
    await until(async () => (await serverHeader(p.userId)).rev === 2, 'header rev 2')

    const result = await p.b.actions.syncNow()

    expect(result.status).toBe('synced')
    expect(p.b.events.some((e) => e.type === 'header-adopted')).toBe(true)
    expect(await p.b.vault.getVaultHeader()).toEqual(await p.a.vault.getVaultHeader())
    expect((await p.b.syncMeta.readSyncMeta()).headerRev).toBe(2)
    expect((store.data.get('meta:settings') as Record<string, unknown>).failedUnlockAttempts).toBe(2)
    // Still unlocked: nothing changed for the running session.
    expect(p.b.localDb.getLocalDbKey()).not.toBeNull()

    // The next unlock needs the new password.
    p.b.vault.lockVault()
    expect(await codeOf(p.b.vault.unlockWithPassword(PW))).toBe('incorrect-password')
    await p.b.vault.unlockWithPassword(PW_A)
    expect(p.b.localDb.getLocalDbKey()).not.toBeNull()
  })

  it('no notice and no fetch when the header did not change', async () => {
    const p = await pair()
    const mark = p.b.calls.length
    await p.b.actions.syncNow()
    expect(p.b.events.some((e) => e.type === 'header-adopted')).toBe(false)
    expect(p.b.calls.slice(mark).map((c) => c.fn)).not.toContain('get_vault')
  })

  it('a new recovery key is pushed too, and the other device accepts it', async () => {
    const p = await pair()
    const { recoveryKey } = await p.a.vault.regenerateRecoveryKey(PW)
    await until(async () => (await serverHeader(p.userId)).rev === 2, 'header rev 2')

    await p.b.actions.syncNow()

    expect(p.b.events.some((e) => e.type === 'header-adopted')).toBe(true)
    p.b.vault.lockVault()
    expect(await codeOf(p.b.vault.unlockWithRecoveryKey(p.recoveryKey))).toBe('incorrect-recovery-key')
    await p.b.vault.unlockWithRecoveryKey(recoveryKey)
    expect(p.b.localDb.getLocalDbKey()).not.toBeNull()
  })

  it('a reset with the recovery key (vault locked) is pushed by the next cycle', async () => {
    const p = await pair()
    p.a.vault.lockVault()
    await p.a.vault.resetPasswordWithRecoveryKey(p.recoveryKey, PW_A)

    await p.a.actions.syncNow()
    await until(async () => (await serverHeader(p.userId)).rev === 2, 'header rev 2')

    await p.b.actions.syncNow()
    p.b.vault.lockVault()
    await p.b.vault.unlockWithPassword(PW_A)
    expect(p.b.localDb.getLocalDbKey()).not.toBeNull()
  })
})

describe('a header change that cannot be pushed yet', () => {
  it('offline: stays pending, nothing is called, and goes out when the device is back', async () => {
    const p = await pair()
    p.a.state.online = false
    const mark = p.a.calls.length

    await p.a.vault.changePassword(PW, PW_A)
    await until(async () => (await p.a.syncMeta.readSyncMeta()).headerPending === true, 'pending flag')

    expect((await serverHeader(p.userId)).rev).toBe(1)
    expect(p.a.calls.length).toBe(mark)

    p.a.state.online = true
    const result = await p.a.actions.syncNow()
    if (result.ran) expect(result.status).toBe('synced')
    await until(async () => (await serverHeader(p.userId)).rev === 2, 'header rev 2')
    await until(async () => (await p.a.syncMeta.readSyncMeta()).headerPending === false, 'pending cleared')
  })
})

describe('two devices change the header', () => {
  it('on header_conflict the second adopts the cloud rev and retries once; the later change wins', async () => {
    const p = await pair()
    await p.a.vault.changePassword(PW, PW_A)
    await until(async () => (await serverHeader(p.userId)).rev === 2, 'header rev 2')

    // B has not synced since: it still thinks the header rev is 1.
    expect((await p.b.syncMeta.readSyncMeta()).headerRev).toBe(1)
    await p.b.vault.changePassword(PW, PW_B)
    await until(async () => (await serverHeader(p.userId)).rev === 3, 'header rev 3')

    const calls = updateCalls(p.b)
    expect(calls.map((c) => c.args.p_expected_rev)).toEqual([1, 2])
    expect(p.b.calls.map((c) => c.fn)).toContain('get_vault')
    expect((await serverHeader(p.userId)).header).toEqual(await p.b.vault.getVaultHeader())
    await until(async () => (await p.b.syncMeta.readSyncMeta()).headerPending === false, 'pending cleared')
    expect((await p.b.syncMeta.readSyncMeta()).headerRev).toBe(3)

    // A then adopts B's header: the last writer wins for the whole header.
    await p.a.actions.syncNow()
    expect(p.a.events.some((e) => e.type === 'header-adopted')).toBe(true)
    expect(await p.a.vault.getVaultHeader()).toEqual(await p.b.vault.getVaultHeader())
    p.a.vault.lockVault()
    expect(await codeOf(p.a.vault.unlockWithPassword(PW_A))).toBe('incorrect-password')
    await p.a.vault.unlockWithPassword(PW_B)
  })
})

describe('a cloud header that wraps another key', () => {
  async function plantForeignHeader(p: Awaited<ReturnType<typeof pair>>) {
    // A separate vault (its own DEK) whose header is forced onto this vault id.
    const other = await createSimDevice({ name: 'Other', rpc: p.rpc, userId: p.userId })
    devices.push(other)
    await other.createAndUnlockVault('some other password')
    const otherHeader = await other.vault.getVaultHeader()
    const vaultId = (await p.a.vault.getVaultHeader()).vaultId
    const strangerDevice = crypto.randomUUID()
    expect((await p.rpc('register_device', { p_device_id: strangerDevice, p_label: 'Stranger' })).error).toBeNull()
    const res = await p.rpc('update_vault_header', {
      p_device_id: strangerDevice,
      p_vault_id: vaultId,
      p_header: { ...otherHeader, vaultId },
      p_expected_rev: (await serverHeader(p.userId)).rev,
    })
    expect(res.error).toBeNull()
  }

  it('is vault-mismatch: nothing is adopted, pulled or pushed', async () => {
    const p = await pair()
    await plantForeignHeader(p)
    const header = await p.a.vault.getVaultHeader()
    const before = await p.a.snapshot()
    const pulls = p.a.count('pull_records')
    const pushes = p.a.count('push_records')

    await p.a.localDb.addExpense({
      amount: 8,
      currency: 'UAH',
      categoryId: p.seed!.categoryId,
      description: 'must not be pushed',
      createdAt: '2026-10-22T09:00:00.000Z',
    })
    const result = await p.a.actions.syncNow()

    expect(result.status).toBe('vault-mismatch')
    expect(p.a.engine.getState().status).toBe('vault-mismatch')
    expect(p.a.events.some((e) => e.type === 'header-adopted')).toBe(false)
    expect(await p.a.vault.getVaultHeader()).toEqual(header)
    expect(p.a.count('pull_records')).toBe(pulls)
    expect(p.a.count('push_records')).toBe(pushes)
    expect((await p.a.syncMeta.readSyncMeta()).headerRev).toBe(1)
    expect((await p.a.localDb.getAllExpenses()).length).toBe(before.expenses.length + 1)

    // It stays that way, and Turn off sync is the way out; local data is kept.
    expect((await p.a.actions.syncNow()).status).toBe('vault-mismatch')
    await p.a.actions.turnOff({ removeDevice: false })
    expect(p.a.engine.getState().status).toBe('off')
    expect((await p.a.localDb.getAllExpenses()).length).toBe(before.expenses.length + 1)
  })

  it('a pending password change meeting a foreign header is vault-mismatch and is not retried', async () => {
    const p = await pair()
    await plantForeignHeader(p)
    await p.a.vault.changePassword(PW, PW_A)

    await until(async () => p.a.engine.getState().status === 'vault-mismatch', 'vault-mismatch')

    expect(updateCalls(p.a)).toHaveLength(1)
    expect((await serverHeader(p.userId)).rev).toBe(2)
    expect((await p.a.syncMeta.readSyncMeta()).headerPending).toBe(true)
  })
})

describe('header changes while sync is off', () => {
  it('touch no sync field and call nothing', async () => {
    const userId = await ctx.createUser()
    const d = await createSimDevice({ name: 'Solo', rpc: ctx.rpcAs(userId), userId })
    devices.push(d)
    await d.createAndUnlockVault(PW)

    await d.vault.changePassword(PW, PW_A)
    await Promise.resolve()

    expect(d.calls).toHaveLength(0)
    const meta = await d.syncMeta.readSyncMeta()
    expect(meta.headerPending).toBeUndefined()
    expect(d.syncMeta.isSyncOn(meta)).toBe(false)
  })
})
