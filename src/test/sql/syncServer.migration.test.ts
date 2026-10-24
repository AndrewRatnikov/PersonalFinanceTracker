// @vitest-environment node
// No CONTRACT_GAPs: tables, seeds, privileges and function list are specified in
// plan section 3 and the harness in section 5. PGlite enforces roles, grants
// and RLS, so criterion 4 is tested for real here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CHECKS_PATH,
  MIGRATION_PATH,
  SYNC_FUNCTIONS,
  applyMigration,
  expectMinima,
  expectPermissionDenied,
  newDeviceId,
  readChecks,
  readMigration,
  setFreeForAll,
  startDb,
} from './harness'
import type { SqlTestDb } from './harness'

let ctx: SqlTestDb

const TABLES = [
  'plans',
  'app_config',
  'entitlements',
  'vaults',
  'devices',
  'sync_records',
] as const
const USER_TABLES = ['entitlements', 'vaults', 'devices', 'sync_records'] as const

beforeAll(async () => {
  ctx = await startDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

describe('migration is idempotent (criterion 1)', () => {
  it('applies a third time without error after data exists, keeping data and the flag', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)
    const reg = await rpc('register_device', {
      p_device_id: newDeviceId(),
      p_label: 'Phone',
    })
    expect(reg.error).toBeNull()
    await setFreeForAll(ctx, false)

    await expect(applyMigration(ctx.db)).resolves.toBeUndefined()

    const flag = await ctx.admin<{ value: unknown }>(
      "select value from public.app_config where key = 'sync_free_for_all'",
    )
    expect(flag[0].value).toBe(false)
    const ent = await ctx.admin(
      'select 1 from public.entitlements where user_id = $1',
      [userId],
    )
    expect(ent).toHaveLength(1)
    const dev = await ctx.admin('select 1 from public.devices where user_id = $1', [
      userId,
    ])
    expect(dev).toHaveLength(1)

    await setFreeForAll(ctx, true)
  })

  it('re-running resets plan rows to the seeds (upsert)', async () => {
    await ctx.admin("update public.plans set name = 'Changed' where id = 'free'")
    await applyMigration(ctx.db)
    const rows = await ctx.admin<{ name: string }>(
      "select name from public.plans where id = 'free'",
    )
    expect(rows[0].name).toBe('Free')
  })

  it('has no drop table and does not redefine delete_own_account', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/^\s*drop\s+table/im)
    expect(sql).not.toMatch(/create (or replace )?function public\.delete_own_account/i)
  })
})

describe('seeds (criterion 2)', () => {
  it('seeds the three plans with the specified features', async () => {
    const rows = await ctx.admin<{
      id: string
      name: string
      features: unknown
      is_public: boolean
    }>('select id, name, features, is_public from public.plans order by id')
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))

    expect(Object.keys(byId).sort()).toEqual(
      expect.arrayContaining(['beta', 'free', 'sync']),
    )
    expect(byId.free.features).toEqual({
      sync: false,
      max_devices: 0,
      max_records: 0,
      max_bytes: 0,
    })
    expect(byId.free.is_public).toBe(true)
    expect(byId.beta.features).toEqual({
      sync: true,
      max_devices: 5,
      max_records: 100000,
      max_bytes: 104857600,
    })
    expect(byId.beta.is_public).toBe(true)
    expect(byId.sync.features).toEqual({
      sync: true,
      max_devices: 10,
      max_records: 200000,
      max_bytes: 209715200,
    })
    expect(byId.sync.is_public).toBe(false)
    expect(byId.beta.name).toBe('Beta')
    expect(byId.sync.name).toBe('Sync')
  })

  it('seeds app_config.sync_free_for_all = true', async () => {
    const rows = await ctx.admin<{ value: unknown }>(
      "select value from public.app_config where key = 'sync_free_for_all'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe(true)
  })
})

describe('RLS and foreign keys (criterion 3)', () => {
  it('enables row level security on all six tables', async () => {
    const rows = await ctx.admin<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])`,
      [[...TABLES]],
    )
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort())
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true)
    }
  })

  it('every user_id references auth.users(id) ON DELETE CASCADE', async () => {
    const rows = await ctx.admin<{ tbl: string; col: string; del: string }>(
      `select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype as del
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.confrelid = 'auth.users'::regclass`,
    )
    for (const table of USER_TABLES) {
      const fk = rows.find((r) => r.tbl.replace('public.', '') === table)
      expect(fk, table).toBeTruthy()
      expect(fk?.col).toBe('user_id')
      expect(fk?.del).toBe('c')
    }
  })
})

describe('functions (criterion 4)', () => {
  it('defines exactly one overload of each of the 13 functions', async () => {
    const rows = await ctx.admin<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [[...SYNC_FUNCTIONS]],
    )
    expect(rows.map((r) => r.proname).sort()).toEqual([...SYNC_FUNCTIONS].sort())
  })

  it('all are SECURITY DEFINER with an empty search_path', async () => {
    const rows = await ctx.admin<{
      proname: string
      prosecdef: boolean
      proconfig: Array<string> | null
    }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [[...SYNC_FUNCTIONS]],
    )
    expect(rows).toHaveLength(SYNC_FUNCTIONS.length)
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true)
      expect(r.proconfig ?? [], r.proname).toContain('search_path=""')
    }
  })

  it('never return void', async () => {
    const rows = await ctx.admin<{ proname: string; result: string }>(
      `select p.proname, pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [[...SYNC_FUNCTIONS]],
    )
    for (const r of rows) {
      expect(['jsonb', 'text', 'boolean'], r.proname).toContain(r.result)
    }
  })

  it('anon can execute none of them, authenticated can execute all', async () => {
    const rows = await ctx.admin<{
      proname: string
      anon: boolean
      authed: boolean
    }>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [[...SYNC_FUNCTIONS]],
    )
    expect(rows).toHaveLength(SYNC_FUNCTIONS.length)
    for (const r of rows) {
      expect(r.anon, `anon ${r.proname}`).toBe(false)
      expect(r.authed, `authenticated ${r.proname}`).toBe(true)
    }
  })

  it('anon calling a function gets permission denied', async () => {
    await expectPermissionDenied(ctx.asAnon('select public.get_sync_status()'))
    await expectPermissionDenied(ctx.asAnon('select public.effective_plan()'))
  })

  it('raises MINIMA:not_signed_in for every function without a signed-in user', async () => {
    const d = newDeviceId()
    const calls: Array<[(typeof SYNC_FUNCTIONS)[number], Record<string, unknown>]> = [
      ['effective_plan', {}],
      ['has_feature', { p_feature: 'sync' }],
      ['get_sync_status', {}],
      ['register_device', { p_device_id: d, p_label: 'x' }],
      ['list_devices', {}],
      ['rename_device', { p_device_id: d, p_label: 'x' }],
      ['remove_device', { p_device_id: d }],
      [
        'create_vault',
        { p_device_id: d, p_vault_id: 'v1', p_header: { vaultId: 'v1' } },
      ],
      ['get_vault', {}],
      [
        'update_vault_header',
        {
          p_device_id: d,
          p_vault_id: 'v1',
          p_header: { vaultId: 'v1' },
          p_expected_rev: 1,
        },
      ],
      ['push_records', { p_device_id: d, p_vault_id: 'v1', p_records: [] }],
      ['pull_records', { p_device_id: d, p_vault_id: 'v1', p_since: 0 }],
      ['delete_cloud_data', {}],
    ]
    expect(calls.map(([fn]) => fn).sort()).toEqual([...SYNC_FUNCTIONS].sort())

    const rpc = ctx.rpcAs(null)
    for (const [fn, args] of calls) {
      const res = await rpc(fn, args)
      expect(res.error?.message, fn).toBe('MINIMA:not_signed_in')
    }
  })

  it('does not raise not_signed_in for a signed-in user', async () => {
    const userId = await ctx.createUser()
    const res = await ctx.rpcAs(userId)('effective_plan')
    expect(res.error).toBeNull()
    expect(res.data).toBe('beta')
  })
})

describe('table privileges', () => {
  it('anon has no privilege on any new table', async () => {
    const rows = await ctx.admin<{ t: string; sel: boolean; ins: boolean }>(
      `select t as t,
              has_table_privilege('anon', 'public.' || t, 'SELECT') as sel,
              has_table_privilege('anon', 'public.' || t, 'INSERT') as ins
         from unnest($1::text[]) as x(t)`,
      [[...TABLES]],
    )
    expect(rows).toHaveLength(TABLES.length)
    for (const r of rows) {
      expect(r.sel, `anon select ${r.t}`).toBe(false)
      expect(r.ins, `anon insert ${r.t}`).toBe(false)
    }
  })

  it('authenticated can only select, and not from app_config or sync_records', async () => {
    const rows = await ctx.admin<{
      t: string
      sel: boolean
      ins: boolean
      upd: boolean
      del: boolean
    }>(
      `select t as t,
              has_table_privilege('authenticated', 'public.' || t, 'SELECT') as sel,
              has_table_privilege('authenticated', 'public.' || t, 'INSERT') as ins,
              has_table_privilege('authenticated', 'public.' || t, 'UPDATE') as upd,
              has_table_privilege('authenticated', 'public.' || t, 'DELETE') as del
         from unnest($1::text[]) as x(t)`,
      [[...TABLES]],
    )
    const byTable = Object.fromEntries(rows.map((r) => [r.t, r]))
    for (const t of TABLES) {
      expect(byTable[t].ins, `insert ${t}`).toBe(false)
      expect(byTable[t].upd, `update ${t}`).toBe(false)
      expect(byTable[t].del, `delete ${t}`).toBe(false)
    }
    for (const t of ['plans', 'entitlements', 'vaults', 'devices']) {
      expect(byTable[t].sel, `select ${t}`).toBe(true)
    }
    for (const t of ['app_config', 'sync_records']) {
      expect(byTable[t].sel, `select ${t}`).toBe(false)
    }
  })

  it('a signed-in user only sees public plans', async () => {
    const userId = await ctx.createUser()
    const rows = await ctx.asUser<{ id: string }>(
      userId,
      'select id from public.plans order by id',
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('free')
    expect(ids).toContain('beta')
    expect(ids).not.toContain('sync')
  })
})

describe('error format', () => {
  it('uses the message MINIMA:<code> and nothing after it', async () => {
    const res = await ctx.rpcAs(await ctx.createUser())('get_vault')
    expect(res.error).toBeNull()
    const bad = await ctx.rpcAs(await ctx.createUser())('register_device', {
      p_device_id: newDeviceId(),
      p_label: '',
    })
    expectMinima(bad, 'invalid_input')
  })
})

describe('manual checks script (criterion 17)', () => {
  it('has BEGIN ... ROLLBACK, raises on failure and reports success', () => {
    const sql = readChecks()
    expect(CHECKS_PATH).toBe('supabase/tests/sync_server_checks.sql')
    expect(sql).toMatch(/^\s*begin;/im)
    expect(sql).toMatch(/^\s*rollback;/im)
    expect(sql).toMatch(/CHECK FAILED/)
    expect(sql).toMatch(/sync_server_checks: all checks passed/)
    expect(MIGRATION_PATH).toBe('supabase/migrations/20261023000000_sync_server.sql')
  })

  it('runs cleanly in PGlite and leaves nothing behind', async () => {
    const before = await ctx.admin<{ n: string }>(
      'select count(*)::text as n from auth.users',
    )
    await expect(ctx.db.exec(readChecks())).resolves.toBeDefined()
    const after = await ctx.admin<{ n: string }>(
      'select count(*)::text as n from auth.users',
    )
    expect(after[0].n).toBe(before[0].n)
    const throwaway = await ctx.admin(
      "select 1 from auth.users where id in ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b')",
    )
    expect(throwaway).toHaveLength(0)
  })
})
