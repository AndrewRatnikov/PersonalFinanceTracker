// @vitest-environment node
// No CONTRACT_GAPs: effective_plan / has_feature / get_sync_status / device and
// vault behaviour are specified in plan section 3 (decisions D4 to D6) and
// acceptance criteria 6 to 10.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  expectMinima,
  expectOk,
  newDeviceId,
  pull,
  push,
  setFreeForAll,
  startDb,
  userWithVault,
  validHeader,
  wireRecord,
} from './harness'
import type { SqlTestDb } from './harness'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

afterEach(async () => {
  await setFreeForAll(ctx, true)
})

interface Status {
  plan_id: string
  has_sync: boolean
  free_for_all: boolean
  granted_by: string
  beta_joined_at: string | null
  entitlement_status: string | null
  current_period_end: string | null
  limits: Record<string, unknown>
  vault: Record<string, unknown> | null
  devices_count: number
}

async function grant(
  userId: string,
  planId: string,
  status: string,
  periodEnd: string | null,
): Promise<void> {
  await ctx.admin(
    `insert into public.entitlements (user_id, plan_id, status, source, current_period_end)
     values ($1, $2, $3, 'manual', ${periodEnd === null ? 'null' : `now() + interval '${periodEnd}'`})
     on conflict (user_id) do update
       set plan_id = excluded.plan_id, status = excluded.status,
           current_period_end = excluded.current_period_end`,
    [userId, planId, status],
  )
}

async function planOf(userId: string): Promise<unknown> {
  return expectOk(await ctx.rpcAs(userId)('effective_plan'))
}

describe('beta switch on (criterion 6)', () => {
  it('a user with no entitlement has plan beta and sync', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)

    expect(expectOk(await rpc('effective_plan'))).toBe('beta')
    expect(expectOk(await rpc('has_feature', { p_feature: 'sync' }))).toBe(true)

    const s = expectOk<Status>(await rpc('get_sync_status'))
    expect(s.plan_id).toBe('beta')
    expect(s.has_sync).toBe(true)
    expect(s.free_for_all).toBe(true)
    expect(s.granted_by).toBe('free_for_all')
    expect(s.limits).toMatchObject({ sync: true, max_devices: 5 })
    expect(s.entitlement_status).toBeNull()
    expect(s.current_period_end).toBeNull()
    expect(s.beta_joined_at).toBeNull()
    expect(s.vault).toBeNull()
    expect(s.devices_count).toBe(0)
  })

  it('has_feature is false for a feature the plan does not list', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    expect(expectOk(await rpc('has_feature', { p_feature: 'teleport' }))).toBe(false)
  })

  it('a free entitlement never overrides the beta switch (D4)', async () => {
    const userId = await ctx.createUser()
    await grant(userId, 'free', 'active', null)
    expect(await planOf(userId)).toBe('beta')
    const s = expectOk<Status>(await ctx.rpcAs(userId)('get_sync_status'))
    expect(s.has_sync).toBe(true)
    expect(s.granted_by).toBe('free_for_all')
    expect(s.entitlement_status).toBe('active')
  })
})

describe('beta switch off (criterion 7)', () => {
  it('a user with no entitlement has plan free and no sync', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)

    expect(expectOk(await rpc('effective_plan'))).toBe('free')
    expect(expectOk(await rpc('has_feature', { p_feature: 'sync' }))).toBe(false)
    const s = expectOk<Status>(await rpc('get_sync_status'))
    expect(s.plan_id).toBe('free')
    expect(s.has_sync).toBe(false)
    expect(s.free_for_all).toBe(false)
    expect(s.granted_by).toBe('default')
    expect(s.limits).toMatchObject({ sync: false, max_devices: 0 })
  })

  it('register_device and create_vault raise sync_not_included and write nothing', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    const d = newDeviceId()

    expectMinima(
      await rpc('register_device', { p_device_id: d, p_label: 'Phone' }),
      'sync_not_included',
    )
    expectMinima(
      await rpc('create_vault', {
        p_device_id: d,
        p_vault_id: 'v1',
        p_header: validHeader('v1'),
      }),
      'sync_not_included',
    )
    const rows = await ctx.admin('select 1 from public.entitlements where user_id = $1', [
      userId,
    ])
    expect(rows).toHaveLength(0)
  })

  it('push and pull raise sync_not_included even for a registered device with a vault', async () => {
    const f = await userWithVault(ctx)
    await setFreeForAll(ctx, false)

    expectMinima(await push(f, [wireRecord(1)]), 'sync_not_included')
    expectMinima(await pull(f, 0), 'sync_not_included')
    expectMinima(
      await f.rpc('update_vault_header', {
        p_device_id: f.deviceId,
        p_vault_id: f.vaultId,
        p_header: validHeader(f.vaultId),
        p_expected_rev: 1,
      }),
      'sync_not_included',
    )
  })

  it('checks sync before the device: an unregistered device still gets sync_not_included', async () => {
    const f = await userWithVault(ctx)
    await setFreeForAll(ctx, false)
    expectMinima(await push(f, [wireRecord(1)], newDeviceId()), 'sync_not_included')
  })

  it('get_vault and delete_cloud_data still work', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1), wireRecord(2)]))
    await setFreeForAll(ctx, false)

    const vault = expectOk<{ vault_id: string; header_rev: number }>(
      await f.rpc('get_vault'),
    )
    expect(vault.vault_id).toBe(f.vaultId)
    expect(vault.header_rev).toBe(1)

    const del = expectOk<{ deleted_records: number }>(await f.rpc('delete_cloud_data'))
    expect(del.deleted_records).toBe(2)
    expect(expectOk(await f.rpc('get_vault'))).toBeNull()
  })

  it('device management (list, rename, remove) works without sync (D6)', async () => {
    const f = await userWithVault(ctx)
    await setFreeForAll(ctx, false)

    const list = expectOk<Array<{ device_id: string }>>(await f.rpc('list_devices'))
    expect(list).toHaveLength(1)
    const renamed = expectOk<{ label: string }>(
      await f.rpc('rename_device', { p_device_id: f.deviceId, p_label: 'Renamed' }),
    )
    expect(renamed.label).toBe('Renamed')
    const removed = expectOk<{ removed_at: string | null }>(
      await f.rpc('remove_device', { p_device_id: f.deviceId }),
    )
    expect(removed.removed_at).not.toBeNull()
  })
})

describe('entitlements (criterion 8)', () => {
  it('an active sync entitlement with a future end restores access', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    await grant(userId, 'sync', 'active', '30 days')

    expect(await planOf(userId)).toBe('sync')
    const s = expectOk<Status>(await ctx.rpcAs(userId)('get_sync_status'))
    expect(s.has_sync).toBe(true)
    expect(s.granted_by).toBe('entitlement')
    expect(s.entitlement_status).toBe('active')
    expect(s.current_period_end).not.toBeNull()
    expect(s.limits).toMatchObject({ max_devices: 10, max_records: 200000 })
  })

  it('an expired entitlement does not (flag off)', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    await grant(userId, 'sync', 'active', '-1 day')

    expect(await planOf(userId)).toBe('free')
    const s = expectOk<Status>(await ctx.rpcAs(userId)('get_sync_status'))
    expect(s.has_sync).toBe(false)
    expect(s.granted_by).toBe('default')
  })

  it('an active entitlement with no end date counts', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    await grant(userId, 'sync', 'active', null)
    expect(await planOf(userId)).toBe('sync')
  })

  it('past_due counts only until the period ends', async () => {
    await setFreeForAll(ctx, false)
    const inGrace = await ctx.createUser()
    await grant(inGrace, 'sync', 'past_due', '3 days')
    expect(await planOf(inGrace)).toBe('sync')

    const lapsed = await ctx.createUser()
    await grant(lapsed, 'sync', 'past_due', '-3 days')
    expect(await planOf(lapsed)).toBe('free')
  })

  it('a canceled entitlement never counts, even with a future end', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    await grant(userId, 'sync', 'canceled', '30 days')
    expect(await planOf(userId)).toBe('free')
  })

  it('an expired paid entitlement falls back to beta while the switch is on', async () => {
    const userId = await ctx.createUser()
    await grant(userId, 'sync', 'active', '-1 day')
    expect(await planOf(userId)).toBe('beta')
  })

  it('a valid beta entitlement keeps sync after the switch goes off (grandfathering)', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    await grant(userId, 'beta', 'active', null)
    expect(await planOf(userId)).toBe('beta')
    const s = expectOk<Status>(await ctx.rpcAs(userId)('get_sync_status'))
    expect(s.has_sync).toBe(true)
    expect(s.granted_by).toBe('entitlement')
  })

  it('a free entitlement with the switch off is plan free', async () => {
    await setFreeForAll(ctx, false)
    const userId = await ctx.createUser()
    await grant(userId, 'free', 'active', null)
    expect(await planOf(userId)).toBe('free')
  })
})

describe('register_device (criterion 9)', () => {
  it('creates the entitlements row on first use and records beta_joined_at', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    expect(
      await ctx.admin('select 1 from public.entitlements where user_id = $1', [userId]),
    ).toHaveLength(0)

    const dev = expectOk<{
      device_id: string
      label: string
      removed_at: string | null
    }>(await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Laptop' }))
    expect(dev.label).toBe('Laptop')
    expect(dev.removed_at).toBeNull()

    const rows = await ctx.admin<{
      plan_id: string
      status: string
      source: string
      beta_joined_at: string | null
    }>(
      'select plan_id, status, source, beta_joined_at from public.entitlements where user_id = $1',
      [userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ plan_id: 'free', status: 'active', source: 'beta' })
    expect(rows[0].beta_joined_at).not.toBeNull()

    const s = expectOk<Status>(await rpc('get_sync_status'))
    expect(s.beta_joined_at).not.toBeNull()
    expect(s.has_sync).toBe(true)
    expect(s.devices_count).toBe(1)
  })

  it('keeps the first beta_joined_at and does not touch an existing paid entitlement', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    expectOk(await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'One' }))
    const first = await ctx.admin<{ beta_joined_at: string }>(
      'select beta_joined_at from public.entitlements where user_id = $1',
      [userId],
    )
    expectOk(await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Two' }))
    const second = await ctx.admin<{ beta_joined_at: string }>(
      'select beta_joined_at from public.entitlements where user_id = $1',
      [userId],
    )
    expect(second[0].beta_joined_at).toEqual(first[0].beta_joined_at)

    const payer = await ctx.createUser()
    await grant(payer, 'sync', 'active', '30 days')
    expectOk(
      await ctx.rpcAs(payer)('register_device', {
        p_device_id: newDeviceId(),
        p_label: 'Paid',
      }),
    )
    const ent = await ctx.admin<{ plan_id: string; source: string }>(
      'select plan_id, source from public.entitlements where user_id = $1',
      [payer],
    )
    expect(ent[0]).toEqual({ plan_id: 'sync', source: 'manual' })
  })

  it('registering a device does not change the effective plan (D4)', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    expect(expectOk(await rpc('effective_plan'))).toBe('beta')
    expectOk(await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'A' }))
    expect(expectOk(await rpc('effective_plan'))).toBe('beta')
  })

  it('trims the label and validates it', async () => {
    const rpc = ctx.rpcAs(await ctx.createUser())
    const ok = expectOk<{ label: string }>(
      await rpc('register_device', { p_device_id: newDeviceId(), p_label: '  My Phone  ' }),
    )
    expect(ok.label).toBe('My Phone')

    const sixty = expectOk<{ label: string }>(
      await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'x'.repeat(60) }),
    )
    expect(sixty.label).toHaveLength(60)

    for (const bad of ['', '   ', 'x'.repeat(61)]) {
      expectMinima(
        await rpc('register_device', { p_device_id: newDeviceId(), p_label: bad }),
        'invalid_input',
      )
    }
    expectMinima(
      await rpc('register_device', { p_device_id: null, p_label: 'Phone' }),
      'invalid_input',
    )
  })

  it('on an existing device only refreshes last_seen_at and keeps a renamed label (D6)', async () => {
    const rpc = ctx.rpcAs(await ctx.createUser())
    const id = newDeviceId()
    const created = expectOk<{ created_at: string; last_seen_at: string }>(
      await rpc('register_device', { p_device_id: id, p_label: 'Old name' }),
    )
    expectOk(await rpc('rename_device', { p_device_id: id, p_label: 'Renamed' }))

    // Push last_seen_at an hour back so the refresh is detectable without
    // depending on wall-clock gaps between fast transactions.
    await ctx.admin(
      `update public.devices set last_seen_at = now() - interval '1 hour' where device_id = $1`,
      [id],
    )
    const backdated = Date.now() - 3_600_000

    const again = expectOk<{ label: string; created_at: string; last_seen_at: string }>(
      await rpc('register_device', { p_device_id: id, p_label: 'Old name' }),
    )
    expect(again.label).toBe('Renamed')
    expect(again.created_at).toEqual(created.created_at)
    expect(Date.parse(again.last_seen_at)).toBeGreaterThan(backdated + 30 * 60_000)
    expect(expectOk<Array<unknown>>(await rpc('list_devices'))).toHaveLength(1)
  })

  it('the 6th non-removed device under beta raises device_limit', async () => {
    const rpc = ctx.rpcAs(await ctx.createUser())
    const ids: Array<string> = []
    for (let i = 0; i < 5; i++) {
      const id = newDeviceId()
      ids.push(id)
      expectOk(await rpc('register_device', { p_device_id: id, p_label: `D${i}` }))
    }
    expectMinima(
      await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Sixth' }),
      'device_limit',
    )
    // An already registered device is not blocked by the limit.
    expectOk(await rpc('register_device', { p_device_id: ids[4], p_label: 'D4' }))
    expect(expectOk<Array<unknown>>(await rpc('list_devices'))).toHaveLength(5)

    // Removing one frees a slot.
    expectOk(await rpc('remove_device', { p_device_id: ids[0] }))
    expectOk(await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Sixth' }))
    const s = expectOk<Status>(await rpc('get_sync_status'))
    expect(s.devices_count).toBe(5)
  })

  it('a removed device raises device_removed on register, push and pull', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1)]))
    expectOk(await f.rpc('remove_device', { p_device_id: f.deviceId }))

    expectMinima(
      await f.rpc('register_device', { p_device_id: f.deviceId, p_label: 'Back' }),
      'device_removed',
    )
    expectMinima(await push(f, [wireRecord(2)]), 'device_removed')
    expectMinima(await pull(f, 0), 'device_removed')
    expectMinima(
      await f.rpc('create_vault', {
        p_device_id: f.deviceId,
        p_vault_id: 'another',
        p_header: validHeader('another'),
      }),
      'device_removed',
    )
  })

  it('an unregistered device raises device_not_registered before any vault check', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    expectOk(await rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Known' }))
    const stranger = newDeviceId()
    expectMinima(
      await rpc('push_records', { p_device_id: stranger, p_vault_id: 'none', p_records: [] }),
      'device_not_registered',
    )
    expectMinima(
      await rpc('pull_records', { p_device_id: stranger, p_vault_id: 'none', p_since: 0 }),
      'device_not_registered',
    )
  })
})

describe('list, rename and remove devices', () => {
  it('list_devices is ordered by created_at and includes removed devices', async () => {
    const rpc = ctx.rpcAs(await ctx.createUser())
    const first = newDeviceId()
    const second = newDeviceId()
    const third = newDeviceId()
    expectOk(await rpc('register_device', { p_device_id: first, p_label: 'First' }))
    expectOk(await rpc('register_device', { p_device_id: second, p_label: 'Second' }))
    expectOk(await rpc('register_device', { p_device_id: third, p_label: 'Third' }))
    expectOk(await rpc('remove_device', { p_device_id: second }))

    const list = expectOk<
      Array<{ device_id: string; label: string; removed_at: string | null }>
    >(await rpc('list_devices'))
    expect(list.map((d) => d.device_id)).toEqual([first, second, third])
    expect(list.map((d) => d.removed_at !== null)).toEqual([false, true, false])
  })

  it('rename_device changes the label, validates it and refuses unknown or removed devices', async () => {
    const rpc = ctx.rpcAs(await ctx.createUser())
    const id = newDeviceId()
    expectOk(await rpc('register_device', { p_device_id: id, p_label: 'Before' }))

    const renamed = expectOk<{ label: string }>(
      await rpc('rename_device', { p_device_id: id, p_label: '  After  ' }),
    )
    expect(renamed.label).toBe('After')
    expectMinima(
      await rpc('rename_device', { p_device_id: id, p_label: '' }),
      'invalid_input',
    )
    expectMinima(
      await rpc('rename_device', { p_device_id: newDeviceId(), p_label: 'X' }),
      'device_not_registered',
    )
    expectOk(await rpc('remove_device', { p_device_id: id }))
    expectMinima(
      await rpc('rename_device', { p_device_id: id, p_label: 'X' }),
      'device_removed',
    )
  })

  it('remove_device is idempotent and keeps the first removal time', async () => {
    const rpc = ctx.rpcAs(await ctx.createUser())
    const id = newDeviceId()
    expectOk(await rpc('register_device', { p_device_id: id, p_label: 'Gone' }))

    const first = expectOk<{ removed_at: string }>(
      await rpc('remove_device', { p_device_id: id }),
    )
    const second = expectOk<{ removed_at: string }>(
      await rpc('remove_device', { p_device_id: id }),
    )
    expect(first.removed_at).not.toBeNull()
    expect(second.removed_at).toEqual(first.removed_at)
    expectMinima(
      await rpc('remove_device', { p_device_id: newDeviceId() }),
      'device_not_registered',
    )
  })
})

describe('vault (criterion 10)', () => {
  async function userWithDevice() {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    const deviceId = newDeviceId()
    expectOk(await rpc('register_device', { p_device_id: deviceId, p_label: 'Dev' }))
    return { userId, rpc, deviceId }
  }

  it('get_vault is null before a vault exists', async () => {
    const { rpc } = await userWithDevice()
    expect(expectOk(await rpc('get_vault'))).toBeNull()
  })

  it('create_vault stores the header at rev 1 and get_vault returns it', async () => {
    const { rpc, deviceId } = await userWithDevice()
    const header = validHeader('vault-one')
    const created = expectOk(
      await rpc('create_vault', {
        p_device_id: deviceId,
        p_vault_id: 'vault-one',
        p_header: header,
      }),
    )
    expect(created).toEqual({ vault_id: 'vault-one', header_rev: 1 })

    const got = expectOk(await rpc('get_vault'))
    expect(got).toEqual({ vault_id: 'vault-one', header, header_rev: 1 })

    const s = expectOk<Status>(await rpc('get_sync_status'))
    expect(s.vault).toEqual({
      vault_id: 'vault-one',
      header_rev: 1,
      record_count: 0,
      total_bytes: 0,
      last_seq: 0,
    })
  })

  it('create_vault twice raises vault_exists and keeps the first vault', async () => {
    const f = await userWithVault(ctx, 'first-vault')
    expectMinima(
      await f.rpc('create_vault', {
        p_device_id: f.deviceId,
        p_vault_id: 'second-vault',
        p_header: validHeader('second-vault'),
      }),
      'vault_exists',
    )
    const got = expectOk<{ vault_id: string }>(await f.rpc('get_vault'))
    expect(got.vault_id).toBe('first-vault')
  })

  it('create_vault validates the id and the header', async () => {
    const { rpc, deviceId } = await userWithDevice()
    const call = (vaultId: string, header: unknown) =>
      rpc('create_vault', { p_device_id: deviceId, p_vault_id: vaultId, p_header: header })

    for (const bad of ['', 'has space', 'bad/id', 'x'.repeat(101)]) {
      expectMinima(await call(bad, validHeader('ok')), 'invalid_input')
    }
    // vaultId inside the header must match.
    expectMinima(await call('vault-a', validHeader('vault-b')), 'invalid_input')
    // The header must be a JSON object.
    expectMinima(await call('vault-a', ['vaultId', 'vault-a']), 'invalid_input')
    expectMinima(await call('vault-a', null), 'invalid_input')
    // 8192 bytes at most.
    expectMinima(
      await call('vault-a', validHeader('vault-a', { pad: 'p'.repeat(9000) })),
      'invalid_input',
    )
    expect(expectOk(await rpc('get_vault'))).toBeNull()

    expectOk(await call('x'.repeat(100), validHeader('x'.repeat(100))))
  })

  it('update_vault_header with a wrong expected rev raises header_conflict', async () => {
    const f = await userWithVault(ctx, 'vault-up')
    const next = validHeader('vault-up', { createdAt: '2026-11-01T00:00:00.000Z' })

    expectMinima(
      await f.rpc('update_vault_header', {
        p_device_id: f.deviceId,
        p_vault_id: 'vault-up',
        p_header: next,
        p_expected_rev: 7,
      }),
      'header_conflict',
    )
    const unchanged = expectOk<{ header_rev: number; header: { createdAt: string } }>(
      await f.rpc('get_vault'),
    )
    expect(unchanged.header_rev).toBe(1)
    expect(unchanged.header.createdAt).toBe('2026-10-23T10:00:00.000Z')
  })

  it('update_vault_header with the right rev increments header_rev each time', async () => {
    const f = await userWithVault(ctx, 'vault-up')
    const update = (rev: number, createdAt: string) =>
      f.rpc('update_vault_header', {
        p_device_id: f.deviceId,
        p_vault_id: 'vault-up',
        p_header: validHeader('vault-up', { createdAt }),
        p_expected_rev: rev,
      })

    expect(expectOk(await update(1, '2026-11-01T00:00:00.000Z'))).toEqual({
      vault_id: 'vault-up',
      header_rev: 2,
    })
    expect(expectOk(await update(2, '2026-12-01T00:00:00.000Z'))).toEqual({
      vault_id: 'vault-up',
      header_rev: 3,
    })
    // The old rev now conflicts.
    expectMinima(await update(1, '2027-01-01T00:00:00.000Z'), 'header_conflict')

    const got = expectOk<{ header_rev: number; header: { createdAt: string } }>(
      await f.rpc('get_vault'),
    )
    expect(got.header_rev).toBe(3)
    expect(got.header.createdAt).toBe('2026-12-01T00:00:00.000Z')
  })

  it('update_vault_header checks no_vault, vault_mismatch, then the header, then the rev', async () => {
    const { rpc, deviceId } = await userWithDevice()
    const call = (vaultId: string, header: unknown, rev: number) =>
      rpc('update_vault_header', {
        p_device_id: deviceId,
        p_vault_id: vaultId,
        p_header: header,
        p_expected_rev: rev,
      })
    expectMinima(await call('vault-a', validHeader('vault-a'), 1), 'no_vault')

    expectOk(
      await rpc('create_vault', {
        p_device_id: deviceId,
        p_vault_id: 'vault-a',
        p_header: validHeader('vault-a'),
      }),
    )
    // Wrong vault AND wrong rev: the mismatch wins.
    expectMinima(await call('vault-b', validHeader('vault-b'), 9), 'vault_mismatch')
    // Bad header AND wrong rev: the header wins.
    expectMinima(await call('vault-a', validHeader('other'), 9), 'invalid_input')
    expectMinima(await call('vault-a', validHeader('vault-a'), 9), 'header_conflict')
  })

  it('pushing with a different vault_id raises vault_mismatch, with no vault no_vault', async () => {
    const f = await userWithVault(ctx, 'vault-real')
    expectMinima(
      await f.rpc('push_records', {
        p_device_id: f.deviceId,
        p_vault_id: 'vault-other',
        p_records: [wireRecord(1)],
      }),
      'vault_mismatch',
    )
    expectMinima(
      await f.rpc('pull_records', {
        p_device_id: f.deviceId,
        p_vault_id: 'vault-other',
        p_since: 0,
      }),
      'vault_mismatch',
    )

    const { rpc, deviceId } = await userWithDevice()
    expectMinima(
      await rpc('push_records', { p_device_id: deviceId, p_vault_id: 'v', p_records: [] }),
      'no_vault',
    )
    expectMinima(
      await rpc('pull_records', { p_device_id: deviceId, p_vault_id: 'v', p_since: 0 }),
      'no_vault',
    )
  })
})
