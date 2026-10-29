// Typed client for the Family space server functions
// (supabase/migrations/20261029000000_family_spaces.sql, docs/db.md §9). Every
// argument name is the SQL parameter name, every result is validated at
// runtime, and every failure rejects with a CloudError from ./rpc.
//
// Nothing in the app calls this yet (run C does). There is deliberately no
// default rpc and no Supabase import: a caller must pass its own RpcFn. This
// module never imports ./api (guard test, decision D7).
//
// key_outdated carries the current key version in the message
// (`MINIMA:key_outdated:<n>`, decision D4); currentKeyVersionOf reads it.

import { z } from 'zod'

import { CloudError } from './rpc'
import { SERVER_ERROR_CODES, SPACE_SERVER_ERROR_CODES } from './types'
import type { RpcFn, RpcResponse } from './rpc'
import type { CloudErrorCode, EncryptedSyncRecord } from './types'
import type { WrappedSpaceKey } from '@/lib/spaces/spaceCrypto'
import type { SpaceRole } from '@/lib/spaces/types'

// ── Wire types (mirror the SQL return shapes) ─────────────────────────────────

export type SpaceMemberStatus = 'pending' | 'active'

export interface SpaceMember {
  user_id: string
  email: string | null
  role: SpaceRole
  status: SpaceMemberStatus
  public_key: JsonWebKey
  requested_at: string
  joined_at: string | null
}

export interface SpaceKeyWrap {
  key_version: number
  wrapped_key: WrappedSpaceKey
}

export interface SpaceOpenInvite {
  id: string
  expires_at: string
}

// The caller's membership (pending or active). While pending, key_version,
// owner_id, limits and the totals are null and the lists are empty.
export interface MySpace {
  space_id: string
  role: SpaceRole
  status: SpaceMemberStatus
  key_version: number | null
  owner_id: string | null
  members: Array<SpaceMember>
  my_keys: Array<SpaceKeyWrap>
  open_invites: Array<SpaceOpenInvite>
  paused: boolean
  limits: Record<string, unknown> | null
  last_seq: number | null
  record_count: number | null
  total_bytes: number | null
}

export interface CreatedSpace {
  space_id: string
  key_version: number
}

export interface CreatedInvite {
  invite_id: string
  expires_at: string
}

export interface RevokedInvite {
  invite_id: string
  revoked_at: string
}

export interface InviteInfo {
  space_id: string
  owner_email: string | null
  members_count: number
  expires_at: string
}

export interface JoinRequest {
  space_id: string
  status: 'pending'
}

export interface ApprovedMember {
  user_id: string
  status: 'active'
  key_version: number
}

export interface MemberRef {
  user_id: string
}

export interface RotateWrap {
  user_id: string
  wrapped_key: WrappedSpaceKey
}

export interface SpaceKeyVersion {
  space_id: string
  key_version: number
}

export interface SpaceRef {
  space_id: string
}

export interface OwnershipTransfer {
  space_id: string
  owner_id: string
}

export interface SpaceRecordRow extends EncryptedSyncRecord {
  key_version: number
  author_id: string
  device_id: string
  seq: number
}

export type SpacePushRecordResult =
  | { record_key: string; status: 'accepted'; seq: number }
  | { record_key: string; status: 'stale'; current: SpaceRecordRow }

export interface SpacePushResult {
  results: Array<SpacePushRecordResult>
  last_seq: number
}

export interface SpacePullResult {
  records: Array<SpaceRecordRow>
  has_more: boolean
  last_seq: number
  key_version: number
}

export interface SpacesApi {
  getMySpace: () => Promise<MySpace | null>
  createSpace: (
    spaceId: string,
    publicKey: JsonWebKey,
    wrappedKeyForSelf: WrappedSpaceKey,
  ) => Promise<CreatedSpace>
  createInvite: (
    spaceId: string,
    tokenHash: string,
    expiresInHours?: number,
  ) => Promise<CreatedInvite>
  revokeInvite: (inviteId: string) => Promise<RevokedInvite>
  getInvite: (inviteId: string, token: string) => Promise<InviteInfo>
  requestJoin: (
    inviteId: string,
    token: string,
    publicKey: JsonWebKey,
  ) => Promise<JoinRequest>
  approveMember: (
    spaceId: string,
    userId: string,
    keyVersion: number,
    wrappedKey: WrappedSpaceKey,
  ) => Promise<ApprovedMember>
  rejectMember: (spaceId: string, userId: string) => Promise<MemberRef>
  removeMember: (spaceId: string, userId: string) => Promise<MemberRef>
  rotateSpaceKey: (
    spaceId: string,
    newVersion: number,
    wraps: Array<RotateWrap>,
  ) => Promise<SpaceKeyVersion>
  leaveSpace: () => Promise<SpaceRef>
  transferOwnership: (
    spaceId: string,
    userId: string,
  ) => Promise<OwnershipTransfer>
  deleteSpace: (spaceId: string) => Promise<SpaceRef>
  pushSpaceRecords: (
    spaceId: string,
    deviceId: string,
    keyVersion: number,
    records: Array<EncryptedSyncRecord>,
  ) => Promise<SpacePushResult>
  pullSpaceRecords: (
    spaceId: string,
    deviceId: string,
    since: number,
    limit?: number,
  ) => Promise<SpacePullResult>
}

// ── Error mapping ─────────────────────────────────────────────────────────────

const MINIMA_CODE = /MINIMA:([a-z_]+)/
const KEY_OUTDATED_VERSION = /MINIMA:key_outdated:(\d+)/

const KNOWN_CODES: ReadonlyArray<string> = [
  ...SERVER_ERROR_CODES,
  ...SPACE_SERVER_ERROR_CODES,
]

function isKnownCode(code: string): code is CloudErrorCode {
  return KNOWN_CODES.includes(code)
}

function errorFromResponse(res: RpcResponse): CloudError {
  const message = res.error?.message ?? ''
  const match = MINIMA_CODE.exec(message)
  if (match) {
    return new CloudError(isKnownCode(match[1]) ? match[1] : 'unknown', message)
  }
  // postgrest-js reports a failed fetch as status 0.
  if (res.status === 0)
    return new CloudError('network', message || 'Network error')
  if (res.status === 401) {
    return new CloudError('not_signed_in', message || 'Not signed in')
  }
  return new CloudError('unknown', message || 'Unexpected server error')
}

// The current key version carried by a key_outdated error
// (`MINIMA:key_outdated:<n>`), or null for anything else.
export function currentKeyVersionOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { name?: unknown; code?: unknown; message?: unknown }
  if (!(err instanceof CloudError) && e.name !== 'CloudError') return null
  if (e.code !== 'key_outdated' || typeof e.message !== 'string') return null
  const match = KEY_OUTDATED_VERSION.exec(e.message)
  return match ? Number(match[1]) : null
}

// ── Response schemas ──────────────────────────────────────────────────────────
// Keys (public_key, epk, limits) are plain objects passed through unchanged,
// so nothing a member published is stripped.

const objectSchema = z.record(z.string(), z.unknown())

const wrappedKeySchema = z.looseObject({
  v: z.literal(1),
  epk: objectSchema,
  iv: z.string(),
  ct: z.string(),
})

const roleSchema = z.enum(['owner', 'member'])
const statusSchema = z.enum(['pending', 'active'])

const memberSchema = z.object({
  user_id: z.string(),
  email: z.string().nullable(),
  role: roleSchema,
  status: statusSchema,
  public_key: objectSchema,
  requested_at: z.string(),
  joined_at: z.string().nullable(),
})

const mySpaceSchema = z
  .object({
    space_id: z.string(),
    role: roleSchema,
    status: statusSchema,
    key_version: z.number().nullable(),
    owner_id: z.string().nullable(),
    members: z.array(memberSchema),
    my_keys: z.array(
      z.object({ key_version: z.number(), wrapped_key: wrappedKeySchema }),
    ),
    open_invites: z.array(z.object({ id: z.string(), expires_at: z.string() })),
    paused: z.boolean(),
    limits: objectSchema.nullable(),
    last_seq: z.number().nullable(),
    record_count: z.number().nullable(),
    total_bytes: z.number().nullable(),
  })
  .nullable()

const createdSpaceSchema = z.object({
  space_id: z.string(),
  key_version: z.number(),
})

const createdInviteSchema = z.object({
  invite_id: z.string(),
  expires_at: z.string(),
})

const revokedInviteSchema = z.object({
  invite_id: z.string(),
  revoked_at: z.string(),
})

const inviteInfoSchema = z.object({
  space_id: z.string(),
  owner_email: z.string().nullable(),
  members_count: z.number(),
  expires_at: z.string(),
})

const joinRequestSchema = z.object({
  space_id: z.string(),
  status: z.literal('pending'),
})

const approvedMemberSchema = z.object({
  user_id: z.string(),
  status: z.literal('active'),
  key_version: z.number(),
})

const memberRefSchema = z.object({ user_id: z.string() })

const spaceKeyVersionSchema = z.object({
  space_id: z.string(),
  key_version: z.number(),
})

const spaceRefSchema = z.object({ space_id: z.string() })

const ownershipTransferSchema = z.object({
  space_id: z.string(),
  owner_id: z.string(),
})

const recordRowSchema = z.object({
  record_key: z.string(),
  ciphertext: z.string(),
  iv: z.string(),
  enc_v: z.number(),
  updated_at_ms: z.number(),
  key_version: z.number(),
  author_id: z.string(),
  device_id: z.string(),
  seq: z.number(),
})

const pushResultSchema = z.object({
  results: z.array(
    z.discriminatedUnion('status', [
      z.object({
        record_key: z.string(),
        status: z.literal('accepted'),
        seq: z.number(),
      }),
      z.object({
        record_key: z.string(),
        status: z.literal('stale'),
        current: recordRowSchema,
      }),
    ]),
  ),
  last_seq: z.number(),
})

const pullResultSchema = z.object({
  records: z.array(recordRowSchema),
  has_more: z.boolean(),
  last_seq: z.number(),
  key_version: z.number(),
})

// ── Client ────────────────────────────────────────────────────────────────────

export function createSpacesApi(rpc: RpcFn): SpacesApi {
  async function call<T>(
    fn: string,
    args: Record<string, unknown>,
    schema: z.ZodType,
  ): Promise<T> {
    let res: RpcResponse
    try {
      res = await rpc(fn, args)
    } catch (err) {
      // A rejected call never reached the server (e.g. "Failed to fetch").
      throw new CloudError(
        'network',
        err instanceof Error && err.message ? err.message : 'Network error',
      )
    }
    if (res.error) throw errorFromResponse(res)
    const parsed = schema.safeParse(res.data)
    if (!parsed.success) {
      throw new CloudError('unknown', `Unexpected response from ${fn}`)
    }
    // The schema mirrors T; JSON objects (keys, limits) pass through as-is.
    return parsed.data as T
  }

  return {
    getMySpace: () => call<MySpace | null>('get_my_space', {}, mySpaceSchema),
    createSpace: (spaceId, publicKey, wrappedKeyForSelf) =>
      call<CreatedSpace>(
        'create_space',
        {
          p_space_id: spaceId,
          p_public_key: publicKey,
          p_wrapped_key_for_self: wrappedKeyForSelf,
        },
        createdSpaceSchema,
      ),
    createInvite: (spaceId, tokenHash, expiresInHours) =>
      call<CreatedInvite>(
        'create_invite',
        {
          p_space_id: spaceId,
          p_token_hash: tokenHash,
          ...(expiresInHours === undefined
            ? {}
            : { p_expires_in_hours: expiresInHours }),
        },
        createdInviteSchema,
      ),
    revokeInvite: (inviteId) =>
      call<RevokedInvite>(
        'revoke_invite',
        { p_invite_id: inviteId },
        revokedInviteSchema,
      ),
    getInvite: (inviteId, token) =>
      call<InviteInfo>(
        'get_invite',
        { p_invite_id: inviteId, p_token: token },
        inviteInfoSchema,
      ),
    requestJoin: (inviteId, token, publicKey) =>
      call<JoinRequest>(
        'request_join',
        { p_invite_id: inviteId, p_token: token, p_public_key: publicKey },
        joinRequestSchema,
      ),
    approveMember: (spaceId, userId, keyVersion, wrappedKey) =>
      call<ApprovedMember>(
        'approve_member',
        {
          p_space_id: spaceId,
          p_user_id: userId,
          p_key_version: keyVersion,
          p_wrapped_key: wrappedKey,
        },
        approvedMemberSchema,
      ),
    rejectMember: (spaceId, userId) =>
      call<MemberRef>(
        'reject_member',
        { p_space_id: spaceId, p_user_id: userId },
        memberRefSchema,
      ),
    removeMember: (spaceId, userId) =>
      call<MemberRef>(
        'remove_member',
        { p_space_id: spaceId, p_user_id: userId },
        memberRefSchema,
      ),
    rotateSpaceKey: (spaceId, newVersion, wraps) =>
      call<SpaceKeyVersion>(
        'rotate_space_key',
        { p_space_id: spaceId, p_new_version: newVersion, p_wraps: wraps },
        spaceKeyVersionSchema,
      ),
    leaveSpace: () => call<SpaceRef>('leave_space', {}, spaceRefSchema),
    transferOwnership: (spaceId, userId) =>
      call<OwnershipTransfer>(
        'transfer_ownership',
        { p_space_id: spaceId, p_user_id: userId },
        ownershipTransferSchema,
      ),
    deleteSpace: (spaceId) =>
      call<SpaceRef>('delete_space', { p_space_id: spaceId }, spaceRefSchema),
    pushSpaceRecords: (spaceId, deviceId, keyVersion, records) =>
      call<SpacePushResult>(
        'push_space_records',
        {
          p_space_id: spaceId,
          p_device_id: deviceId,
          p_key_version: keyVersion,
          p_records: records,
        },
        pushResultSchema,
      ),
    pullSpaceRecords: (spaceId, deviceId, since, limit) =>
      call<SpacePullResult>(
        'pull_space_records',
        {
          p_space_id: spaceId,
          p_device_id: deviceId,
          p_since: since,
          ...(limit === undefined ? {} : { p_limit: limit }),
        },
        pullResultSchema,
      ),
  }
}
