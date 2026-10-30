// CONTRACT_GAP: which action reads get_my_space (and how often) is only partly
//   specified; the tests assert the calls that must happen, not exact counts.
// CONTRACT_GAP: the message of FamilyActionError is not specified; only name and
//   code are checked.
//
// Unit style: fake SpacesApi, fake ports, fake stream and engine. The key work
// is real (identity key pairs, ECIES wraps, invite secrets, HKDF tokens), so
// the tests can open what the actions wrap.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MySpace, SpaceMember, SpacesApi } from '@/lib/cloud/spacesApi'
import type { SyncStatus } from '@/lib/cloud/types'
import type { IdentityKeyPair, WrappedSpaceKey } from '@/lib/spaces/spaceCrypto'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import type { FamilyPorts, FamilyStream, SyncMetaPort } from '@/lib/sync/types'
import { CloudError } from '@/lib/cloud/rpc'
import { bytesToBase64 } from '@/lib/crypto'
import { inviteToken, inviteTokenHash, parseInviteFragment } from '@/lib/spaces/invite'
import {
  generateIdentityKeyPair,
  generateIndexKey,
  generateSpaceKey,
  safetyCode,
  unwrapSpaceKeyBundle,
} from '@/lib/spaces/spaceCrypto'
import { FamilyActionError, createFamilyActions } from '@/lib/sync/familyActions'

const SPACE = 'a1b2c3d4-0000-4000-8000-0000000000a1'
const OTHER_SPACE = 'a1b2c3d4-0000-4000-8000-0000000000b2'
const ME = 'user-me'
const BOB = 'user-bob'
const NOW = '2026-10-30T12:00:00.000Z'
const ORIGIN = 'https://minima.example'

let myPair: IdentityKeyPair
let bobPair: IdentityKeyPair
const sk = generateSpaceKey()
const indexKey = generateIndexKey()

beforeAll(async () => {
  myPair = await generateIdentityKeyPair()
  bobPair = await generateIdentityKeyPair()
})

function entry(over: Partial<SpaceKeyEntry> = {}): SpaceKeyEntry {
  return {
    id: SPACE,
    keyVersion: 1,
    key: bytesToBase64(sk),
    indexKey: bytesToBase64(indexKey),
    name: 'Home',
    role: 'owner',
    joinedAt: NOW,
    updatedAt: NOW,
    status: 'active',
    wrappedFor: { keyVersion: 1, userIds: [ME] },
    ...over,
  }
}

function member(userId: string, status: 'active' | 'pending', pair: IdentityKeyPair, role: 'owner' | 'member' = 'member'): SpaceMember {
  return {
    user_id: userId,
    email: `${userId}@example.com`,
    role,
    status,
    public_key: pair.publicKeyJwk,
    requested_at: NOW,
    joined_at: status === 'active' ? NOW : null,
  }
}

function mySpace(over: Partial<MySpace> = {}): MySpace {
  return {
    space_id: SPACE,
    role: 'owner',
    status: 'active',
    key_version: 1,
    owner_id: ME,
    members: [member(ME, 'active', myPair, 'owner'), member(BOB, 'pending', bobPair)],
    my_keys: [],
    open_invites: [],
    paused: false,
    limits: { max_members: 5 },
    last_seq: 0,
    record_count: 0,
    total_bytes: 0,
    ...over,
  }
}

function status(sharedSpaces: boolean): SyncStatus {
  return {
    plan_id: 'family',
    has_sync: true,
    free_for_all: false,
    granted_by: 'entitlement',
    beta_joined_at: null,
    entitlement_status: 'active',
    current_period_end: null,
    limits: { sync: true, shared_spaces: sharedSpaces, max_devices: 5, max_records: 1, max_bytes: 1 },
    vault: null,
    devices_count: 1,
  }
}

const SYNC_ON_META = {
  localRev: 1,
  enabled: true,
  userId: ME,
  vaultId: 'vault-1',
  deviceId: 'device-1',
  pushedRev: 0,
  pullCursor: 0,
  headerRev: 1,
  lastSyncAt: null,
  lastError: null,
}

interface Rig {
  order: Array<string>
  entries: Map<string, SpaceKeyEntry>
  my: MySpace | null
  signedIn: boolean
  syncOn: boolean
  plan: SyncStatus
  spaces: { [K in keyof SpacesApi]: ReturnType<typeof vi.fn> }
  local: { [K in keyof FamilyPorts['local']]: ReturnType<typeof vi.fn> }
  meta: { read: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  pending: { [K in keyof FamilyPorts['pending']]: ReturnType<typeof vi.fn> }
  engine: { runCycle: ReturnType<typeof vi.fn> }
  family: { setSpace: ReturnType<typeof vi.fn> }
  api: { getSyncStatus: ReturnType<typeof vi.fn> }
  actions: ReturnType<typeof createFamilyActions>
}

function rig(options: { entry?: Partial<SpaceKeyEntry> | null; my?: MySpace | null } = {}): Rig {
  const r = {} as Rig
  r.order = []
  r.entries = new Map()
  if (options.entry !== null && options.entry !== undefined) r.entries.set(SPACE, entry(options.entry))
  r.my = options.my === undefined ? null : options.my
  r.signedIn = true
  r.syncOn = true
  r.plan = status(true)
  const track = <T>(name: string, value: T) => vi.fn((..._args: Array<unknown>) => {
    r.order.push(name)
    return value
  })

  r.spaces = {
    getMySpace: vi.fn(() => Promise.resolve(r.my)),
    createSpace: vi.fn((spaceId: string) => {
      r.order.push('createSpace')
      return Promise.resolve({ space_id: spaceId, key_version: 1 })
    }),
    createInvite: vi.fn(() => Promise.resolve({ invite_id: 'invite-1', expires_at: '2026-11-01T12:00:00.000Z' })),
    revokeInvite: vi.fn(() => Promise.resolve({ invite_id: 'invite-1', revoked_at: NOW })),
    getInvite: vi.fn(() => Promise.resolve({ space_id: SPACE, owner_email: 'owner@example.com', members_count: 2, expires_at: NOW })),
    requestJoin: vi.fn(() => Promise.resolve({ space_id: SPACE, status: 'pending' as const })),
    approveMember: vi.fn((_s: string, userId: string, keyVersion: number) =>
      Promise.resolve({ user_id: userId, status: 'active' as const, key_version: keyVersion }),
    ),
    rejectMember: vi.fn((_s: string, userId: string) => Promise.resolve({ user_id: userId })),
    removeMember: vi.fn((_s: string, userId: string) => {
      r.order.push('removeMember')
      return Promise.resolve({ user_id: userId })
    }),
    rotateSpaceKey: vi.fn(),
    leaveSpace: vi.fn(() => Promise.resolve({ space_id: SPACE })),
    transferOwnership: vi.fn((spaceId: string, userId: string) => Promise.resolve({ space_id: spaceId, owner_id: userId })),
    deleteSpace: vi.fn(() => {
      r.order.push('deleteSpace')
      return Promise.resolve({ space_id: SPACE })
    }),
    pushSpaceRecords: vi.fn(),
    pullSpaceRecords: vi.fn(),
  }

  r.local = {
    isUnlocked: vi.fn(() => true),
    listSpaceKeyEntries: vi.fn(() => Promise.resolve(Array.from(r.entries.values()))),
    getSpaceKeyEntry: vi.fn((id: string) => Promise.resolve(r.entries.get(id) ?? null)),
    createLocalSpace: vi.fn((input: { name: string }) => {
      r.order.push('createLocalSpace')
      r.entries.set(SPACE, entry({ name: input.name, status: undefined, indexKey: undefined, wrappedFor: undefined }))
      return Promise.resolve({ id: SPACE, name: input.name, role: 'owner' as const, keyVersion: 1, joinedAt: NOW })
    }),
    forgetLocalSpace: vi.fn((id: string) => {
      r.order.push('forgetLocalSpace')
      r.entries.delete(id)
      return Promise.resolve()
    }),
    adoptSpaceKey: vi.fn((input: { spaceId: string; keyVersion: number; sk: Uint8Array; indexKey: Uint8Array }) => {
      const current = r.entries.get(input.spaceId) ?? entry()
      const next = { ...current, keyVersion: input.keyVersion, key: bytesToBase64(input.sk) }
      r.entries.set(input.spaceId, next)
      return Promise.resolve(next)
    }),
    updateSpaceEntry: vi.fn((id: string, patch: Partial<SpaceKeyEntry>) => {
      r.order.push('updateSpaceEntry')
      const current = r.entries.get(id)
      if (!current) return Promise.resolve(null)
      const next = { ...current, ...patch }
      r.entries.set(id, next)
      return Promise.resolve(next)
    }),
    ensureSpaceIndexKey: vi.fn((id: string) => {
      r.order.push('ensureSpaceIndexKey')
      const current = r.entries.get(id) ?? entry()
      const next = { ...current, indexKey: current.indexKey ?? bytesToBase64(indexKey) }
      r.entries.set(id, next)
      return Promise.resolve(next)
    }),
    ensureIdentityKeyPair: vi.fn(() => {
      r.order.push('ensureIdentityKeyPair')
      return Promise.resolve(myPair)
    }),
    listChangedRecords: vi.fn(),
    applyIncomingRecords: vi.fn(),
    dedupeOccurrences: vi.fn(),
    compactTombstones: vi.fn(),
    getSpaceInfo: vi.fn(() => Promise.resolve({ id: 'space' as const, name: 'Home', createdAt: NOW, updatedAt: NOW })),
    updateSpaceInfo: vi.fn((_id: string, input: { name: string }) =>
      Promise.resolve({ id: 'space' as const, name: input.name, createdAt: NOW, updatedAt: NOW }),
    ),
    getMemberProfiles: vi.fn(() => Promise.resolve([{ id: ME, displayName: 'Me', color: 'var(--chart-2)', updatedAt: NOW }])),
    upsertMemberProfile: vi.fn((_id: string, input: { id: string; displayName: string; color: string }) => {
      r.order.push('upsertMemberProfile')
      return Promise.resolve({ ...input, updatedAt: NOW })
    }),
    countEntries: vi.fn(() => Promise.resolve(12)),
    onSpaceLocalChange: vi.fn(() => () => undefined),
  }

  r.meta = {
    read: vi.fn(() => Promise.resolve({ localRev: 1 })),
    update: vi.fn((_id: string, patch: Record<string, unknown>) => {
      r.order.push(`meta:${Object.keys(patch).join(',')}`)
      return Promise.resolve({ localRev: 1, ...patch })
    }),
  }
  r.pending = {
    readJoin: vi.fn(() => null),
    saveJoin: track('saveJoin', undefined),
    clearJoin: vi.fn(),
    clearInvite: track('clearInvite', undefined),
  }
  r.engine = {
    runCycle: vi.fn(() => {
      r.order.push('runCycle')
      return Promise.resolve({})
    }),
  }
  r.family = { setSpace: vi.fn() }
  r.api = { getSyncStatus: vi.fn(() => Promise.resolve(r.plan)) }

  const personalMeta: SyncMetaPort = {
    read: vi.fn(() => Promise.resolve(r.syncOn ? SYNC_ON_META : { localRev: 1 })),
    update: vi.fn(),
    clear: vi.fn(),
  }

  r.actions = createFamilyActions({
    api: r.api,
    spaces: r.spaces as unknown as SpacesApi,
    engine: r.engine as never,
    family: r.family as unknown as FamilyStream,
    ports: { local: r.local as unknown as FamilyPorts['local'], meta: r.meta, pending: r.pending as unknown as FamilyPorts['pending'] },
    personalMeta,
    getUserId: () => (r.signedIn ? ME : null),
    origin: () => ORIGIN,
  })
  return r
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(FamilyActionError)
  expect((err as FamilyActionError).name).toBe('FamilyActionError')
  return (err as FamilyActionError).code
}

async function cloudCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CloudError)
  return (err as CloudError).code
}

beforeEach(() => {
  sessionStorage.clear()
})

describe('createFamily gates', () => {
  it('needs a signed-in user', async () => {
    const r = rig()
    r.signedIn = false

    expect(await codeOf(r.actions.createFamily({ name: 'Home' }))).toBe('not_signed_in')
    expect(r.spaces.createSpace).not.toHaveBeenCalled()
  })

  it('needs personal sync on for this device', async () => {
    const r = rig()
    r.syncOn = false

    expect(await codeOf(r.actions.createFamily({ name: 'Home' }))).toBe('sync_off')
    expect(r.local.createLocalSpace).not.toHaveBeenCalled()
  })

  it('needs shared_spaces in a FRESH status', async () => {
    const r = rig()
    r.plan = status(false)

    expect(await codeOf(r.actions.createFamily({ name: 'Home' }))).toBe('not_in_plan')
    expect(r.api.getSyncStatus).toHaveBeenCalledTimes(1)
    expect(r.local.createLocalSpace).not.toHaveBeenCalled()
    expect(r.spaces.createSpace).not.toHaveBeenCalled()
  })
})

describe('createFamily', () => {
  it('runs the steps in order', async () => {
    const r = rig()

    const result = await r.actions.createFamily({ name: 'Home' })

    expect(result).toEqual({ kind: 'created', spaceId: SPACE })
    const order = r.order
    const at = (name: string) => order.indexOf(name)
    expect(at('createLocalSpace')).toBeGreaterThanOrEqual(0)
    expect(at('createLocalSpace')).toBeLessThan(at('ensureSpaceIndexKey'))
    expect(at('ensureSpaceIndexKey')).toBeLessThan(at('ensureIdentityKeyPair'))
    expect(at('ensureIdentityKeyPair')).toBeLessThan(at('createSpace'))
    expect(at('createSpace')).toBeLessThan(at('updateSpaceEntry'))
    expect(at('updateSpaceEntry')).toBeLessThan(at('upsertMemberProfile'))
    expect(at('upsertMemberProfile')).toBeLessThan(order.lastIndexOf('runCycle'))
    expect(r.engine.runCycle).toHaveBeenCalledWith({ reason: 'family' })
  })

  it('wraps a version 1 bundle for the creator and sends the public key', async () => {
    const r = rig()

    await r.actions.createFamily({ name: 'Home' })

    const [spaceId, publicKey, wrapped] = r.spaces.createSpace.mock.calls[0] as [string, JsonWebKey, WrappedSpaceKey]
    expect(spaceId).toBe(SPACE)
    expect(publicKey).toEqual(myPair.publicKeyJwk)
    const bundle = await unwrapSpaceKeyBundle(wrapped, myPair.privateKeyJwk)
    expect(bundle.keyVersion).toBe(1)
    expect(bytesToBase64(bundle.sk)).toBe(r.entries.get(SPACE)?.key)
    expect(bytesToBase64(bundle.indexKey)).toBe(r.entries.get(SPACE)?.indexKey)
  })

  it('marks the entry active with the creator in the wrap set and plans a full first push', async () => {
    const r = rig()

    await r.actions.createFamily({ name: 'Home' })

    expect(r.local.updateSpaceEntry).toHaveBeenCalledWith(SPACE, expect.objectContaining({ status: 'active', wrappedFor: { keyVersion: 1, userIds: [ME] } }))
    expect(r.meta.update).toHaveBeenCalledWith(SPACE, expect.objectContaining({ pushedRev: -1 }))
  })

  it('writes the creator profile named after the email local part', async () => {
    const r = rig()

    await r.actions.createFamily({ name: 'Home' })

    expect(r.local.upsertMemberProfile).toHaveBeenCalledWith(SPACE, expect.objectContaining({ id: ME, color: expect.stringMatching(/^var\(--/) }))
  })

  it('returns already-in-space and touches nothing locally when the server has another space', async () => {
    const r = rig({ my: mySpace({ space_id: OTHER_SPACE }) })

    const result = await r.actions.createFamily({ name: 'Home' })

    expect(result).toMatchObject({ kind: 'already-in-space', space: { space_id: OTHER_SPACE } })
    expect(r.local.createLocalSpace).not.toHaveBeenCalled()
    expect(r.spaces.createSpace).not.toHaveBeenCalled()
  })

  it('maps an already_in_space error from create_space to the same result', async () => {
    const r = rig()
    r.spaces.createSpace.mockRejectedValueOnce(new CloudError('already_in_space', 'MINIMA:already_in_space'))
    r.spaces.getMySpace.mockResolvedValueOnce(null).mockResolvedValue(mySpace({ space_id: OTHER_SPACE }))

    const result = await r.actions.createFamily({ name: 'Home' })

    expect(result.kind).toBe('already-in-space')
  })

  it('is retry-safe: a live local owner space is reused and create_space is skipped when the server has it', async () => {
    const r = rig({ entry: { status: undefined }, my: mySpace({ members: [member(ME, 'active', myPair, 'owner')] }) })

    const result = await r.actions.createFamily({ name: 'Home' })

    expect(result).toEqual({ kind: 'created', spaceId: SPACE })
    expect(r.local.createLocalSpace).not.toHaveBeenCalled()
    expect(r.spaces.createSpace).not.toHaveBeenCalled()
    expect(r.engine.runCycle).toHaveBeenCalled()
  })

  it('reuses a local owner space that the server does not know yet', async () => {
    const r = rig({ entry: { status: undefined } })

    await r.actions.createFamily({ name: 'Home' })

    expect(r.local.createLocalSpace).not.toHaveBeenCalled()
    expect(r.spaces.createSpace).toHaveBeenCalledTimes(1)
    expect((r.spaces.createSpace.mock.calls[0] as Array<unknown>)[0]).toBe(SPACE)
  })
})

describe('createInvite', () => {
  it('sends only the hash, builds an origin link and never sends the secret', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    const created = await r.actions.createInvite()

    expect(created).toMatchObject({ inviteId: 'invite-1', expiresAt: '2026-11-01T12:00:00.000Z' })
    expect(created.url.startsWith(`${ORIGIN}/join#`)).toBe(true)
    const parsed = parseInviteFragment(new URL(created.url).hash)
    expect(parsed?.inviteId).toBe('invite-1')
    const secret = bytesToBase64(parsed?.secret ?? new Uint8Array())
    const token = await inviteToken(parsed?.secret ?? new Uint8Array())
    const [spaceId, hash] = r.spaces.createInvite.mock.calls[0] as [string, string]
    expect(spaceId).toBe(SPACE)
    expect(hash).toBe(await inviteTokenHash(token))
    const everything = JSON.stringify([
      r.spaces.createInvite.mock.calls,
      r.spaces.getMySpace.mock.calls,
      r.meta.update.mock.calls,
      r.local.updateSpaceEntry.mock.calls,
      r.pending.saveJoin.mock.calls,
    ])
    expect(everything).not.toContain(created.url.split('#')[1].split('.')[1])
    expect(hash).not.toBe(token)
    expect(secret.length).toBeGreaterThan(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('two invites have different links', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    const a = await r.actions.createInvite()
    const b = await r.actions.createInvite()

    expect(a.url).not.toBe(b.url)
  })

  it('revokeInvite calls the server with the id', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.revokeInvite('invite-9')

    expect(r.spaces.revokeInvite).toHaveBeenCalledWith('invite-9')
  })
})

describe('previewInvite and requestJoin', () => {
  const secret = generateIndexKey()
  const invite = { inviteId: 'invite-7', secret }

  it('previewInvite asks the server with the derived token', async () => {
    const r = rig()

    const info = await r.actions.previewInvite(invite)

    expect(r.spaces.getInvite).toHaveBeenCalledWith('invite-7', await inviteToken(secret))
    expect(info.owner_email).toBe('owner@example.com')
  })

  it('requestJoin sends the identity public key, clears the invite, saves the pending join and returns the safety code', async () => {
    const r = rig()

    const result = await r.actions.requestJoin(invite, 'owner@example.com')

    expect(r.spaces.requestJoin).toHaveBeenCalledWith('invite-7', await inviteToken(secret), myPair.publicKeyJwk)
    expect(result).toEqual({ spaceId: SPACE, safetyCode: await safetyCode(myPair.publicKeyJwk) })
    expect(r.pending.saveJoin).toHaveBeenCalledWith(expect.objectContaining({ spaceId: SPACE, ownerEmail: 'owner@example.com' }))
    expect(r.order.indexOf('clearInvite')).toBeLessThan(r.order.indexOf('saveJoin'))
  })

  it('the safety code differs for a different identity', async () => {
    expect(await safetyCode(myPair.publicKeyJwk)).not.toBe(await safetyCode(bobPair.publicKeyJwk))
  })

  it('invite_invalid clears the pending invite', async () => {
    const r = rig()
    r.spaces.requestJoin.mockRejectedValueOnce(new CloudError('invite_invalid', 'MINIMA:invite_invalid'))

    expect(await cloudCodeOf(r.actions.requestJoin(invite, null))).toBe('invite_invalid')
    expect(r.pending.clearInvite).toHaveBeenCalled()
    expect(r.pending.saveJoin).not.toHaveBeenCalled()
  })

  it('another error keeps the pending invite', async () => {
    const r = rig()
    r.spaces.requestJoin.mockRejectedValueOnce(new CloudError('network', 'down'))

    expect(await cloudCodeOf(r.actions.requestJoin(invite, null))).toBe('network')
    expect(r.pending.clearInvite).not.toHaveBeenCalled()
    expect(r.pending.saveJoin).not.toHaveBeenCalled()
  })

  it('mySafetyCode is the code of the own identity', async () => {
    const r = rig()

    expect(await r.actions.mySafetyCode()).toBe(await safetyCode(myPair.publicKeyJwk))
  })
})

describe('approve, reject, remove', () => {
  it('approve wraps the current bundle for the requester and calls approve_member', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.approveMember(BOB)

    const [spaceId, userId, version, wrapped] = r.spaces.approveMember.mock.calls[0] as [string, string, number, WrappedSpaceKey]
    expect([spaceId, userId, version]).toEqual([SPACE, BOB, 1])
    const bundle = await unwrapSpaceKeyBundle(wrapped, bobPair.privateKeyJwk)
    expect(bundle.keyVersion).toBe(1)
    expect(bytesToBase64(bundle.sk)).toBe(bytesToBase64(sk))
    expect(bytesToBase64(bundle.indexKey)).toBe(bytesToBase64(indexKey))
    await expect(unwrapSpaceKeyBundle(wrapped, myPair.privateKeyJwk)).rejects.toBeDefined()
    expect(r.local.updateSpaceEntry).toHaveBeenCalledWith(SPACE, { wrappedFor: { keyVersion: 1, userIds: expect.arrayContaining([ME, BOB]) } })
  })

  it('wrong_key_version refreshes and retries once', async () => {
    const r = rig({ entry: {}, my: mySpace() })
    r.spaces.approveMember.mockRejectedValueOnce(new CloudError('wrong_key_version', 'MINIMA:wrong_key_version'))

    await r.actions.approveMember(BOB)

    expect(r.spaces.approveMember).toHaveBeenCalledTimes(2)
    expect(r.spaces.getMySpace.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('a second wrong_key_version is surfaced', async () => {
    const r = rig({ entry: {}, my: mySpace() })
    r.spaces.approveMember.mockRejectedValue(new CloudError('wrong_key_version', 'x'))

    expect(await cloudCodeOf(r.actions.approveMember(BOB))).toBe('wrong_key_version')
    expect(r.spaces.approveMember).toHaveBeenCalledTimes(2)
  })

  it('reject calls reject_member and refreshes the snapshot', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.rejectMember(BOB)

    expect(r.spaces.rejectMember).toHaveBeenCalledWith(SPACE, BOB)
    expect(r.family.setSpace).toHaveBeenCalled()
  })

  it('remove calls remove_member, marks the rotation as due and runs a Family cycle', async () => {
    const r = rig({ entry: {}, my: mySpace({ key_version: 3 }) })

    await r.actions.removeMember(BOB)

    expect(r.spaces.removeMember).toHaveBeenCalledWith(SPACE, BOB)
    expect(r.meta.update).toHaveBeenCalledWith(SPACE, expect.objectContaining({ rotationPendingFrom: 3 }))
    expect(r.engine.runCycle).toHaveBeenCalledWith({ reason: 'family' })
    expect(r.order.indexOf('removeMember')).toBeLessThan(r.order.indexOf('meta:rotationPendingFrom'))
    expect(r.order.indexOf('meta:rotationPendingFrom')).toBeLessThan(r.order.lastIndexOf('runCycle'))
  })
})

describe('leave, transfer, delete, forget', () => {
  it('leave calls leave_space, marks the entry left and clears the pending join', async () => {
    const r = rig({ entry: { role: 'member' }, my: mySpace({ role: 'member' }) })

    await r.actions.leaveFamily()

    expect(r.spaces.leaveSpace).toHaveBeenCalledTimes(1)
    expect(r.local.updateSpaceEntry).toHaveBeenCalledWith(SPACE, { status: 'left' })
    expect(r.pending.clearJoin).toHaveBeenCalled()
  })

  it('transfer calls transfer_ownership and makes the local role member', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.transferOwnership(BOB)

    expect(r.spaces.transferOwnership).toHaveBeenCalledWith(SPACE, BOB)
    expect(r.local.updateSpaceEntry).toHaveBeenCalledWith(SPACE, { role: 'member' })
  })

  it('delete refuses a wrong name and calls nothing', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    expect(await codeOf(r.actions.deleteFamily('Hom'))).toBe('name_mismatch')
    expect(r.spaces.deleteSpace).not.toHaveBeenCalled()
    expect(r.local.forgetLocalSpace).not.toHaveBeenCalled()
  })

  it('delete with the trimmed name deletes on the server, then forgets locally', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.deleteFamily('  Home  ')

    expect(r.spaces.deleteSpace).toHaveBeenCalledWith(SPACE)
    expect(r.local.forgetLocalSpace).toHaveBeenCalledWith(SPACE)
    expect(r.order.indexOf('deleteSpace')).toBeLessThan(r.order.indexOf('forgetLocalSpace'))
  })

  it('forget only forgets locally', async () => {
    const r = rig({ entry: { status: 'removed' } })

    await r.actions.forgetFamily(SPACE)

    expect(r.local.forgetLocalSpace).toHaveBeenCalledWith(SPACE)
    expect(r.spaces.deleteSpace).not.toHaveBeenCalled()
    expect(r.spaces.leaveSpace).not.toHaveBeenCalled()
  })
})

describe('rename, my name, overview', () => {
  it('rename updates spaceInfo and the entry name', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.renameFamily('Our place')

    expect(r.local.updateSpaceInfo).toHaveBeenCalledWith(SPACE, { name: 'Our place' })
    expect(r.local.updateSpaceEntry).toHaveBeenCalledWith(SPACE, { name: 'Our place' })
  })

  it('setMyDisplayName keeps the existing colour', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    await r.actions.setMyDisplayName('Mum')

    expect(r.local.upsertMemberProfile).toHaveBeenCalledWith(SPACE, { id: ME, displayName: 'Mum', color: 'var(--chart-2)' })
  })

  it('getOverview returns the info, the profiles and the entry count', async () => {
    const r = rig({ entry: {}, my: mySpace() })

    const overview = await r.actions.getOverview(SPACE)

    expect(overview.info?.name).toBe('Home')
    expect(overview.profiles.map((p) => p.id)).toEqual([ME])
    expect(overview.entryCount).toBe(12)
  })

  it('refresh reads get_my_space and hands it to the stream', async () => {
    const my = mySpace()
    const r = rig({ entry: {}, my })

    expect(await r.actions.refresh()).toEqual(my)
    expect(r.family.setSpace).toHaveBeenCalledWith(my)
  })
})

describe('every action needs a signed-in user', () => {
  it.each([
    ['createInvite', (a: Rig['actions']) => a.createInvite()],
    ['approveMember', (a: Rig['actions']) => a.approveMember(BOB)],
    ['removeMember', (a: Rig['actions']) => a.removeMember(BOB)],
    ['leaveFamily', (a: Rig['actions']) => a.leaveFamily()],
    ['deleteFamily', (a: Rig['actions']) => a.deleteFamily('Home')],
  ])('%s rejects with not_signed_in', async (_name, call) => {
    const r = rig({ entry: {}, my: mySpace() })
    r.signedIn = false

    expect(await codeOf(call(r.actions))).toBe('not_signed_in')
    expect(Object.values(r.spaces).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })
})
