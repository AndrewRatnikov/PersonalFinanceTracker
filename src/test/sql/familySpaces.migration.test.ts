// @vitest-environment node
// No CONTRACT_GAPs: tables, indexes, policies, grants and function names come
// from plan sections B1 to B6 and the SQL part of the Interface Contract.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  FAMILY_CHECKS_PATH,
  FAMILY_FUNCTIONS,
  FAMILY_INTERNAL_FUNCTIONS,
  FAMILY_MIGRATION_PATH,
  FAMILY_TABLES,
  applyFamilyMigration,
  buildSpace,
  expectMinima,
  expectPermissionDenied,
  newUuid,
  pushSpace,
  readFamilyChecks,
  readFamilyMigration,
  spaceRecord,
  startFamilyDb,
} from './familyHarness'
import { readMigration } from './harness'
import type { SqlTestDb } from './familyHarness'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startFamilyDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

const ALL_FUNCTIONS = [...FAMILY_FUNCTIONS, ...FAMILY_INTERNAL_FUNCTIONS]
const SELECTABLE = ['spaces', 'space_members', 'space_keys', 'space_events'] as const
const FUNCTION_ONLY = ['space_invites', 'space_records'] as const

describe('file names', () => {
  it('uses the planned paths', () => {
    expect(FAMILY_MIGRATION_PATH).toBe('supabase/migrations/20261029000000_family_spaces.sql')
    expect(FAMILY_CHECKS_PATH).toBe('supabase/tests/family_spaces_checks.sql')
    expect(FAMILY_FUNCTIONS).toHaveLength(16)
    expect(FAMILY_INTERNAL_FUNCTIONS).toHaveLength(5)
    expect(FAMILY_TABLES).toHaveLength(6)
  })
})

describe('idempotence (criterion 1)', () => {
  it('a third run with data present changes nothing', async () => {
    const space = await buildSpace(ctx, { active: 2, pending: 1 })
    await pushSpace(space.owner, space.spaceId, [spaceRecord(1), spaceRecord(2)])

    const snapshot = async () => {
      const out: Record<string, unknown> = {}
      for (const t of FAMILY_TABLES) {
        out[t] = (
          await ctx.admin<{ n: number }>(`select count(*)::int as n from public.${t}`)
        )[0].n
      }
      out.plans = await ctx.admin('select id, name, features, is_public from public.plans order by id')
      out.functions = await ctx.admin(
        `select p.proname, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' order by 1, 2`,
      )
      out.policies = await ctx.admin(
        "select tablename, policyname from pg_policies where schemaname = 'public' order by 1, 2",
      )
      return out
    }

    const before = await snapshot()
    expect((before.spaces as number) > 0).toBe(true)
    await applyFamilyMigration(ctx.db)
    expect(await snapshot()).toEqual(before)

    // The data still works afterwards.
    const res = await space.members[0].rpc('get_my_space')
    expect((res.data as { status: string }).status).toBe('active')
  })

  it('does not touch the run 2 migration file', () => {
    expect(readMigration()).not.toMatch(/shared_spaces|space_members|space_records/)
    expect(readFamilyMigration()).toMatch(/20261023000000_sync_server\.sql/)
  })
})

describe('plan seeds (criterion 2)', () => {
  async function features(id: string): Promise<Record<string, unknown>> {
    const rows = await ctx.admin<{ features: Record<string, unknown> }>(
      'select features from public.plans where id = $1',
      [id],
    )
    expect(rows).toHaveLength(1)
    return rows[0].features
  }

  it('free and sync gained shared_spaces false and kept their old keys', async () => {
    const free = await features('free')
    expect(free).toMatchObject({ sync: false, max_devices: 0, shared_spaces: false })
    const sync = await features('sync')
    expect(sync).toMatchObject({
      sync: true,
      max_devices: 10,
      max_records: 200000,
      max_bytes: 209715200,
      shared_spaces: false,
    })
  })

  it('beta gained the family keys and kept its old ones', async () => {
    expect(await features('beta')).toMatchObject({
      sync: true,
      max_devices: 5,
      max_records: 100000,
      max_bytes: 104857600,
      shared_spaces: true,
      max_members: 6,
      max_space_records: 100000,
      max_space_bytes: 104857600,
    })
  })

  it('the family plan has the sync features plus the family ones and is not public', async () => {
    expect(await features('family')).toMatchObject({
      sync: true,
      max_devices: 10,
      max_records: 200000,
      max_bytes: 209715200,
      shared_spaces: true,
      max_members: 6,
      max_space_records: 100000,
      max_space_bytes: 104857600,
    })
    const rows = await ctx.admin<{ is_public: boolean; name: string }>(
      "select is_public, name from public.plans where id = 'family'",
    )
    expect(rows[0].is_public).toBe(false)
    expect(rows[0].name).toBe('Family')
  })

  it('a re-run keeps a family plan that was made public', async () => {
    await ctx.admin("update public.plans set is_public = true where id = 'family'")
    try {
      await applyFamilyMigration(ctx.db)
      const rows = await ctx.admin<{ is_public: boolean }>(
        "select is_public from public.plans where id = 'family'",
      )
      expect(rows[0].is_public).toBe(true)
    } finally {
      await ctx.admin("update public.plans set is_public = false where id = 'family'")
    }
  })

  it('a re-run does not undo a changed limit on other keys', async () => {
    await ctx.admin(
      `update public.plans set features = features || '{"max_devices": 7}'::jsonb where id = 'sync'`,
    )
    try {
      await applyFamilyMigration(ctx.db)
      expect((await features('sync')).max_devices).toBe(7)
    } finally {
      await ctx.admin(
        `update public.plans set features = features || '{"max_devices": 10}'::jsonb where id = 'sync'`,
      )
    }
  })
})

describe('tables, indexes, policies and the trigger', () => {
  const COLUMNS: Record<(typeof FAMILY_TABLES)[number], Array<string>> = {
    spaces: [
      'created_at',
      'id',
      'key_version',
      'last_seq',
      'owner_id',
      'record_count',
      'total_bytes',
      'updated_at',
    ],
    space_members: [
      'invite_id',
      'joined_at',
      'public_key',
      'requested_at',
      'role',
      'space_id',
      'status',
      'user_id',
    ],
    space_invites: [
      'created_at',
      'created_by',
      'expires_at',
      'id',
      'revoked_at',
      'space_id',
      'token_hash',
      'used_at',
      'used_by',
    ],
    space_keys: ['created_at', 'key_version', 'space_id', 'user_id', 'wrapped_key'],
    space_records: [
      'author_id',
      'ciphertext',
      'device_id',
      'enc_v',
      'iv',
      'key_version',
      'record_key',
      'seq',
      'server_updated_at',
      'size',
      'space_id',
      'updated_at_ms',
    ],
    space_events: ['actor_id', 'created_at', 'id', 'kind', 'space_id', 'subject_id'],
  }

  it.each(FAMILY_TABLES)('%s has exactly the planned columns', async (table) => {
    const rows = await ctx.admin<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1 order by column_name`,
      [table],
    )
    expect(rows.map((r) => r.column_name)).toEqual(COLUMNS[table])
  })

  it('has the planned indexes', async () => {
    const rows = await ctx.admin<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and indexname like 'space\\_%\\_idx'",
    )
    const names = rows.map((r) => r.indexname)
    for (const name of [
      'space_members_one_per_user_idx',
      'space_members_one_owner_idx',
      'space_records_space_seq_idx',
      'space_invites_space_idx',
      'space_events_space_idx',
    ]) {
      expect(names, name).toContain(name)
    }
  })

  it('has the planned policies', async () => {
    const rows = await ctx.admin<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd from pg_policies
        where schemaname = 'public' and tablename like 'space%' order by policyname`,
    )
    expect(rows.map((r) => `${r.tablename}.${r.policyname}`).sort()).toEqual([
      'space_events.space_events_select_member',
      'space_keys.space_keys_select_own',
      'space_members.space_members_select_member',
      'spaces.spaces_select_member',
    ])
    for (const r of rows) expect(r.cmd).toBe('SELECT')
  })

  it('has the before-delete trigger on auth.users', async () => {
    const rows = await ctx.admin<{ tgname: string; before_row_delete: boolean }>(
      `select t.tgname,
              (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 8) = 8 as before_row_delete
         from pg_trigger t
        where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal`,
    )
    const mine = rows.filter((r) => r.tgname === 'space_member_left_on_user_delete')
    expect(mine).toHaveLength(1)
    expect(mine[0].before_row_delete).toBe(true)
  })

  it('the foreign keys cascade, and author / actor / subject ids have none', async () => {
    const rows = await ctx.admin<{ tbl: string; ref: string; del: string; cols: string }>(
      `select conrelid::regclass::text as tbl, confrelid::regclass::text as ref,
              confdeltype::text as del,
              (select string_agg(a.attname, ',' order by a.attname)
                 from pg_attribute a
                where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as cols
         from pg_constraint c
        where c.contype = 'f'
          and c.conrelid::regclass::text in
              ('spaces','space_members','space_invites','space_keys','space_records','space_events')`,
    )
    const has = (tbl: string, ref: string, cols: string) =>
      rows.some((r) => r.tbl === tbl && r.ref === ref && r.cols === cols && r.del === 'c')

    expect(has('spaces', 'auth.users', 'owner_id')).toBe(true)
    expect(has('space_members', 'spaces', 'space_id')).toBe(true)
    expect(has('space_members', 'auth.users', 'user_id')).toBe(true)
    expect(has('space_invites', 'spaces', 'space_id')).toBe(true)
    expect(has('space_invites', 'auth.users', 'created_by')).toBe(true)
    expect(has('space_keys', 'spaces', 'space_id')).toBe(true)
    expect(has('space_keys', 'auth.users', 'user_id')).toBe(true)
    expect(has('space_records', 'spaces', 'space_id')).toBe(true)
    expect(has('space_events', 'spaces', 'space_id')).toBe(true)

    // D5: opaque ids that survive an account deletion.
    expect(rows.filter((r) => r.tbl === 'space_records' && r.ref === 'auth.users')).toEqual([])
    expect(rows.filter((r) => r.tbl === 'space_events' && r.ref === 'auth.users')).toEqual([])
  })
})

describe('RLS and table privileges (criterion 1)', () => {
  it.each(FAMILY_TABLES)('%s has row level security on', async (table) => {
    const rows = await ctx.admin<{ relrowsecurity: boolean }>(
      'select relrowsecurity from pg_class where oid = $1::regclass',
      [`public.${table}`],
    )
    expect(rows[0].relrowsecurity).toBe(true)
  })

  async function privilege(role: string, table: string, priv: string): Promise<boolean> {
    const rows = await ctx.admin<{ ok: boolean }>(
      'select has_table_privilege($1, $2, $3) as ok',
      [role, `public.${table}`, priv],
    )
    return rows[0].ok
  }

  it.each(FAMILY_TABLES)('anon has no privilege on %s', async (table) => {
    for (const priv of ['select', 'insert', 'update', 'delete']) {
      expect(await privilege('anon', table, priv), `${table} ${priv}`).toBe(false)
    }
  })

  it.each(SELECTABLE)('authenticated may only select from %s', async (table) => {
    expect(await privilege('authenticated', table, 'select')).toBe(true)
    for (const priv of ['insert', 'update', 'delete']) {
      expect(await privilege('authenticated', table, priv), `${table} ${priv}`).toBe(false)
    }
  })

  it.each(FUNCTION_ONLY)('authenticated has no privilege on %s', async (table) => {
    for (const priv of ['select', 'insert', 'update', 'delete']) {
      expect(await privilege('authenticated', table, priv), `${table} ${priv}`).toBe(false)
    }
  })

  it('direct selects as anon are refused for every table', async () => {
    for (const table of FAMILY_TABLES) {
      await expectPermissionDenied(ctx.asAnon(`select * from public.${table}`))
    }
  })

  it('authenticated is refused on space_invites and space_records, and cannot write anywhere', async () => {
    const user = await ctx.createUser()
    for (const table of FUNCTION_ONLY) {
      await expectPermissionDenied(ctx.asUser(user, `select * from public.${table}`))
    }
    await expectPermissionDenied(
      ctx.asUser(user, 'insert into public.spaces (id, owner_id) values ($1, $2)', [
        newUuid(),
        user,
      ]),
    )
    await expectPermissionDenied(ctx.asUser(user, 'update public.spaces set key_version = 9'))
    await expectPermissionDenied(ctx.asUser(user, 'delete from public.space_members'))
    await expectPermissionDenied(ctx.asUser(user, 'delete from public.space_events'))
  })

  it('the event id sequence is not usable by authenticated', async () => {
    const user = await ctx.createUser()
    await expectPermissionDenied(
      ctx.asUser(user, "select nextval('public.space_events_id_seq')"),
    )
  })
})

describe('function properties (criteria 1 and 3)', () => {
  interface ProcRow {
    proname: string
    prosecdef: boolean
    config: string | null
    anon: boolean
    authed: boolean
  }

  async function procs(): Promise<Array<ProcRow>> {
    return ctx.admin<ProcRow>(
      `select p.proname, p.prosecdef,
              array_to_string(p.proconfig, ',') as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by p.proname`,
      [ALL_FUNCTIONS],
    )
  }

  it('every new function exists exactly once', async () => {
    const rows = await procs()
    expect(rows.map((r) => r.proname).sort()).toEqual([...ALL_FUNCTIONS].sort())
  })

  it('all 21 are SECURITY DEFINER with an empty search_path', async () => {
    for (const row of await procs()) {
      expect(row.prosecdef, row.proname).toBe(true)
      expect(row.config ?? '', row.proname).toMatch(/^search_path=(""|)$/)
    }
  })

  it('anon can execute none of them', async () => {
    for (const row of await procs()) expect(row.anon, row.proname).toBe(false)
  })

  it('authenticated can execute exactly the 16 callable ones', async () => {
    const rows = await procs()
    const allowed = rows.filter((r) => r.authed).map((r) => r.proname)
    expect(allowed.sort()).toEqual([...FAMILY_FUNCTIONS].sort())
    for (const name of FAMILY_INTERNAL_FUNCTIONS) {
      expect(rows.find((r) => r.proname === name)?.authed, name).toBe(false)
    }
  })

  it('the two permission helpers cannot be called through rpc', async () => {
    const user = await ctx.createUser()
    const rpc = ctx.rpcAs(user)
    for (const fn of ['effective_plan_for', 'has_feature_for']) {
      const res = await rpc(fn, fn === 'has_feature_for' ? { p_user: user, p_feature: 'sync' } : { p_user: user })
      expect(res.error?.message ?? '', fn).toMatch(/permission denied/i)
    }
  })

  it('every callable function raises not_signed_in without a user', async () => {
    const anyUuid = newUuid()
    const args: Record<(typeof FAMILY_FUNCTIONS)[number], Record<string, unknown>> = {
      is_active_space_member: { p_space_id: anyUuid },
      get_my_space: {},
      create_space: { p_space_id: anyUuid, p_public_key: {}, p_wrapped_key_for_self: {} },
      create_invite: { p_space_id: anyUuid, p_token_hash: 'a'.repeat(64) },
      revoke_invite: { p_invite_id: anyUuid },
      get_invite: { p_invite_id: anyUuid, p_token: 'token' },
      request_join: { p_invite_id: anyUuid, p_token: 'token', p_public_key: {} },
      approve_member: {
        p_space_id: anyUuid,
        p_user_id: anyUuid,
        p_key_version: 1,
        p_wrapped_key: {},
      },
      reject_member: { p_space_id: anyUuid, p_user_id: anyUuid },
      remove_member: { p_space_id: anyUuid, p_user_id: anyUuid },
      rotate_space_key: { p_space_id: anyUuid, p_new_version: 2, p_wraps: [] },
      leave_space: {},
      transfer_ownership: { p_space_id: anyUuid, p_user_id: anyUuid },
      delete_space: { p_space_id: anyUuid },
      push_space_records: {
        p_space_id: anyUuid,
        p_device_id: anyUuid,
        p_key_version: 1,
        p_records: [],
      },
      pull_space_records: { p_space_id: anyUuid, p_device_id: anyUuid, p_since: 0 },
    }
    const signedOut = ctx.rpcAs(null)
    for (const fn of FAMILY_FUNCTIONS) {
      expectMinima(await signedOut(fn, args[fn]), 'not_signed_in')
    }
  })

  it('the table rows are untouched by a refused anonymous call', async () => {
    const before = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces')
    const res = await ctx.rpcAs(null)('create_space', {
      p_space_id: newUuid(),
      p_public_key: {},
      p_wrapped_key_for_self: {},
    })
    expect(res.error).not.toBeNull()
    const after = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces')
    expect(after[0].n).toBe(before[0].n)
  })
})

describe('the manual check script (plan section C)', () => {
  it('has the documented markers', () => {
    const text = readFamilyChecks()
    expect(text).toContain('family_spaces_checks: all checks passed')
    expect(text).toContain('CHECK FAILED:')
    for (const id of ['f1', 'f2', 'f3', 'f4']) {
      expect(text).toContain(`00000000-0000-4000-8000-0000000000${id}`)
    }
  })

  it('runs clean and leaves nothing behind', async () => {
    const count = async () => {
      const users = await ctx.admin<{ n: number }>('select count(*)::int as n from auth.users')
      const spaces = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces')
      const events = await ctx.admin<{ n: number }>(
        'select count(*)::int as n from public.space_events',
      )
      return [users[0].n, spaces[0].n, events[0].n]
    }
    const before = await count()
    try {
      await ctx.db.exec(readFamilyChecks())
    } finally {
      await ctx.db.exec('rollback').catch(() => undefined)
    }
    expect(await count()).toEqual(before)
  })
})
