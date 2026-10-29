// No CONTRACT_GAPs: createSpacesApi, currentKeyVersionOf, the argument names and
// the failure mappings are specified in the Interface Contract (spacesApi.ts)
// and plan section D. A fake rpc is used: no network, no database.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpcFn, RpcResponse } from '@/lib/cloud/rpc'
import type { SpacesApi } from '@/lib/cloud/spacesApi'
import type { WrappedSpaceKey } from '@/lib/spaces/spaceCrypto'
import { CloudError } from '@/lib/cloud/rpc'
import { createSpacesApi, currentKeyVersionOf } from '@/lib/cloud/spacesApi'
import { SERVER_ERROR_CODES, SPACE_SERVER_ERROR_CODES } from '@/lib/cloud/types'

const SPACE = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const INVITE = '33333333-3333-4333-8333-333333333333'
const DEVICE = '44444444-4444-4444-8444-444444444444'
const OWNER = '55555555-5555-4555-8555-555555555555'
const NOW = '2026-10-29T10:00:00.000Z'
const HASH = 'ab'.repeat(32)

const JWK: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'eHh4', y: 'eXl5' }
const WRAP: WrappedSpaceKey = { v: 1, epk: JWK, iv: 'aXZpdml2aXZp', ct: 'Y2lwaGVydGV4dA==' }

const ENCRYPTED = {
  record_key: 'k'.repeat(43),
  ciphertext: 'Y2lwaGVy',
  iv: 'aXZpdml2aXZpdml2',
  enc_v: 1,
  updated_at_ms: 1000,
}
const ROW = { ...ENCRYPTED, key_version: 1, author_id: OWNER, device_id: DEVICE, seq: 4 }

const MY_SPACE = {
  space_id: SPACE,
  role: 'owner',
  status: 'active',
  key_version: 1,
  owner_id: OWNER,
  members: [
    {
      user_id: OWNER,
      email: 'owner@example.com',
      role: 'owner',
      status: 'active',
      public_key: JWK,
      requested_at: NOW,
      joined_at: NOW,
    },
    {
      user_id: USER,
      email: null,
      role: 'member',
      status: 'pending',
      public_key: JWK,
      requested_at: NOW,
      joined_at: null,
    },
  ],
  my_keys: [{ key_version: 1, wrapped_key: WRAP }],
  open_invites: [{ id: INVITE, expires_at: NOW }],
  paused: false,
  limits: { shared_spaces: true, max_members: 6 },
  last_seq: 4,
  record_count: 2,
  total_bytes: 48,
}

const PENDING_SPACE = {
  space_id: SPACE,
  role: 'member',
  status: 'pending',
  key_version: null,
  owner_id: null,
  members: [],
  my_keys: [],
  open_invites: [],
  paused: false,
  limits: null,
  last_seq: null,
  record_count: null,
  total_bytes: null,
}

const rpc = vi.fn<RpcFn>()
let api: SpacesApi

function respond(data: unknown): void {
  rpc.mockResolvedValueOnce({ data, error: null, status: 200 })
}

function fail(message: string, status = 400): void {
  rpc.mockResolvedValueOnce({
    data: null,
    error: { message, code: 'P0001' },
    status,
  } satisfies RpcResponse)
}

async function rejection(promise: Promise<unknown>): Promise<CloudError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CloudError)
  return err as CloudError
}

beforeEach(() => {
  rpc.mockReset()
  api = createSpacesApi(rpc)
})

interface Case {
  name: string
  fn: string
  call: (a: SpacesApi) => Promise<unknown>
  args: Record<string, unknown>
  data: unknown
}

const CASES: Array<Case> = [
  {
    name: 'getMySpace',
    fn: 'get_my_space',
    call: (a) => a.getMySpace(),
    args: {},
    data: MY_SPACE,
  },
  {
    name: 'createSpace',
    fn: 'create_space',
    call: (a) => a.createSpace(SPACE, JWK, WRAP),
    args: { p_space_id: SPACE, p_public_key: JWK, p_wrapped_key_for_self: WRAP },
    data: { space_id: SPACE, key_version: 1 },
  },
  {
    name: 'createInvite',
    fn: 'create_invite',
    call: (a) => a.createInvite(SPACE, HASH),
    args: { p_space_id: SPACE, p_token_hash: HASH },
    data: { invite_id: INVITE, expires_at: NOW },
  },
  {
    name: 'revokeInvite',
    fn: 'revoke_invite',
    call: (a) => a.revokeInvite(INVITE),
    args: { p_invite_id: INVITE },
    data: { invite_id: INVITE, revoked_at: NOW },
  },
  {
    name: 'getInvite',
    fn: 'get_invite',
    call: (a) => a.getInvite(INVITE, 'the-token'),
    args: { p_invite_id: INVITE, p_token: 'the-token' },
    data: { space_id: SPACE, owner_email: 'owner@example.com', members_count: 2, expires_at: NOW },
  },
  {
    name: 'requestJoin',
    fn: 'request_join',
    call: (a) => a.requestJoin(INVITE, 'the-token', JWK),
    args: { p_invite_id: INVITE, p_token: 'the-token', p_public_key: JWK },
    data: { space_id: SPACE, status: 'pending' },
  },
  {
    name: 'approveMember',
    fn: 'approve_member',
    call: (a) => a.approveMember(SPACE, USER, 3, WRAP),
    args: { p_space_id: SPACE, p_user_id: USER, p_key_version: 3, p_wrapped_key: WRAP },
    data: { user_id: USER, status: 'active', key_version: 3 },
  },
  {
    name: 'rejectMember',
    fn: 'reject_member',
    call: (a) => a.rejectMember(SPACE, USER),
    args: { p_space_id: SPACE, p_user_id: USER },
    data: { user_id: USER },
  },
  {
    name: 'removeMember',
    fn: 'remove_member',
    call: (a) => a.removeMember(SPACE, USER),
    args: { p_space_id: SPACE, p_user_id: USER },
    data: { user_id: USER },
  },
  {
    name: 'rotateSpaceKey',
    fn: 'rotate_space_key',
    call: (a) =>
      a.rotateSpaceKey(SPACE, 2, [
        { user_id: OWNER, wrapped_key: WRAP },
        { user_id: USER, wrapped_key: WRAP },
      ]),
    args: {
      p_space_id: SPACE,
      p_new_version: 2,
      p_wraps: [
        { user_id: OWNER, wrapped_key: WRAP },
        { user_id: USER, wrapped_key: WRAP },
      ],
    },
    data: { space_id: SPACE, key_version: 2 },
  },
  {
    name: 'leaveSpace',
    fn: 'leave_space',
    call: (a) => a.leaveSpace(),
    args: {},
    data: { space_id: SPACE },
  },
  {
    name: 'transferOwnership',
    fn: 'transfer_ownership',
    call: (a) => a.transferOwnership(SPACE, USER),
    args: { p_space_id: SPACE, p_user_id: USER },
    data: { space_id: SPACE, owner_id: USER },
  },
  {
    name: 'deleteSpace',
    fn: 'delete_space',
    call: (a) => a.deleteSpace(SPACE),
    args: { p_space_id: SPACE },
    data: { space_id: SPACE },
  },
  {
    name: 'pushSpaceRecords',
    fn: 'push_space_records',
    call: (a) => a.pushSpaceRecords(SPACE, DEVICE, 2, [ENCRYPTED]),
    args: { p_space_id: SPACE, p_device_id: DEVICE, p_key_version: 2, p_records: [ENCRYPTED] },
    data: {
      results: [
        { record_key: ENCRYPTED.record_key, status: 'accepted', seq: 5 },
        { record_key: 'j'.repeat(43), status: 'stale', current: ROW },
      ],
      last_seq: 5,
    },
  },
  {
    name: 'pullSpaceRecords',
    fn: 'pull_space_records',
    call: (a) => a.pullSpaceRecords(SPACE, DEVICE, 7),
    args: { p_space_id: SPACE, p_device_id: DEVICE, p_since: 7 },
    data: { records: [ROW], has_more: true, last_seq: 4, key_version: 2 },
  },
]

describe('every method calls the right function with the SQL argument names', () => {
  it.each(CASES)('$name -> $fn', async ({ fn, call, args, data }) => {
    respond(data)
    const result = await call(api)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][0]).toBe(fn)
    expect(rpc.mock.calls[0][1] ?? {}).toEqual(args)
    expect(result).toEqual(data)
  })

  it('covers all 15 methods once', () => {
    expect(new Set(CASES.map((c) => c.fn)).size).toBe(15)
    expect(Object.keys(api).sort()).toEqual(CASES.map((c) => c.name).sort())
  })

  it('getMySpace accepts null and a pending view', async () => {
    respond(null)
    expect(await api.getMySpace()).toBeNull()
    respond(PENDING_SPACE)
    expect(await api.getMySpace()).toEqual(PENDING_SPACE)
  })

  it('getInvite accepts a null owner_email', async () => {
    respond({ space_id: SPACE, owner_email: null, members_count: 1, expires_at: NOW })
    expect((await api.getInvite(INVITE, 't')).owner_email).toBeNull()
  })

  it('pushSpaceRecords returns accepted and stale results as sent', async () => {
    respond({
      results: [
        { record_key: 'a'.repeat(22), status: 'stale', current: ROW },
        { record_key: 'b'.repeat(22), status: 'accepted', seq: 9 },
      ],
      last_seq: 9,
    })
    const res = await api.pushSpaceRecords(SPACE, DEVICE, 1, [ENCRYPTED])
    expect(res.results[0]).toEqual({ record_key: 'a'.repeat(22), status: 'stale', current: ROW })
    expect(res.results[1]).toEqual({ record_key: 'b'.repeat(22), status: 'accepted', seq: 9 })
    expect(res.last_seq).toBe(9)
  })
})

describe('optional arguments are omitted when undefined', () => {
  it('createInvite sends p_expires_in_hours only when given', async () => {
    respond({ invite_id: INVITE, expires_at: NOW })
    await api.createInvite(SPACE, HASH)
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_expires_in_hours')

    respond({ invite_id: INVITE, expires_at: NOW })
    await api.createInvite(SPACE, HASH, 24)
    expect(rpc.mock.calls[1][1]).toEqual({
      p_space_id: SPACE,
      p_token_hash: HASH,
      p_expires_in_hours: 24,
    })

    respond({ invite_id: INVITE, expires_at: NOW })
    await api.createInvite(SPACE, HASH, undefined)
    expect(rpc.mock.calls[2][1]).not.toHaveProperty('p_expires_in_hours')
  })

  it('pullSpaceRecords sends p_limit only when given', async () => {
    const page = { records: [], has_more: false, last_seq: 0, key_version: 1 }
    respond(page)
    await api.pullSpaceRecords(SPACE, DEVICE, 0)
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_limit')

    respond(page)
    await api.pullSpaceRecords(SPACE, DEVICE, 12, 25)
    expect(rpc.mock.calls[1][1]).toEqual({
      p_space_id: SPACE,
      p_device_id: DEVICE,
      p_since: 12,
      p_limit: 25,
    })
  })
})

describe('runtime validation of results', () => {
  it.each(CASES)('$name rejects an unexpected response with an unknown error', async ({ fn, call }) => {
    for (const bad of [{ unexpected: true }, 'oops', 42]) {
      respond(bad)
      const err = await rejection(call(api))
      expect(err.code).toBe('unknown')
      expect(err.message).toContain(fn)
    }
  })

  it('a missing or mistyped field is unknown', async () => {
    respond({ space_id: SPACE })
    expect((await rejection(api.createSpace(SPACE, JWK, WRAP))).code).toBe('unknown')
    respond({ invite_id: INVITE })
    expect((await rejection(api.createInvite(SPACE, HASH))).code).toBe('unknown')
    respond({ space_id: SPACE, status: 'active' })
    expect((await rejection(api.requestJoin(INVITE, 't', JWK))).code).toBe('unknown')
    respond({ user_id: USER, status: 'pending', key_version: 1 })
    expect((await rejection(api.approveMember(SPACE, USER, 1, WRAP))).code).toBe('unknown')
    respond({ records: [ROW], has_more: 'no', last_seq: 4, key_version: 1 })
    expect((await rejection(api.pullSpaceRecords(SPACE, DEVICE, 0))).code).toBe('unknown')
  })

  it('a push result with a wrong status or a stale result without a row is unknown', async () => {
    respond({ results: [{ record_key: 'a'.repeat(22), status: 'weird', seq: 1 }], last_seq: 1 })
    expect((await rejection(api.pushSpaceRecords(SPACE, DEVICE, 1, [ENCRYPTED]))).code).toBe(
      'unknown',
    )
    respond({ results: [{ record_key: 'a'.repeat(22), status: 'stale' }], last_seq: 1 })
    expect((await rejection(api.pushSpaceRecords(SPACE, DEVICE, 1, [ENCRYPTED]))).code).toBe(
      'unknown',
    )
    respond({ results: [{ record_key: 'a'.repeat(22), status: 'accepted' }], last_seq: 1 })
    expect((await rejection(api.pushSpaceRecords(SPACE, DEVICE, 1, [ENCRYPTED]))).code).toBe(
      'unknown',
    )
  })

  it('get_my_space with a bad role, status or wrapped key is unknown', async () => {
    respond({ ...MY_SPACE, role: 'admin' })
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
    respond({ ...MY_SPACE, status: 'banned' })
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
    respond({ ...MY_SPACE, my_keys: [{ key_version: 1, wrapped_key: { ...WRAP, v: 2 } }] })
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
    respond({ ...MY_SPACE, members: [{ ...MY_SPACE.members[0], user_id: undefined }] })
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
    respond({ ...MY_SPACE, paused: 'false' })
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
  })
})

describe('error mapping', () => {
  const ALL_CODES = [...SERVER_ERROR_CODES, ...SPACE_SERVER_ERROR_CODES]

  it('the new codes are a separate list of exactly 12, in order', () => {
    expect([...SPACE_SERVER_ERROR_CODES]).toEqual([
      'not_space_member',
      'not_space_owner',
      'already_in_space',
      'invite_invalid',
      'member_limit',
      'wrong_key_version',
      'key_outdated',
      'members_mismatch',
      'space_paused',
      'space_gone',
      'cannot_remove_owner',
      'owner_must_transfer_or_delete',
    ])
    expect(SERVER_ERROR_CODES).toHaveLength(12)
    for (const code of SPACE_SERVER_ERROR_CODES) {
      expect((SERVER_ERROR_CODES as ReadonlyArray<string>).includes(code)).toBe(false)
    }
  })

  it.each(ALL_CODES)('MINIMA:%s becomes a CloudError with that code', async (code) => {
    fail(`MINIMA:${code}`)
    const err = await rejection(api.getMySpace())
    expect(err.code).toBe(code)
    expect(err.name).toBe('CloudError')

    fail(`MINIMA:${code}`)
    expect((await rejection(api.deleteSpace(SPACE))).code).toBe(code)
  })

  it('finds the code inside a longer message and keeps the whole message', async () => {
    fail('ERROR: MINIMA:space_gone (extra)')
    const err = await rejection(api.getInvite(INVITE, 't'))
    expect(err.code).toBe('space_gone')
    expect(err.message).toContain('MINIMA:space_gone')
  })

  it('an unknown MINIMA code is unknown', async () => {
    fail('MINIMA:bogus_code')
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
  })

  it('a non-MINIMA error maps by status', async () => {
    fail('fetch failed', 0)
    expect((await rejection(api.getMySpace())).code).toBe('network')
    fail('JWT expired', 401)
    expect((await rejection(api.getMySpace())).code).toBe('not_signed_in')
    fail('boom', 500)
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
    fail('permission denied for table spaces', 403)
    expect((await rejection(api.getMySpace())).code).toBe('unknown')
  })

  it('a rejected rpc becomes a network error', async () => {
    rpc.mockRejectedValueOnce(new Error('offline'))
    expect((await rejection(api.getMySpace())).code).toBe('network')
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await rejection(api.pushSpaceRecords(SPACE, DEVICE, 1, [ENCRYPTED]))).code).toBe(
      'network',
    )
  })

  it('every method maps a server error', async () => {
    for (const { call } of CASES) {
      fail('MINIMA:space_paused')
      expect((await rejection(call(api))).code).toBe('space_paused')
    }
  })
})

describe('currentKeyVersionOf', () => {
  it('reads the version from key_outdated:<n>', async () => {
    fail('MINIMA:key_outdated:2')
    const err = await rejection(api.pushSpaceRecords(SPACE, DEVICE, 1, [ENCRYPTED]))
    expect(err.code).toBe('key_outdated')
    expect(currentKeyVersionOf(err)).toBe(2)

    fail('MINIMA:key_outdated:17')
    expect(currentKeyVersionOf(await rejection(api.getMySpace()))).toBe(17)
  })

  it('is null without a number, for other codes and for other values', () => {
    expect(currentKeyVersionOf(new CloudError('key_outdated', 'MINIMA:key_outdated'))).toBeNull()
    expect(currentKeyVersionOf(new CloudError('key_outdated'))).toBeNull()
    expect(
      currentKeyVersionOf(new CloudError('wrong_key_version', 'MINIMA:key_outdated:3')),
    ).toBeNull()
    expect(currentKeyVersionOf(new Error('MINIMA:key_outdated:3'))).toBeNull()
    expect(currentKeyVersionOf('MINIMA:key_outdated:3')).toBeNull()
    expect(currentKeyVersionOf(null)).toBeNull()
    expect(currentKeyVersionOf(undefined)).toBeNull()
  })

  it('accepts an error that only carries the CloudError name', () => {
    const lookalike = Object.assign(new Error('MINIMA:key_outdated:9'), {
      name: 'CloudError',
      code: 'key_outdated',
    })
    expect(currentKeyVersionOf(lookalike)).toBe(9)
    expect(currentKeyVersionOf(new CloudError('key_outdated', 'MINIMA:key_outdated:4'))).toBe(4)
  })
})
