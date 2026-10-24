// SQL test harness: PGlite plus a small stand-in for the parts of Supabase the
// sync migration relies on (auth.users, auth.uid(), the anon / authenticated /
// service_role roles and Supabase's default privileges).
//
// No CONTRACT_GAPs: the harness shape is specified in the plan (section 5).
// PGlite enforces roles, grants and RLS, so role checks are real tests here.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { expect } from 'vitest'
import type { RpcFn, RpcResponse } from '@/lib/cloud/api'

export const MIGRATION_PATH = 'supabase/migrations/20261023000000_sync_server.sql'
export const CHECKS_PATH = 'supabase/tests/sync_server_checks.sql'

export const SYNC_FUNCTIONS = [
  'effective_plan',
  'has_feature',
  'get_sync_status',
  'register_device',
  'list_devices',
  'rename_device',
  'remove_device',
  'create_vault',
  'get_vault',
  'update_vault_header',
  'push_records',
  'pull_records',
  'delete_cloud_data',
] as const

export type Row = Record<string, unknown>

export interface SqlTestDb {
  db: PGlite
  admin: <T = Row>(sql: string, params?: Array<unknown>) => Promise<Array<T>>
  asUser: <T = Row>(
    userId: string | null,
    sql: string,
    params?: Array<unknown>,
  ) => Promise<Array<T>>
  asAnon: <T = Row>(sql: string, params?: Array<unknown>) => Promise<Array<T>>
  createUser: (email?: string) => Promise<string>
  rpcAs: (userId: string | null) => RpcFn
  close: () => Promise<void>
}

const STAND_IN = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_own_account() to authenticated;
`

export function readMigration(): string {
  return readFileSync(join(process.cwd(), MIGRATION_PATH), 'utf8')
}

export function readChecks(): string {
  return readFileSync(join(process.cwd(), CHECKS_PATH), 'utf8')
}

export async function applyMigration(db: PGlite): Promise<void> {
  await db.exec(readMigration())
}

const NAME_RE = /^[a-z_]+$/

export async function startDb(): Promise<SqlTestDb> {
  const db = new PGlite()
  await db.exec(STAND_IN)
  await applyMigration(db)
  await applyMigration(db)

  async function admin<T = Row>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<Array<T>> {
    if (params === undefined) {
      const results = await db.exec(sql)
      const last = results.at(-1)
      return (last?.rows ?? []) as Array<T>
    }
    const result = await db.query<T>(sql, params)
    return result.rows
  }

  async function asRole<T = Row>(
    role: 'authenticated' | 'anon',
    userId: string | null,
    sql: string,
    params: Array<unknown> = [],
  ): Promise<Array<T>> {
    return db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`)
      if (userId !== null) {
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
          userId,
        ])
      }
      const result = await tx.query<T>(sql, params)
      return result.rows
    })
  }

  function rpcAs(userId: string | null): RpcFn {
    return async (fn, args = {}): Promise<RpcResponse> => {
      if (!NAME_RE.test(fn)) throw new Error(`bad function name: ${fn}`)
      const keys = Object.keys(args)
      for (const k of keys) {
        if (!NAME_RE.test(k)) throw new Error(`bad argument name: ${k}`)
      }
      const list = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
      const params = keys.map((k) => {
        const v = args[k]
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
      })
      try {
        const rows = await asRole<{ data: unknown }>(
          'authenticated',
          userId,
          `select public.${fn}(${list}) as data`,
          params,
        )
        return { data: rows[0].data, error: null, status: 200 }
      } catch (e) {
        const err = e as { message?: string; code?: string }
        return {
          data: null,
          error: { message: err.message ?? String(e), code: err.code ?? '' },
          status: 400,
        }
      }
    }
  }

  return {
    db,
    admin,
    asUser: (userId, sql, params) => asRole('authenticated', userId, sql, params),
    asAnon: (sql, params) => asRole('anon', null, sql, params),
    async createUser(email) {
      const id = crypto.randomUUID()
      await db.query('insert into auth.users (id, email) values ($1, $2)', [
        id,
        email ?? `${id}@example.com`,
      ])
      return id
    },
    rpcAs,
    close: () => db.close(),
  }
}

// ── Shared helpers for the SQL test files ───────────────────────────────────

export async function setFreeForAll(
  ctx: SqlTestDb,
  value: boolean,
): Promise<void> {
  await ctx.admin(
    "update public.app_config set value = $1::jsonb where key = 'sync_free_for_all'",
    [JSON.stringify(value)],
  )
}

export function newDeviceId(): string {
  return crypto.randomUUID()
}

export function validHeader(vaultId: string, extra: Row = {}) {
  return {
    v: 2,
    vaultId,
    createdAt: '2026-10-23T10:00:00.000Z',
    kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==' },
    wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
    recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
    verifier: { iv: 'aXY=', ct: 'Y3Q=' },
    ...extra,
  }
}

// A wire record. `n` makes the record_key unique (22 chars, matches the key
// pattern); `ms` is updated_at_ms; `size` is the ciphertext length.
export function wireRecord(n: number, ms = 1000, size = 24, tag = 'c') {
  return {
    record_key: `rk${String(n).padStart(20, '0')}`,
    ciphertext: tag.repeat(size),
    iv: 'aXZpdml2aXZpdml2',
    enc_v: 1,
    updated_at_ms: ms,
  }
}

export function minimaCode(res: RpcResponse): string | null {
  const m = res.error?.message ?? ''
  return m.startsWith('MINIMA:') ? m.slice('MINIMA:'.length) : null
}

// The call failed with exactly `MINIMA:<code>` and returned no data.
export function expectMinima(res: RpcResponse, code: string): void {
  expect(res.error?.message).toBe(`MINIMA:${code}`)
  expect(res.data).toBeNull()
}

export function expectOk<T = unknown>(res: RpcResponse): T {
  expect(res.error).toBeNull()
  return res.data as T
}

// A SQL (not RPC) call failed with exactly `MINIMA:<code>`.
export async function expectSqlMinima(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ message: `MINIMA:${code}` })
}

export async function expectPermissionDenied(
  promise: Promise<unknown>,
): Promise<void> {
  await expect(promise).rejects.toThrow(/permission denied/i)
}

export interface Fixture {
  userId: string
  deviceId: string
  vaultId: string
  rpc: RpcFn
}

// A user with a registered device and a created vault.
export async function userWithVault(
  ctx: SqlTestDb,
  vaultId = `vault-${crypto.randomUUID()}`,
): Promise<Fixture> {
  const userId = await ctx.createUser()
  const deviceId = newDeviceId()
  const rpc = ctx.rpcAs(userId)
  expectOk(
    await rpc('register_device', { p_device_id: deviceId, p_label: 'Test device' }),
  )
  expectOk(
    await rpc('create_vault', {
      p_device_id: deviceId,
      p_vault_id: vaultId,
      p_header: validHeader(vaultId),
    }),
  )
  return { userId, deviceId, vaultId, rpc }
}

export async function push(
  f: Fixture,
  records: Array<unknown>,
  deviceId = f.deviceId,
): Promise<RpcResponse> {
  return f.rpc('push_records', {
    p_device_id: deviceId,
    p_vault_id: f.vaultId,
    p_records: records,
  })
}

export async function pull(
  f: Fixture,
  since: number,
  limit?: number,
  deviceId = f.deviceId,
): Promise<RpcResponse> {
  return f.rpc('pull_records', {
    p_device_id: deviceId,
    p_vault_id: f.vaultId,
    p_since: since,
    ...(limit === undefined ? {} : { p_limit: limit }),
  })
}
