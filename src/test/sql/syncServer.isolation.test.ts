// @vitest-environment node
// No CONTRACT_GAPs: isolation rules are specified in plan section 3
// (privileges, policies, device check) and acceptance criterion 5.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  expectMinima,
  expectOk,
  expectPermissionDenied,
  pull,
  push,
  startDb,
  userWithVault,
  validHeader,
  wireRecord,
} from './harness'
import type { Fixture, SqlTestDb } from './harness'

let ctx: SqlTestDb
let a: Fixture
let b: Fixture

// Both users write a record under the SAME record_key but different content.
const SHARED_KEY = wireRecord(1)
const A_ONLY = wireRecord(2)
const B_ONLY = wireRecord(3)

beforeAll(async () => {
  ctx = await startDb()
  a = await userWithVault(ctx)
  b = await userWithVault(ctx)
  expectOk(await push(a, [{ ...SHARED_KEY, ciphertext: 'A'.repeat(24) }, A_ONLY]))
  expectOk(await push(b, [{ ...SHARED_KEY, ciphertext: 'B'.repeat(24) }, B_ONLY]))
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

describe('table reads are scoped to the caller', () => {
  it('entitlements, vaults and devices show only the caller rows', async () => {
    for (const table of ['entitlements', 'vaults', 'devices']) {
      const rowsA = await ctx.asUser<{ user_id: string }>(
        a.userId,
        `select user_id from public.${table}`,
      )
      expect(rowsA.length, table).toBeGreaterThan(0)
      expect(new Set(rowsA.map((r) => r.user_id)), table).toEqual(
        new Set([a.userId]),
      )

      const rowsB = await ctx.asUser<{ user_id: string }>(
        b.userId,
        `select user_id from public.${table}`,
      )
      expect(new Set(rowsB.map((r) => r.user_id)), table).toEqual(
        new Set([b.userId]),
      )
    }
  })

  it("A cannot select B's rows even by asking for them", async () => {
    for (const table of ['entitlements', 'vaults', 'devices']) {
      const rows = await ctx.asUser(
        a.userId,
        `select 1 from public.${table} where user_id = $1`,
        [b.userId],
      )
      expect(rows, table).toHaveLength(0)
    }
  })

  it('sync_records and app_config cannot be read directly', async () => {
    await expectPermissionDenied(
      ctx.asUser(a.userId, 'select * from public.sync_records'),
    )
    await expectPermissionDenied(
      ctx.asUser(a.userId, 'select * from public.app_config'),
    )
  })

  it('anon cannot read any of the user tables', async () => {
    for (const table of ['entitlements', 'vaults', 'devices', 'sync_records']) {
      await expectPermissionDenied(ctx.asAnon(`select * from public.${table}`))
    }
  })
})

describe('writes are refused', () => {
  it('A cannot insert or update entitlements', async () => {
    await expectPermissionDenied(
      ctx.asUser(
        a.userId,
        `insert into public.entitlements (user_id, plan_id, status, source)
         values ($1, 'sync', 'active', 'manual')`,
        [crypto.randomUUID()],
      ),
    )
    await expectPermissionDenied(
      ctx.asUser(a.userId, "update public.entitlements set plan_id = 'sync'"),
    )
    const rows = await ctx.admin<{ plan_id: string }>(
      'select plan_id from public.entitlements where user_id = $1',
      [a.userId],
    )
    expect(rows[0].plan_id).toBe('free')
  })

  it('A cannot insert or update app_config', async () => {
    await expectPermissionDenied(
      ctx.asUser(
        a.userId,
        "update public.app_config set value = 'false'::jsonb where key = 'sync_free_for_all'",
      ),
    )
    await expectPermissionDenied(
      ctx.asUser(
        a.userId,
        "insert into public.app_config (key, value) values ('x', '1'::jsonb)",
      ),
    )
    const rows = await ctx.admin<{ value: unknown }>(
      "select value from public.app_config where key = 'sync_free_for_all'",
    )
    expect(rows[0].value).toBe(true)
  })

  it('A cannot write vaults, devices, sync_records or plans directly', async () => {
    await expectPermissionDenied(
      ctx.asUser(a.userId, 'update public.vaults set last_seq = 999'),
    )
    await expectPermissionDenied(
      ctx.asUser(a.userId, 'delete from public.devices'),
    )
    await expectPermissionDenied(
      ctx.asUser(a.userId, 'delete from public.sync_records'),
    )
    await expectPermissionDenied(
      ctx.asUser(a.userId, "update public.plans set features = '{}'::jsonb"),
    )
  })
})

describe('functions never cross users', () => {
  it('pull_records returns only the caller rows, even for a shared record_key', async () => {
    const resA = expectOk<{ records: Array<{ record_key: string; ciphertext: string }> }>(
      await pull(a, 0),
    )
    const keysA = resA.records.map((r) => r.record_key).sort()
    expect(keysA).toEqual([SHARED_KEY.record_key, A_ONLY.record_key].sort())
    expect(keysA).not.toContain(B_ONLY.record_key)
    const sharedA = resA.records.find((r) => r.record_key === SHARED_KEY.record_key)
    expect(sharedA?.ciphertext).toBe('A'.repeat(24))

    const resB = expectOk<{ records: Array<{ record_key: string; ciphertext: string }> }>(
      await pull(b, 0),
    )
    expect(resB.records.map((r) => r.record_key)).not.toContain(A_ONLY.record_key)
    const sharedB = resB.records.find((r) => r.record_key === SHARED_KEY.record_key)
    expect(sharedB?.ciphertext).toBe('B'.repeat(24))
  })

  it('get_vault, list_devices and get_sync_status show only the caller', async () => {
    const vaultA = expectOk<{ vault_id: string }>(await a.rpc('get_vault'))
    expect(vaultA.vault_id).toBe(a.vaultId)
    expect(vaultA.vault_id).not.toBe(b.vaultId)

    const devicesA = expectOk<Array<{ device_id: string }>>(await a.rpc('list_devices'))
    expect(devicesA.map((d) => d.device_id)).toEqual([a.deviceId])

    const status = expectOk<{
      devices_count: number
      vault: { vault_id: string; record_count: number } | null
    }>(await a.rpc('get_sync_status'))
    expect(status.devices_count).toBe(1)
    expect(status.vault?.vault_id).toBe(a.vaultId)
    expect(status.vault?.record_count).toBe(2)
  })

  it("A cannot use B's device id for any call", async () => {
    expectMinima(await push(a, [wireRecord(9)], b.deviceId), 'device_not_registered')
    expectMinima(await pull(a, 0, undefined, b.deviceId), 'device_not_registered')
    expectMinima(
      await a.rpc('create_vault', {
        p_device_id: b.deviceId,
        p_vault_id: 'other',
        p_header: validHeader('other'),
      }),
      'device_not_registered',
    )
  })

  it("A cannot rename or remove B's device", async () => {
    expectMinima(
      await a.rpc('rename_device', { p_device_id: b.deviceId, p_label: 'Hijacked' }),
      'device_not_registered',
    )
    expectMinima(
      await a.rpc('remove_device', { p_device_id: b.deviceId }),
      'device_not_registered',
    )
    const rows = await ctx.admin<{ label: string; removed_at: string | null }>(
      'select label, removed_at from public.devices where device_id = $1',
      [b.deviceId],
    )
    expect(rows[0].label).toBe('Test device')
    expect(rows[0].removed_at).toBeNull()
  })

  it("A pushing to B's vault id gets vault_mismatch and writes nothing", async () => {
    const res = await a.rpc('push_records', {
      p_device_id: a.deviceId,
      p_vault_id: b.vaultId,
      p_records: [wireRecord(10)],
    })
    expectMinima(res, 'vault_mismatch')
    const rows = await ctx.admin(
      'select 1 from public.sync_records where record_key = $1',
      [wireRecord(10).record_key],
    )
    expect(rows).toHaveLength(0)
  })

  it("A's delete_cloud_data leaves B untouched", async () => {
    const c = await userWithVault(ctx)
    expectOk(await push(c, [wireRecord(20), wireRecord(21)]))
    const res = expectOk<{ deleted_records: number }>(
      await c.rpc('delete_cloud_data'),
    )
    expect(res.deleted_records).toBe(2)

    const status = expectOk<{ vault: { record_count: number } | null }>(
      await b.rpc('get_sync_status'),
    )
    expect(status.vault?.record_count).toBe(2)
    expect(expectOk<{ records: Array<unknown> }>(await pull(b, 0)).records).toHaveLength(2)
  })
})
