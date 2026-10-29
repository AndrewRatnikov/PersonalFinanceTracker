// Family space SQL harness: the run 2 PGlite harness plus the family migration
// (applied twice, like startDb does for run 2) and fixture helpers for spaces.
//
// No CONTRACT_GAPs: file names, function names, parameter names and return
// shapes come from plan section B6 and the "Test harness (Tester-owned)" part
// of the Interface Contract. harness.ts is re-used, never modified.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'vitest'
import { expectOk, newDeviceId, startDb, wireRecord } from './harness'
import type { PGlite } from '@electric-sql/pglite'
import type { RpcResponse } from '@/lib/cloud/api'
import type { RpcFn } from '@/lib/cloud/rpc'
import type { SqlTestDb } from './harness'

export {
  expectMinima,
  expectOk,
  expectPermissionDenied,
  expectSqlMinima,
  minimaCode,
  newDeviceId,
  setFreeForAll,
  wireRecord,
} from './harness'
export type { Row, SqlTestDb } from './harness'

export const FAMILY_MIGRATION_PATH = 'supabase/migrations/20261029000000_family_spaces.sql'
export const FAMILY_CHECKS_PATH = 'supabase/tests/family_spaces_checks.sql'

// The 16 functions granted to authenticated.
export const FAMILY_FUNCTIONS = [
  'is_active_space_member',
  'get_my_space',
  'create_space',
  'create_invite',
  'revoke_invite',
  'get_invite',
  'request_join',
  'approve_member',
  'reject_member',
  'remove_member',
  'rotate_space_key',
  'leave_space',
  'transfer_ownership',
  'delete_space',
  'push_space_records',
  'pull_space_records',
] as const

// The 5 internal functions: no EXECUTE for anon or authenticated.
export const FAMILY_INTERNAL_FUNCTIONS = [
  'effective_plan_for',
  'has_feature_for',
  'is_valid_public_jwk',
  'is_valid_wrapped_key',
  'space_member_left_on_user_delete',
] as const

export const FAMILY_TABLES = [
  'spaces',
  'space_members',
  'space_invites',
  'space_keys',
  'space_records',
  'space_events',
] as const

export function readFamilyMigration(): string {
  return readFileSync(join(process.cwd(), FAMILY_MIGRATION_PATH), 'utf8')
}

export function readFamilyChecks(): string {
  return readFileSync(join(process.cwd(), FAMILY_CHECKS_PATH), 'utf8')
}

export async function applyFamilyMigration(db: PGlite): Promise<void> {
  await db.exec(readFamilyMigration())
}

// startDb() (the run 2 migration, twice) + the family migration, twice.
export async function startFamilyDb(): Promise<SqlTestDb> {
  const ctx = await startDb()
  await applyFamilyMigration(ctx.db)
  await applyFamilyMigration(ctx.db)
  return ctx
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export type Json = Record<string, unknown>

function b64url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

// A public identity key that passes the server's shape check (the server never
// verifies that the point is on the curve). Each call is different.
export function fakePublicJwk(): Json {
  return { kty: 'EC', crv: 'P-256', x: b64url(), y: b64url() }
}

// A wrapped space key in run A's { v, epk, iv, ct } format. Each call differs.
export function fakeWrappedKey(): Json {
  return {
    v: 1,
    epk: { kty: 'EC', crv: 'P-256', x: b64url(), y: b64url() },
    iv: b64url(12),
    ct: b64url(48),
  }
}

// An invite token and its hash, computed the way the SQL does it.
export function newInviteToken(): { token: string; hash: string } {
  const token = b64url(32)
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function newUuid(): string {
  return randomUUID()
}

export interface FamilyUser {
  userId: string
  email: string
  deviceId: string
  rpc: RpcFn
}

// A user, with a registered device unless `device` is false. Devices are
// registered while sync_free_for_all is on (the beta default).
export async function familyUser(
  ctx: SqlTestDb,
  options: { device?: boolean } = {},
): Promise<FamilyUser> {
  const email = `${randomUUID()}@example.com`
  const userId = await ctx.createUser(email)
  const rpc = ctx.rpcAs(userId)
  const deviceId = newDeviceId()
  if (options.device !== false) {
    expectOk(await rpc('register_device', { p_device_id: deviceId, p_label: 'Test device' }))
  }
  return { userId, email, deviceId, rpc }
}

export async function grantPlan(
  ctx: SqlTestDb,
  userId: string,
  planId: string,
  status = 'active',
  periodEnd: string | null = null,
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

// Changes some plan features for the duration of `fn`, then restores them.
export async function withPlanFeatures<T>(
  ctx: SqlTestDb,
  planId: string,
  patch: Json,
  fn: () => Promise<T>,
): Promise<T> {
  const before = await ctx.admin<{ features: Json }>(
    'select features from public.plans where id = $1',
    [planId],
  )
  await ctx.admin('update public.plans set features = features || $2::jsonb where id = $1', [
    planId,
    JSON.stringify(patch),
  ])
  try {
    return await fn()
  } finally {
    await ctx.admin('update public.plans set features = $2::jsonb where id = $1', [
      planId,
      JSON.stringify(before[0].features),
    ])
  }
}

// ── Space building ──────────────────────────────────────────────────────────

export async function createFamilySpace(
  owner: FamilyUser,
  spaceId: string = randomUUID(),
  publicKey: Json = fakePublicJwk(),
  wrappedKey: Json = fakeWrappedKey(),
): Promise<string> {
  expectOk(
    await owner.rpc('create_space', {
      p_space_id: spaceId,
      p_public_key: publicKey,
      p_wrapped_key_for_self: wrappedKey,
    }),
  )
  return spaceId
}

export interface Invite {
  inviteId: string
  token: string
  hash: string
}

export async function makeInvite(
  owner: FamilyUser,
  spaceId: string,
  hours?: number,
): Promise<Invite> {
  const { token, hash } = newInviteToken()
  const res = expectOk<{ invite_id: string }>(
    await owner.rpc('create_invite', {
      p_space_id: spaceId,
      p_token_hash: hash,
      ...(hours === undefined ? {} : { p_expires_in_hours: hours }),
    }),
  )
  return { inviteId: res.invite_id, token, hash }
}

export interface Join extends Invite {
  publicKey: Json
}

// The joiner requests to join with a fresh invite from the owner.
export async function requestToJoin(
  owner: FamilyUser,
  spaceId: string,
  joiner: FamilyUser,
): Promise<Join> {
  const invite = await makeInvite(owner, spaceId)
  const publicKey = fakePublicJwk()
  expectOk(
    await joiner.rpc('request_join', {
      p_invite_id: invite.inviteId,
      p_token: invite.token,
      p_public_key: publicKey,
    }),
  )
  return { ...invite, publicKey }
}

export async function approveMember(
  owner: FamilyUser,
  spaceId: string,
  joiner: FamilyUser,
  wrappedKey: Json = fakeWrappedKey(),
  keyVersion = 1,
): Promise<Json> {
  expectOk(
    await owner.rpc('approve_member', {
      p_space_id: spaceId,
      p_user_id: joiner.userId,
      p_key_version: keyVersion,
      p_wrapped_key: wrappedKey,
    }),
  )
  return wrappedKey
}

export async function joinAndApprove(
  owner: FamilyUser,
  spaceId: string,
  joiner: FamilyUser,
  keyVersion = 1,
): Promise<{ join: Join; wrappedKey: Json }> {
  const join = await requestToJoin(owner, spaceId, joiner)
  const wrappedKey = await approveMember(owner, spaceId, joiner, fakeWrappedKey(), keyVersion)
  return { join, wrappedKey }
}

export interface FamilySpace {
  spaceId: string
  owner: FamilyUser
  members: Array<FamilyUser>
  pending: Array<FamilyUser>
}

// An owner with `active` approved members and `pending` waiting requests.
export async function buildSpace(
  ctx: SqlTestDb,
  options: { active?: number; pending?: number } = {},
): Promise<FamilySpace> {
  const owner = await familyUser(ctx)
  const spaceId = await createFamilySpace(owner)
  const members: Array<FamilyUser> = []
  const pending: Array<FamilyUser> = []
  for (let i = 0; i < (options.active ?? 0); i++) {
    const member = await familyUser(ctx)
    await joinAndApprove(owner, spaceId, member)
    members.push(member)
  }
  for (let i = 0; i < (options.pending ?? 0); i++) {
    const waiting = await familyUser(ctx)
    await requestToJoin(owner, spaceId, waiting)
    pending.push(waiting)
  }
  return { spaceId, owner, members, pending }
}

// ── Records ─────────────────────────────────────────────────────────────────

export const spaceRecord = wireRecord

export interface PushedRecord {
  record_key: string
  status: 'accepted' | 'stale'
  seq?: number
  current?: PulledRecord
}

export interface PulledRecord {
  record_key: string
  ciphertext: string
  iv: string
  enc_v: number
  updated_at_ms: number
  key_version: number
  author_id: string
  device_id: string
  seq: number
}

export interface PushOutcome {
  results: Array<PushedRecord>
  last_seq: number
}

export interface PullOutcome {
  records: Array<PulledRecord>
  has_more: boolean
  last_seq: number
  key_version: number
}

export async function pushSpace(
  user: FamilyUser,
  spaceId: string,
  records: Array<unknown>,
  keyVersion = 1,
  deviceId: string = user.deviceId,
): Promise<RpcResponse> {
  return user.rpc('push_space_records', {
    p_space_id: spaceId,
    p_device_id: deviceId,
    p_key_version: keyVersion,
    p_records: records,
  })
}

export async function pullSpace(
  user: FamilyUser,
  spaceId: string,
  since = 0,
  limit?: number,
  deviceId: string = user.deviceId,
): Promise<RpcResponse> {
  return user.rpc('pull_space_records', {
    p_space_id: spaceId,
    p_device_id: deviceId,
    p_since: since,
    ...(limit === undefined ? {} : { p_limit: limit }),
  })
}

export async function rotateKey(
  owner: FamilyUser,
  spaceId: string,
  newVersion: number,
  userIds: Array<string>,
): Promise<RpcResponse> {
  return owner.rpc('rotate_space_key', {
    p_space_id: spaceId,
    p_new_version: newVersion,
    p_wraps: userIds.map((id) => ({ user_id: id, wrapped_key: fakeWrappedKey() })),
  })
}

// key_outdated carries the current version in the message (decision D4).
export function expectKeyOutdated(res: RpcResponse, current: number): void {
  expect(res.error?.message).toBe(`MINIMA:key_outdated:${current}`)
  expect(res.data).toBeNull()
}

// ── Inspection (admin) ──────────────────────────────────────────────────────

export async function countRows(
  ctx: SqlTestDb,
  table: (typeof FAMILY_TABLES)[number],
  spaceId: string,
): Promise<number> {
  const col = table === 'spaces' ? 'id' : 'space_id'
  const rows = await ctx.admin<{ n: number }>(
    `select count(*)::int as n from public.${table} where ${col} = $1`,
    [spaceId],
  )
  return rows[0].n
}

export async function eventsOf(
  ctx: SqlTestDb,
  spaceId: string,
): Promise<Array<{ kind: string; actor_id: string | null; subject_id: string | null }>> {
  return ctx.admin(
    'select kind, actor_id, subject_id from public.space_events where space_id = $1 order by id',
    [spaceId],
  )
}

export async function eventKinds(ctx: SqlTestDb, spaceId: string): Promise<Array<string>> {
  return (await eventsOf(ctx, spaceId)).map((e) => e.kind)
}
