// @vitest-environment node
// No CONTRACT_GAPs: every spacesApi method runs against the real SQL on the
// family PGlite harness (criterion 13), and the owner / B / C scenario of the
// task (criterion 15) is written with spacesApi calls, run A crypto and the
// invite helpers only. Devices are registered with createCloudApi(rpc), the
// way the app will, while the beta switch is on.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { RpcFn } from '@/lib/cloud/rpc'
import type { SpacesApi } from '@/lib/cloud/spacesApi'
import type { IdentityKeyPair } from '@/lib/spaces/spaceCrypto'
import type { SqlTestDb } from '@/test/sql/familyHarness'
import { CloudError as ApiCloudError, createCloudApi } from '@/lib/cloud/api'
import { CloudError } from '@/lib/cloud/rpc'
import { createSpacesApi, currentKeyVersionOf } from '@/lib/cloud/spacesApi'
import {
  buildInviteUrl,
  createInviteSecret,
  inviteToken,
  inviteTokenHash,
  parseInviteFragment,
} from '@/lib/spaces/invite'
import {
  generateIdentityKeyPair,
  generateSpaceKey,
  importSpaceKey,
  unwrapSpaceKey,
  wrapSpaceKeyForPublicKey,
} from '@/lib/spaces/spaceCrypto'
import { setFreeForAll, startFamilyDb, withPlanFeatures } from '@/test/sql/familyHarness'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startFamilyDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

afterEach(async () => {
  await setFreeForAll(ctx, true)
})

interface Actor {
  userId: string
  email: string
  deviceId: string
  rpc: RpcFn
  calls: Array<{ fn: string; args: unknown }>
  api: SpacesApi
  identity: IdentityKeyPair
}

async function actor(): Promise<Actor> {
  const email = `${crypto.randomUUID()}@example.com`
  const userId = await ctx.createUser(email)
  const base = ctx.rpcAs(userId)
  const calls: Array<{ fn: string; args: unknown }> = []
  const rpc: RpcFn = (fn, args) => {
    calls.push({ fn, args })
    return base(fn, args)
  }
  const deviceId = crypto.randomUUID()
  await createCloudApi(rpc).registerDevice(deviceId, 'Test device')
  return {
    userId,
    email,
    deviceId,
    rpc,
    calls,
    api: createSpacesApi(rpc),
    identity: await generateIdentityKeyPair(),
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CloudError)
  return (err as CloudError).code
}

async function newSpace(owner: Actor): Promise<{ spaceId: string; sk: Uint8Array<ArrayBuffer> }> {
  const spaceId = crypto.randomUUID()
  const sk = generateSpaceKey()
  const wrapped = await wrapSpaceKeyForPublicKey(sk, owner.identity.publicKeyJwk)
  await owner.api.createSpace(spaceId, owner.identity.publicKeyJwk, wrapped)
  return { spaceId, sk }
}

// Invite, request and (optionally) approve, using the real invite helpers.
async function join(
  owner: Actor,
  spaceId: string,
  sk: Uint8Array,
  joiner: Actor,
  options: { approve?: boolean; version?: number } = {},
): Promise<{ inviteId: string; token: string }> {
  const secret = createInviteSecret()
  const token = await inviteToken(secret)
  const invite = await owner.api.createInvite(spaceId, await inviteTokenHash(token))
  await joiner.api.requestJoin(invite.invite_id, token, joiner.identity.publicKeyJwk)
  if (options.approve !== false) {
    const wrapped = await wrapSpaceKeyForPublicKey(sk, joiner.identity.publicKeyJwk)
    await owner.api.approveMember(spaceId, joiner.userId, options.version ?? 1, wrapped)
  }
  return { inviteId: invite.invite_id, token }
}

function recordKey(n: number): string {
  return `rec${String(n).padStart(20, '0')}`
}

async function sealRecord(sk: Uint8Array, text: string, n: number, ms: number) {
  const key = await importSpaceKey(sk)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
  return {
    record_key: recordKey(n),
    ciphertext: Buffer.from(ct).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    enc_v: 1,
    updated_at_ms: ms,
  }
}

async function openRecord(
  sk: Uint8Array,
  record: { ciphertext: string; iv: string },
): Promise<string> {
  const key = await importSpaceKey(sk)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') },
    key,
    Buffer.from(record.ciphertext, 'base64'),
  )
  return new TextDecoder().decode(plain)
}

function plainRecord(n: number, ms = 1000) {
  return {
    record_key: recordKey(n),
    ciphertext: 'Y2lwaGVy',
    iv: 'aXZpdml2aXZpdml2',
    enc_v: 1,
    updated_at_ms: ms,
  }
}

describe('the error class is shared', () => {
  it('CloudError from api.ts is the class from rpc.ts', () => {
    expect(ApiCloudError).toBe(CloudError)
  })
})

describe('every method against the real SQL (criterion 13)', () => {
  it('getMySpace is null, then createSpace makes the caller the owner', async () => {
    const owner = await actor()
    expect(await owner.api.getMySpace()).toBeNull()

    const spaceId = crypto.randomUUID()
    const sk = generateSpaceKey()
    const wrapped = await wrapSpaceKeyForPublicKey(sk, owner.identity.publicKeyJwk)
    expect(await owner.api.createSpace(spaceId, owner.identity.publicKeyJwk, wrapped)).toEqual({
      space_id: spaceId,
      key_version: 1,
    })

    const view = await owner.api.getMySpace()
    expect(view).toMatchObject({
      space_id: spaceId,
      role: 'owner',
      status: 'active',
      key_version: 1,
      owner_id: owner.userId,
      paused: false,
      last_seq: 0,
      record_count: 0,
      total_bytes: 0,
    })
    expect(view?.members).toHaveLength(1)
    expect(view?.members[0]).toMatchObject({
      user_id: owner.userId,
      email: owner.email,
      role: 'owner',
      status: 'active',
      public_key: owner.identity.publicKeyJwk,
    })
    expect(view?.my_keys).toEqual([{ key_version: 1, wrapped_key: wrapped }])
    expect(view?.limits).toMatchObject({ shared_spaces: true, max_members: 6 })
    // The owner's own key can be unwrapped with their private key.
    const back = await unwrapSpaceKey(view?.my_keys[0].wrapped_key ?? wrapped, owner.identity.privateKeyJwk)
    expect(Array.from(back)).toEqual(Array.from(sk))
  })

  it('createInvite, getInvite, requestJoin and revokeInvite', async () => {
    const owner = await actor()
    const visitor = await actor()
    const { spaceId } = await newSpace(owner)

    const secret = createInviteSecret()
    const token = await inviteToken(secret)
    const hash = await inviteTokenHash(token)
    const invite = await owner.api.createInvite(spaceId, hash)
    expect(Date.parse(invite.expires_at) - Date.now()).toBeGreaterThan(47 * 3_600_000)
    const short = await owner.api.createInvite(spaceId, await inviteTokenHash('another'), 2)
    expect(Date.parse(short.expires_at) - Date.now()).toBeLessThan(3 * 3_600_000)

    const open = (await owner.api.getMySpace())?.open_invites.map((i) => i.id).sort()
    expect(open).toEqual([invite.invite_id, short.invite_id].sort())

    expect(await visitor.api.getInvite(invite.invite_id, token)).toMatchObject({
      space_id: spaceId,
      owner_email: owner.email,
      members_count: 1,
    })
    expect(
      await visitor.api.requestJoin(invite.invite_id, token, visitor.identity.publicKeyJwk),
    ).toEqual({ space_id: spaceId, status: 'pending' })

    const revoked = await owner.api.revokeInvite(short.invite_id)
    expect(revoked.invite_id).toBe(short.invite_id)
    expect(Date.parse(revoked.revoked_at)).not.toBeNaN()
    expect((await owner.api.getMySpace())?.open_invites).toEqual([])
    expect(await codeOf(visitor.api.getInvite(short.invite_id, 'another'))).toBe('invite_invalid')
  })

  it('approveMember, rejectMember and removeMember', async () => {
    const owner = await actor()
    const [b, c, d] = [await actor(), await actor(), await actor()]
    const { spaceId, sk } = await newSpace(owner)

    await join(owner, spaceId, sk, b, { approve: false })
    await join(owner, spaceId, sk, c, { approve: false })
    await join(owner, spaceId, sk, d)

    const wrapped = await wrapSpaceKeyForPublicKey(sk, b.identity.publicKeyJwk)
    expect(await owner.api.approveMember(spaceId, b.userId, 1, wrapped)).toEqual({
      user_id: b.userId,
      status: 'active',
      key_version: 1,
    })
    expect((await b.api.getMySpace())?.my_keys).toEqual([{ key_version: 1, wrapped_key: wrapped }])

    expect(await owner.api.rejectMember(spaceId, c.userId)).toEqual({ user_id: c.userId })
    expect(await c.api.getMySpace()).toBeNull()

    expect(await owner.api.removeMember(spaceId, d.userId)).toEqual({ user_id: d.userId })
    expect(await d.api.getMySpace()).toBeNull()
    expect((await owner.api.getMySpace())?.members.map((m) => m.user_id).sort()).toEqual(
      [owner.userId, b.userId].sort(),
    )
  })

  it('pushSpaceRecords and pullSpaceRecords', async () => {
    const owner = await actor()
    const b = await actor()
    const { spaceId, sk } = await newSpace(owner)
    await join(owner, spaceId, sk, b)

    const pushed = await owner.api.pushSpaceRecords(spaceId, owner.deviceId, 1, [
      plainRecord(1),
      plainRecord(2),
    ])
    expect(pushed.results).toEqual([
      { record_key: recordKey(1), status: 'accepted', seq: 1 },
      { record_key: recordKey(2), status: 'accepted', seq: 2 },
    ])
    expect(pushed.last_seq).toBe(2)

    const stale = await b.api.pushSpaceRecords(spaceId, b.deviceId, 1, [plainRecord(1, 5)])
    expect(stale.results[0]).toMatchObject({ status: 'stale' })
    if (stale.results[0].status !== 'stale') throw new Error('expected stale')
    expect(stale.results[0].current).toMatchObject({
      record_key: recordKey(1),
      author_id: owner.userId,
      device_id: owner.deviceId,
      key_version: 1,
      seq: 1,
    })

    const page = await b.api.pullSpaceRecords(spaceId, b.deviceId, 0, 1)
    expect(page.records.map((r) => r.seq)).toEqual([1])
    expect(page.has_more).toBe(true)
    const rest = await b.api.pullSpaceRecords(spaceId, b.deviceId, 1)
    expect(rest.records.map((r) => r.seq)).toEqual([2])
    expect(rest).toMatchObject({ has_more: false, last_seq: 2, key_version: 1 })
  })

  it('rotateSpaceKey, transferOwnership, leaveSpace and deleteSpace', async () => {
    const owner = await actor()
    const [b, c] = [await actor(), await actor()]
    const { spaceId, sk } = await newSpace(owner)
    await join(owner, spaceId, sk, b)
    await join(owner, spaceId, sk, c)

    const sk2 = generateSpaceKey()
    const wraps = await Promise.all(
      [owner, b, c].map(async (u) => ({
        user_id: u.userId,
        wrapped_key: await wrapSpaceKeyForPublicKey(sk2, u.identity.publicKeyJwk),
      })),
    )
    expect(await owner.api.rotateSpaceKey(spaceId, 2, wraps)).toEqual({
      space_id: spaceId,
      key_version: 2,
    })
    expect((await c.api.getMySpace())?.my_keys.map((k) => k.key_version)).toEqual([1, 2])

    expect(await owner.api.transferOwnership(spaceId, b.userId)).toEqual({
      space_id: spaceId,
      owner_id: b.userId,
    })
    expect((await b.api.getMySpace())?.role).toBe('owner')
    expect(await owner.api.leaveSpace()).toEqual({ space_id: spaceId })
    expect(await owner.api.getMySpace()).toBeNull()

    expect(await b.api.deleteSpace(spaceId)).toEqual({ space_id: spaceId })
    expect(await b.api.getMySpace()).toBeNull()
    expect(await c.api.getMySpace()).toBeNull()
  })
})

describe('server errors map to CloudError codes', () => {
  it('maps the membership and permission errors', async () => {
    const owner = await actor()
    const b = await actor()
    const outsider = await actor()
    const { spaceId, sk } = await newSpace(owner)
    await join(owner, spaceId, sk, b)

    expect(await codeOf(owner.api.createSpace(crypto.randomUUID(), owner.identity.publicKeyJwk, await wrapSpaceKeyForPublicKey(sk, owner.identity.publicKeyJwk)))).toBe('already_in_space')
    expect(await codeOf(b.api.deleteSpace(spaceId))).toBe('not_space_owner')
    expect(await codeOf(outsider.api.deleteSpace(spaceId))).toBe('not_space_member')
    expect(await codeOf(outsider.api.pullSpaceRecords(spaceId, outsider.deviceId, 0))).toBe('not_space_member')
    expect(await codeOf(owner.api.pullSpaceRecords(crypto.randomUUID(), owner.deviceId, 0))).toBe('space_gone')
    expect(await codeOf(owner.api.removeMember(spaceId, owner.userId))).toBe('cannot_remove_owner')
    expect(await codeOf(owner.api.leaveSpace())).toBe('owner_must_transfer_or_delete')
    expect(await codeOf(owner.api.createInvite(spaceId, 'xyz'))).toBe('invalid_input')
  })

  it('maps invite, approval and rotation errors', async () => {
    const owner = await actor()
    const b = await actor()
    const { spaceId, sk } = await newSpace(owner)
    const token = await inviteToken(createInviteSecret())
    const invite = await owner.api.createInvite(spaceId, await inviteTokenHash(token))

    expect(await codeOf(b.api.getInvite(invite.invite_id, `${token}x`))).toBe('invite_invalid')
    expect(await codeOf(b.api.requestJoin(invite.invite_id, `${token}x`, b.identity.publicKeyJwk))).toBe('invite_invalid')
    await b.api.requestJoin(invite.invite_id, token, b.identity.publicKeyJwk)

    const wrapped = await wrapSpaceKeyForPublicKey(sk, b.identity.publicKeyJwk)
    expect(await codeOf(owner.api.approveMember(spaceId, b.userId, 2, wrapped))).toBe('wrong_key_version')
    await owner.api.approveMember(spaceId, b.userId, 1, wrapped)

    const only = [
      { user_id: owner.userId, wrapped_key: await wrapSpaceKeyForPublicKey(sk, owner.identity.publicKeyJwk) },
    ]
    expect(await codeOf(owner.api.rotateSpaceKey(spaceId, 2, only))).toBe('members_mismatch')
    expect(await codeOf(owner.api.rotateSpaceKey(spaceId, 5, only))).toBe('wrong_key_version')
  })

  it('maps key_outdated and exposes the current version', async () => {
    const owner = await actor()
    const { spaceId } = await newSpace(owner)
    const sk2 = generateSpaceKey()
    await owner.api.rotateSpaceKey(spaceId, 2, [
      {
        user_id: owner.userId,
        wrapped_key: await wrapSpaceKeyForPublicKey(sk2, owner.identity.publicKeyJwk),
      },
    ])

    const err = await owner.api
      .pushSpaceRecords(spaceId, owner.deviceId, 1, [plainRecord(1)])
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(CloudError)
    expect((err as CloudError).code).toBe('key_outdated')
    expect(currentKeyVersionOf(err)).toBe(2)
    await owner.api.pushSpaceRecords(spaceId, owner.deviceId, 2, [plainRecord(1)])
  })

  it('maps device, batch and quota errors', async () => {
    const owner = await actor()
    const { spaceId } = await newSpace(owner)

    expect(await codeOf(owner.api.pushSpaceRecords(spaceId, crypto.randomUUID(), 1, [plainRecord(1)]))).toBe('device_not_registered')
    const many = Array.from({ length: 501 }, (_, i) => plainRecord(i + 1))
    expect(await codeOf(owner.api.pushSpaceRecords(spaceId, owner.deviceId, 1, many))).toBe('batch_too_large')
    expect(await codeOf(owner.api.pushSpaceRecords(spaceId, owner.deviceId, 1, [{ ...plainRecord(1), enc_v: 7 }]))).toBe('invalid_input')

    await withPlanFeatures(ctx, 'beta', { max_space_records: 1 }, async () => {
      expect(await codeOf(owner.api.pushSpaceRecords(spaceId, owner.deviceId, 1, [plainRecord(1), plainRecord(2)]))).toBe('quota_exceeded')
    })
    // The refused push left nothing behind.
    expect((await owner.api.pullSpaceRecords(spaceId, owner.deviceId, 0)).records).toEqual([])
  })

  it('maps member_limit, space_paused, sync_not_included and not_signed_in', async () => {
    const owner = await actor()
    const b = await actor()
    const { spaceId } = await newSpace(owner)
    const token = await inviteToken(createInviteSecret())
    const invite = await owner.api.createInvite(spaceId, await inviteTokenHash(token))

    await withPlanFeatures(ctx, 'beta', { max_members: 1 }, async () => {
      expect(await codeOf(b.api.requestJoin(invite.invite_id, token, b.identity.publicKeyJwk))).toBe('member_limit')
    })

    const fresh = await actor()
    await setFreeForAll(ctx, false)
    expect(await codeOf(owner.api.pullSpaceRecords(spaceId, owner.deviceId, 0))).toBe('space_paused')
    expect(await codeOf(fresh.api.createSpace(crypto.randomUUID(), fresh.identity.publicKeyJwk, await wrapSpaceKeyForPublicKey(generateSpaceKey(), fresh.identity.publicKeyJwk)))).toBe('sync_not_included')
    // Reading the own membership still works while paused.
    expect((await owner.api.getMySpace())?.paused).toBe(true)

    const signedOut = createSpacesApi(ctx.rpcAs(null))
    expect(await codeOf(signedOut.getMySpace())).toBe('not_signed_in')
  })
})

describe('the owner, B and C scenario (criterion 15)', () => {
  it('invite, approval by key wrap, removal and rotation', async () => {
    const owner = await actor()
    const b = await actor()
    const c = await actor()

    // 1. The owner creates a space.
    const spaceId = crypto.randomUUID()
    const sk1 = generateSpaceKey()
    await owner.api.createSpace(
      spaceId,
      owner.identity.publicKeyJwk,
      await wrapSpaceKeyForPublicKey(sk1, owner.identity.publicKeyJwk),
    )

    // 2. An invite is created. The link carries a secret, the server a hash.
    const secretB = createInviteSecret()
    const tokenB = await inviteToken(secretB)
    const invB = await owner.api.createInvite(spaceId, await inviteTokenHash(tokenB))
    const url = buildInviteUrl('https://app.minima.test', invB.invite_id, secretB)
    expect(url).toContain('#')

    // 3. B opens the link, sees whose Family it is and requests to join.
    const parsed = parseInviteFragment(new URL(url).hash)
    if (!parsed) throw new Error('the invite link did not parse')
    const bToken = await inviteToken(parsed.secret)
    expect(bToken).toBe(tokenB)
    expect(await b.api.getInvite(parsed.inviteId, bToken)).toMatchObject({
      space_id: spaceId,
      owner_email: owner.email,
      members_count: 1,
    })
    expect(await b.api.requestJoin(parsed.inviteId, bToken, b.identity.publicKeyJwk)).toEqual({
      space_id: spaceId,
      status: 'pending',
    })

    // While pending B has no key and no data.
    expect(await b.api.getMySpace()).toMatchObject({ status: 'pending', members: [], my_keys: [] })
    expect(await codeOf(b.api.pullSpaceRecords(spaceId, b.deviceId, 0))).toBe('not_space_member')

    // 4. The owner approves by wrapping the space key for B's public key.
    const pending = (await owner.api.getMySpace())?.members.find((m) => m.user_id === b.userId)
    if (!pending) throw new Error('B is not in the member list')
    expect(pending.status).toBe('pending')
    expect(pending.public_key).toEqual(b.identity.publicKeyJwk)
    await owner.api.approveMember(
      spaceId,
      b.userId,
      1,
      await wrapSpaceKeyForPublicKey(sk1, pending.public_key),
    )

    // 5. B unwraps the key from my_keys and decrypts a record the owner pushed.
    const sealed = await sealRecord(sk1, 'Groceries 42.00', 1, 1000)
    const accepted = await owner.api.pushSpaceRecords(spaceId, owner.deviceId, 1, [sealed])
    expect(accepted.results[0]).toMatchObject({ status: 'accepted', seq: 1 })

    const bKeys = (await b.api.getMySpace())?.my_keys ?? []
    expect(bKeys.map((k) => k.key_version)).toEqual([1])
    const skAtB = await unwrapSpaceKey(bKeys[0].wrapped_key, b.identity.privateKeyJwk)
    expect(Array.from(skAtB)).toEqual(Array.from(sk1))
    const bPull = await b.api.pullSpaceRecords(spaceId, b.deviceId, 0)
    expect(bPull.records).toHaveLength(1)
    expect(bPull.records[0].author_id).toBe(owner.userId)
    expect(await openRecord(skAtB, bPull.records[0])).toBe('Groceries 42.00')

    // C joins too and gets the same key.
    await join(owner, spaceId, sk1, c)
    const cView = await c.api.getMySpace()
    expect(cView?.status).toBe('active')

    // 6. The owner removes B and rotates the key.
    await owner.api.removeMember(spaceId, b.userId)
    expect(await codeOf(b.api.pullSpaceRecords(spaceId, b.deviceId, 0))).toBe('not_space_member')
    expect(await codeOf(b.api.pushSpaceRecords(spaceId, b.deviceId, 1, [plainRecord(2)]))).toBe('not_space_member')

    const sk2 = generateSpaceKey()
    const rotated = await owner.api.rotateSpaceKey(spaceId, 2, [
      {
        user_id: owner.userId,
        wrapped_key: await wrapSpaceKeyForPublicKey(sk2, owner.identity.publicKeyJwk),
      },
      {
        user_id: c.userId,
        wrapped_key: await wrapSpaceKeyForPublicKey(sk2, c.identity.publicKeyJwk),
      },
    ])
    expect(rotated).toEqual({ space_id: spaceId, key_version: 2 })

    // The old version is refused, with the current one in the error.
    const stale = await owner.api
      .pushSpaceRecords(spaceId, owner.deviceId, 1, [sealed])
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(currentKeyVersionOf(stale)).toBe(2)

    // C unwraps both versions and reads records under either.
    const cKeys = (await c.api.getMySpace())?.my_keys ?? []
    expect(cKeys.map((k) => k.key_version)).toEqual([1, 2])
    const cSk1 = await unwrapSpaceKey(cKeys[0].wrapped_key, c.identity.privateKeyJwk)
    const cSk2 = await unwrapSpaceKey(cKeys[1].wrapped_key, c.identity.privateKeyJwk)
    expect(Array.from(cSk1)).toEqual(Array.from(sk1))
    expect(Array.from(cSk2)).toEqual(Array.from(sk2))

    const before = await c.api.pullSpaceRecords(spaceId, c.deviceId, 0)
    expect(before.key_version).toBe(2)
    expect(await openRecord(cSk1, before.records[0])).toBe('Groceries 42.00')

    // The owner re-pushes the record under version 2 with the same timestamp.
    const resealed = await sealRecord(sk2, 'Groceries 42.00', 1, 1000)
    const repush = await owner.api.pushSpaceRecords(spaceId, owner.deviceId, 2, [resealed])
    expect(repush.results[0]).toMatchObject({ status: 'accepted' })

    const after = await c.api.pullSpaceRecords(spaceId, c.deviceId, before.records[0].seq)
    expect(after.records).toHaveLength(1)
    expect(after.records[0].key_version).toBe(2)
    expect(await openRecord(cSk2, after.records[0])).toBe('Groceries 42.00')

    // B kept the old key but cannot read what was written after the rotation.
    await expect(openRecord(skAtB, after.records[0])).rejects.toThrow()
  })

  it('the invite secret is never sent to the server, only the token', async () => {
    const owner = await actor()
    const b = await actor()
    const { spaceId } = await newSpace(owner)

    const secret = createInviteSecret()
    const token = await inviteToken(secret)
    const invite = await owner.api.createInvite(spaceId, await inviteTokenHash(token))
    const parsed = parseInviteFragment(
      new URL(buildInviteUrl('https://app.minima.test', invite.invite_id, secret)).hash,
    )
    if (!parsed) throw new Error('did not parse')
    await b.api.requestJoin(parsed.inviteId, await inviteToken(parsed.secret), b.identity.publicKeyJwk)

    const secretText = Buffer.from(secret).toString('base64url')
    const sent = JSON.stringify([...owner.calls, ...b.calls])
    expect(sent).not.toContain(secretText)
    expect(sent).not.toContain(Buffer.from(secret).toString('base64'))
    // The token reaches the server as itself (to prove possession), and the
    // hash of it is what the owner stored.
    expect(JSON.stringify(b.calls)).toContain(token)
    expect(JSON.stringify(owner.calls)).not.toContain(token)
    expect(JSON.stringify(owner.calls)).toContain(await inviteTokenHash(token))
  })
})
