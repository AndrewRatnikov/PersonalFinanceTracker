// CONTRACT_GAP: the exact order of calls inside one cycle beyond what plan
//   section 4 lists (get_my_space -> adopt/rotate -> pull -> push) is not
//   asserted; only the observable calls and the state.
// CONTRACT_GAP: the FamilyCycleResult of a "no work" cycle (ran true or false)
//   is not specified; only status 'none' and the absence of server calls.
// CONTRACT_GAP: which of the two reads (a second get_my_space) happens when a
//   pulled row's key version is unknown is asserted as "getMySpace is called
//   again", not as an exact call count.
//
// Unit style: fake SpacesApi, fake ports and a fake record crypto (JSON
// "ciphertext"); the key bundles are real (identity key pairs, ECIES wraps), so
// the stream really unwraps and wraps.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EncryptedSyncRecord, SyncStatus  } from '@/lib/cloud/types'
import type { MySpace, SpaceMember, SpacesApi } from '@/lib/cloud/spacesApi'
import type { IdentityKeyPair, WrappedSpaceKey } from '@/lib/spaces/spaceCrypto'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import type { SyncRecord } from '@/lib/syncRecords'
import type {
  FamilyCryptoPort,
  FamilyPorts,
  FamilyStreamEvent,
  FamilySyncMeta,
  FamilySyncState,
} from '@/lib/sync/types'
import { CloudError } from '@/lib/cloud/rpc'
import { base64ToBytes, bytesToBase64 } from '@/lib/crypto'
import {
  generateIdentityKeyPair,
  generateIndexKey,
  generateSpaceKey,
  unwrapSpaceKeyBundle,
  wrapSpaceKeyBundleForPublicKey,
} from '@/lib/spaces/spaceCrypto'
import {
  INITIAL_FAMILY_STATE,
  createFamilyStream,
  familyStatusForCloudError,
} from '@/lib/sync/familyStream'

const SPACE = 'a1b2c3d4-0000-4000-8000-0000000000a1'
const OWNER = 'user-owner'
const BOB = 'user-bob'
const CAROL = 'user-carol'
const DEVICE = 'device-1'
const NOW = '2026-10-30T12:00:00.000Z'

let sk1: Uint8Array<ArrayBuffer>
let indexKey: Uint8Array<ArrayBuffer>
let ownerPair: IdentityKeyPair
let bobPair: IdentityKeyPair
let wrapV1: WrappedSpaceKey

beforeAll(async () => {
  sk1 = generateSpaceKey()
  indexKey = generateIndexKey()
  ownerPair = await generateIdentityKeyPair()
  bobPair = await generateIdentityKeyPair()
  wrapV1 = await wrapSpaceKeyBundleForPublicKey({ v: 1, keyVersion: 1, sk: sk1, indexKey }, ownerPair.publicKeyJwk)
})

function member(userId: string, role: 'owner' | 'member', status: 'active' | 'pending', pair: IdentityKeyPair): SpaceMember {
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

function syncStatus(space: SyncStatus['space'] = null): SyncStatus {
  return {
    plan_id: 'family',
    has_sync: true,
    free_for_all: false,
    granted_by: 'entitlement',
    beta_joined_at: null,
    entitlement_status: 'active',
    current_period_end: null,
    limits: { sync: true, shared_spaces: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
    vault: null,
    devices_count: 1,
    space,
  }
}

function expenseRecord(id: string, updatedAt = NOW): SyncRecord {
  return { type: 'expense', id, updatedAt, data: { id, amount: 100, createdAt: updatedAt, updatedAt } }
}

function row(rec: SyncRecord, seq: number, keyVersion: number) {
  return {
    record_key: `key-${rec.type}-${rec.id}`,
    ciphertext: JSON.stringify(rec),
    iv: 'iv',
    enc_v: 1,
    updated_at_ms: Date.parse(rec.updatedAt),
    key_version: keyVersion,
    author_id: BOB,
    device_id: 'other-device',
    seq,
  }
}

interface World {
  my: MySpace | null
  entries: Map<string, SpaceKeyEntry>
  meta: FamilySyncMeta
  pulled: Array<ReturnType<typeof row>>
  changed: { maxRev: number; records: Array<SyncRecord> }
  pendingJoin: { spaceId: string; ownerEmail: string | null; requestedAt: string } | null
  spaces: { [K in keyof SpacesApi]: ReturnType<typeof vi.fn> }
  local: { [K in keyof FamilyPorts['local']]: ReturnType<typeof vi.fn> }
  crypto: { [K in keyof FamilyCryptoPort]: ReturnType<typeof vi.fn> }
  events: Array<FamilyStreamEvent>
  stream: ReturnType<typeof createFamilyStream>
}

function baseEntry(over: Partial<SpaceKeyEntry> = {}): SpaceKeyEntry {
  return {
    id: SPACE,
    keyVersion: 1,
    key: bytesToBase64(sk1),
    indexKey: bytesToBase64(indexKey),
    name: 'Home',
    role: 'owner',
    joinedAt: NOW,
    updatedAt: NOW,
    status: 'active',
    wrappedFor: { keyVersion: 1, userIds: [OWNER] },
    ...over,
  }
}

function ownerSpace(over: Partial<MySpace> = {}): MySpace {
  return {
    space_id: SPACE,
    role: 'owner',
    status: 'active',
    key_version: 1,
    owner_id: OWNER,
    members: [member(OWNER, 'owner', 'active', ownerPair)],
    my_keys: [{ key_version: 1, wrapped_key: wrapV1 }],
    open_invites: [],
    paused: false,
    limits: { max_members: 5 },
    last_seq: 0,
    record_count: 0,
    total_bytes: 0,
    ...over,
  }
}

function setup(options: { entry?: Partial<SpaceKeyEntry> | null; my?: MySpace | null; meta?: Partial<FamilySyncMeta> } = {}): World {
  const world = {} as World
  world.my = options.my === undefined ? ownerSpace() : options.my
  world.entries = new Map()
  if (options.entry !== null) world.entries.set(SPACE, baseEntry(options.entry))
  world.meta = { localRev: 3, ...options.meta }
  world.pulled = []
  world.changed = { maxRev: 7, records: [] }
  world.pendingJoin = null
  world.events = []

  world.spaces = {
    getMySpace: vi.fn(() => Promise.resolve(world.my)),
    createSpace: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    getInvite: vi.fn(),
    requestJoin: vi.fn(),
    approveMember: vi.fn(),
    rejectMember: vi.fn(),
    removeMember: vi.fn(),
    rotateSpaceKey: vi.fn((spaceId: string, version: number) => Promise.resolve({ space_id: spaceId, key_version: version })),
    leaveSpace: vi.fn(),
    transferOwnership: vi.fn(),
    deleteSpace: vi.fn(),
    pushSpaceRecords: vi.fn((_s: string, _d: string, _v: number, recs: Array<EncryptedSyncRecord>) =>
      Promise.resolve({
        results: recs.map((r, i) => ({ record_key: r.record_key, status: 'accepted' as const, seq: 100 + i })),
        last_seq: 100 + recs.length,
      }),
    ),
    pullSpaceRecords: vi.fn((_s: string, _d: string, since: number) => {
      const rows = world.pulled.filter((r) => r.seq > since)
      return Promise.resolve({
        records: rows,
        has_more: false,
        last_seq: rows.at(-1)?.seq ?? since,
        key_version: world.my?.key_version ?? 1,
      })
    }),
  }

  world.local = {
    isUnlocked: vi.fn(() => true),
    listSpaceKeyEntries: vi.fn(() => Promise.resolve(Array.from(world.entries.values()))),
    getSpaceKeyEntry: vi.fn((id: string) => Promise.resolve(world.entries.get(id) ?? null)),
    createLocalSpace: vi.fn(),
    forgetLocalSpace: vi.fn(),
    adoptSpaceKey: vi.fn((input: { spaceId: string; keyVersion: number; sk: Uint8Array; indexKey: Uint8Array; name: string; role: 'owner' | 'member' }) => {
      const existing = world.entries.get(input.spaceId)
      let next: SpaceKeyEntry
      if (!existing) {
        next = {
          id: input.spaceId,
          keyVersion: input.keyVersion,
          key: bytesToBase64(input.sk),
          indexKey: bytesToBase64(input.indexKey),
          name: input.name,
          role: input.role,
          joinedAt: NOW,
          updatedAt: NOW,
          status: 'active',
        }
      } else if (input.keyVersion > existing.keyVersion) {
        next = {
          ...existing,
          keyVersion: input.keyVersion,
          key: bytesToBase64(input.sk),
          previousKeys: [...(existing.previousKeys ?? []), { keyVersion: existing.keyVersion, key: existing.key }],
        }
      } else if (input.keyVersion < existing.keyVersion && !existing.previousKeys?.some((k) => k.keyVersion === input.keyVersion)) {
        next = {
          ...existing,
          previousKeys: [...(existing.previousKeys ?? []), { keyVersion: input.keyVersion, key: bytesToBase64(input.sk) }],
        }
      } else {
        next = existing
      }
      world.entries.set(input.spaceId, next)
      return Promise.resolve(next)
    }),
    updateSpaceEntry: vi.fn((id: string, patch: Partial<SpaceKeyEntry>) => {
      const existing = world.entries.get(id)
      if (!existing) return Promise.resolve(null)
      const next = { ...existing, ...patch }
      world.entries.set(id, next)
      return Promise.resolve(next)
    }),
    ensureSpaceIndexKey: vi.fn(),
    ensureIdentityKeyPair: vi.fn(() => Promise.resolve(ownerPair)),
    listChangedRecords: vi.fn(() => Promise.resolve(world.changed)),
    applyIncomingRecords: vi.fn((_id: string, recs: Array<SyncRecord>) =>
      Promise.resolve({ applied: recs.length, kept: 0, conflicts: 0 }),
    ),
    dedupeOccurrences: vi.fn(() => Promise.resolve(0)),
    compactTombstones: vi.fn(() => Promise.resolve(0)),
    getSpaceInfo: vi.fn(() => Promise.resolve({ id: 'space' as const, name: 'Home', createdAt: NOW, updatedAt: NOW })),
    updateSpaceInfo: vi.fn(),
    getMemberProfiles: vi.fn(() => Promise.resolve([])),
    upsertMemberProfile: vi.fn((_id: string, input: { id: string; displayName: string; color: string }) =>
      Promise.resolve({ ...input, updatedAt: NOW }),
    ),
    countEntries: vi.fn(() => Promise.resolve(0)),
    onSpaceLocalChange: vi.fn(() => () => undefined),
  }

  world.crypto = {
    deriveKeys: vi.fn((_index: Uint8Array, sk: Uint8Array) => Promise.resolve({ sk: bytesToBase64(sk) } as never)),
    encrypt: vi.fn((_keys: unknown, rec: SyncRecord) =>
      Promise.resolve({
        record_key: `key-${rec.type}-${rec.id}`,
        ciphertext: JSON.stringify(rec),
        iv: 'iv',
        enc_v: 1,
        updated_at_ms: Date.parse(rec.updatedAt),
      }),
    ),
    decrypt: vi.fn((_keys: unknown, r: { ciphertext: string }) => Promise.resolve(JSON.parse(r.ciphertext) as SyncRecord)),
  }

  const ports: FamilyPorts = {
    local: world.local as unknown as FamilyPorts['local'],
    meta: {
      read: vi.fn(() => Promise.resolve({ ...world.meta })),
      update: vi.fn((_id: string, patch: Partial<FamilySyncMeta>) => {
        const next = { ...world.meta, ...patch }
        for (const k of Object.keys(patch) as Array<keyof FamilySyncMeta>) {
          if (patch[k] === undefined) delete next[k]
        }
        world.meta = next
        return Promise.resolve({ ...world.meta })
      }),
    },
    pending: {
      readJoin: vi.fn(() => world.pendingJoin),
      saveJoin: vi.fn(),
      clearJoin: vi.fn(() => {
        world.pendingJoin = null
      }),
      clearInvite: vi.fn(),
    },
  }

  world.stream = createFamilyStream({
    spaces: world.spaces as unknown as SpacesApi,
    ports,
    getUserId: () => OWNER,
    crypto: world.crypto as unknown as FamilyCryptoPort,
    clock: { now: () => Date.parse(NOW), setTimeout: () => 0, clearTimeout: () => undefined, yieldToUi: () => Promise.resolve() },
    defaultName: () => 'Family',
  })
  world.stream.onEvent((e) => world.events.push(e))
  return world
}

function run(world: World, space: SyncStatus['space'] = world.my ? { space_id: SPACE, role: world.my.role, status: world.my.status, paused: world.my.paused } : null) {
  return world.stream.run({ userId: OWNER, deviceId: DEVICE, status: syncStatus(space), checkpoint: vi.fn() })
}

function stateOf(world: World): FamilySyncState {
  return world.stream.getState()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('familyStatusForCloudError', () => {
  it.each([
    ['space_paused', 'paused', false],
    ['space_gone', 'space-gone', false],
    ['not_space_member', 'removed', false],
    ['network', 'error', true],
    ['unknown', 'error', true],
    ['member_limit', 'error', false],
  ] as const)('%s -> %s (retry %s)', (code, status, retry) => {
    expect(familyStatusForCloudError(code)).toEqual({ status, retry })
  })
})

describe('INITIAL_FAMILY_STATE', () => {
  it('is none with everything else empty', () => {
    expect(INITIAL_FAMILY_STATE.status).toBe('none')
    expect(INITIAL_FAMILY_STATE.spaceId).toBeNull()
    expect(INITIAL_FAMILY_STATE.space).toBeNull()
    expect(INITIAL_FAMILY_STATE.readOnly).toBe(false)
    expect(INITIAL_FAMILY_STATE.progress).toBeNull()
    expect(INITIAL_FAMILY_STATE.errorCode).toBeNull()
  })

  it('a fresh stream starts there', () => {
    expect(stateOf(setup({ entry: null, my: null })).status).toBe('none')
  })
})

describe('no work', () => {
  it('without an entry and a server space it makes no call and stays none', async () => {
    const w = setup({ entry: null, my: null })

    const result = await run(w, null)

    expect(w.spaces.getMySpace).not.toHaveBeenCalled()
    expect(w.spaces.pullSpaceRecords).not.toHaveBeenCalled()
    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
    expect(result.status).toBe('none')
    expect(stateOf(w).status).toBe('none')
  })

  it.each([
    ['removed', 'removed'],
    ['space-gone', 'space-gone'],
  ] as const)('a read-only %s entry shows %s without a server call', async (status, expected) => {
    const w = setup({ entry: { status }, my: null })

    await run(w, null)

    expect(stateOf(w)).toMatchObject({ status: expected, readOnly: true, spaceId: SPACE })
    expect(w.spaces.getMySpace).not.toHaveBeenCalled()
    expect(w.spaces.pullSpaceRecords).not.toHaveBeenCalled()
    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
  })
})

describe('losing access (get_my_space is null)', () => {
  it('not_space_member from the probe marks the entry removed and stops', async () => {
    const w = setup({ my: null })
    w.spaces.pullSpaceRecords.mockRejectedValueOnce(new CloudError('not_space_member', 'MINIMA:not_space_member'))

    await run(w, null)

    expect(w.spaces.pullSpaceRecords).toHaveBeenCalledWith(SPACE, DEVICE, 0, 1)
    expect(w.entries.get(SPACE)?.status).toBe('removed')
    expect(stateOf(w)).toMatchObject({ status: 'removed', readOnly: true })
    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
  })

  it('space_gone from the probe marks the entry space-gone', async () => {
    const w = setup({ my: null })
    w.spaces.pullSpaceRecords.mockRejectedValueOnce(new CloudError('space_gone', 'MINIMA:space_gone'))

    await run(w, null)

    expect(w.entries.get(SPACE)?.status).toBe('space-gone')
    expect(stateOf(w).status).toBe('space-gone')
  })

  it('a network error on the probe is an error with retry, and the entry stays active', async () => {
    const w = setup({ my: null })
    w.spaces.pullSpaceRecords.mockRejectedValueOnce(new CloudError('network', 'down'))

    const result = await run(w, null)

    expect(w.entries.get(SPACE)?.status).toBe('active')
    expect(stateOf(w).status).toBe('error')
    expect(result.retry).toBe(true)
  })

  it('clears the pending join marker', async () => {
    const w = setup({ my: null })
    w.pendingJoin = { spaceId: SPACE, ownerEmail: 'o@example.com', requestedAt: NOW }
    w.spaces.pullSpaceRecords.mockRejectedValueOnce(new CloudError('not_space_member', 'x'))

    await run(w, null)

    expect(w.pendingJoin).toBeNull()
  })
})

describe('pending approval', () => {
  it('shows pending-approval with the owner email of this device and syncs nothing', async () => {
    const w = setup({
      entry: null,
      my: { ...ownerSpace(), role: 'member', status: 'pending', key_version: null, owner_id: null, members: [], my_keys: [], limits: null },
    })
    w.pendingJoin = { spaceId: SPACE, ownerEmail: 'owner@example.com', requestedAt: NOW }

    await run(w, { space_id: SPACE, role: 'member', status: 'pending', paused: false })

    expect(stateOf(w)).toMatchObject({ status: 'pending-approval', pendingOwnerEmail: 'owner@example.com' })
    expect(w.spaces.pullSpaceRecords).not.toHaveBeenCalled()
    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
    expect(w.local.adoptSpaceKey).not.toHaveBeenCalled()
  })

  it('has no owner email on a device that did not request', async () => {
    const w = setup({
      entry: null,
      my: { ...ownerSpace(), role: 'member', status: 'pending', key_version: null, owner_id: null, members: [], my_keys: [], limits: null },
    })

    await run(w, { space_id: SPACE, role: 'member', status: 'pending', paused: false })

    expect(stateOf(w).status).toBe('pending-approval')
    expect(stateOf(w).pendingOwnerEmail).toBeNull()
  })
})

describe('paused', () => {
  it('shows paused and neither pulls nor pushes', async () => {
    const w = setup({ my: ownerSpace({ paused: true }) })
    w.changed = { maxRev: 9, records: [expenseRecord('queued')] }

    await run(w)

    expect(stateOf(w).status).toBe('paused')
    expect(w.spaces.pullSpaceRecords).not.toHaveBeenCalled()
    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
  })

  it('syncs normally once the pause is lifted (queued edits go out)', async () => {
    const w = setup({ my: ownerSpace({ paused: true }) })
    w.changed = { maxRev: 9, records: [expenseRecord('queued')] }
    await run(w)

    w.my = ownerSpace({ paused: false })
    const result = await run(w)

    expect(stateOf(w).status).toBe('synced')
    expect(result.pushed).toBe(1)
    expect(w.spaces.pushSpaceRecords).toHaveBeenCalledTimes(1)
  })

  it('maps a space_paused error from the server to paused too', async () => {
    const w = setup()
    w.spaces.pullSpaceRecords.mockRejectedValueOnce(new CloudError('space_paused', 'MINIMA:space_paused'))

    const result = await run(w)

    expect(stateOf(w).status).toBe('paused')
    expect(result.retry).toBe(false)
  })
})

describe('a normal cycle', () => {
  it('pulls, applies by space id, pushes local changes and ends synced', async () => {
    const w = setup({ meta: { pushedRev: 2, pullCursor: 0 } })
    w.pulled = [row(expenseRecord('p1'), 1, 1), row(expenseRecord('p2'), 2, 1)]
    w.changed = { maxRev: 9, records: [expenseRecord('mine')] }

    const result = await run(w)

    expect(w.local.applyIncomingRecords).toHaveBeenCalledWith(SPACE, expect.arrayContaining([expect.objectContaining({ id: 'p1' })]), expect.anything())
    expect(w.local.listChangedRecords).toHaveBeenCalledWith(SPACE, 2)
    expect(w.spaces.pushSpaceRecords).toHaveBeenCalledWith(SPACE, DEVICE, 1, [expect.objectContaining({ record_key: 'key-expense-mine' })])
    expect(w.meta).toMatchObject({ pullCursor: 2, pushedRev: 9 })
    expect(result).toMatchObject({ status: 'synced', pulled: 2, pushed: 1 })
    expect(stateOf(w)).toMatchObject({ status: 'synced', spaceId: SPACE, role: 'owner' })
    expect(stateOf(w).lastSyncAt).not.toBeNull()
  })

  it('refreshes get_my_space at the start of every cycle', async () => {
    const w = setup()

    await run(w)
    await run(w)

    expect(w.spaces.getMySpace).toHaveBeenCalledTimes(2)
  })

  it('a missing pushedRev means 0, not a full re-upload', async () => {
    const w = setup({ meta: {} })

    await run(w)

    expect(w.local.listChangedRecords).toHaveBeenCalledWith(SPACE, 0)
  })

  it('pushes nothing when nothing changed', async () => {
    const w = setup({ meta: { pushedRev: 7 } })
    w.changed = { maxRev: 7, records: [] }

    const result = await run(w)

    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
    expect(result.pushed).toBe(0)
  })

  it('never rejects, even when the server throws something unexpected', async () => {
    const w = setup()
    w.spaces.getMySpace.mockRejectedValueOnce(new Error('boom'))

    await expect(run(w)).resolves.toBeDefined()
    expect(stateOf(w).status).toBe('error')
  })

  it('a Family error is reported in the state with its code', async () => {
    const w = setup()
    w.spaces.pullSpaceRecords.mockRejectedValueOnce(new CloudError('quota_exceeded', 'MINIMA:quota_exceeded'))

    const result = await run(w)

    expect(stateOf(w)).toMatchObject({ status: 'error', errorCode: 'quota_exceeded' })
    expect(result.retry).toBe(false)
  })
})

describe('keys per version', () => {
  it('a row of an unknown version triggers one get_my_space refresh and is skipped if still missing', async () => {
    const w = setup({ meta: { pullCursor: 0 } })
    w.pulled = [row(expenseRecord('ok1'), 1, 1), row(expenseRecord('late'), 2, 2), row(expenseRecord('ok2'), 3, 1)]

    const result = await run(w)

    expect(w.spaces.getMySpace.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result.missingKey).toBe(1)
    const applied = w.local.applyIncomingRecords.mock.calls.flatMap((c) => (c[1] as Array<SyncRecord>).map((r) => r.id))
    expect(applied).toContain('ok1')
    expect(applied).toContain('ok2')
    expect(applied).not.toContain('late')
    expect(w.meta.pullCursor).toBe(1)
  })

  it('adopts the missing version from my_keys on the refresh and then applies the row', async () => {
    const w = setup({ meta: { pullCursor: 0 } })
    const sk2 = generateSpaceKey()
    const wrapV2 = await wrapSpaceKeyBundleForPublicKey({ v: 1, keyVersion: 2, sk: sk2, indexKey }, ownerPair.publicKeyJwk)
    w.pulled = [row(expenseRecord('v2row'), 1, 2)]
    // The first read (cycle start) still shows v1; the refresh shows v2.
    w.spaces.getMySpace.mockResolvedValueOnce(ownerSpace()).mockResolvedValue(
      ownerSpace({ key_version: 2, my_keys: [{ key_version: 1, wrapped_key: wrapV1 }, { key_version: 2, wrapped_key: wrapV2 }] }),
    )

    const result = await run(w)

    expect(w.local.adoptSpaceKey).toHaveBeenCalledWith(expect.objectContaining({ keyVersion: 2 }))
    expect(result.missingKey).toBe(0)
    expect(w.meta.pullCursor).toBe(1)
  })

  it('derives the data key of the version a row carries (two versions held)', async () => {
    const sk2 = generateSpaceKey()
    const w = setup({
      entry: { keyVersion: 2, key: bytesToBase64(sk2), previousKeys: [{ keyVersion: 1, key: bytesToBase64(sk1) }] },
      my: ownerSpace({ key_version: 2 }),
      meta: { keyVersion: 2 },
    })
    w.pulled = [row(expenseRecord('old'), 1, 1), row(expenseRecord('new'), 2, 2)]

    await run(w)

    const used = w.crypto.deriveKeys.mock.calls.map((c) => bytesToBase64(c[1] as Uint8Array))
    expect(used).toContain(bytesToBase64(sk1))
    expect(used).toContain(bytesToBase64(sk2))
    expect(w.crypto.deriveKeys.mock.calls.every((c) => bytesToBase64(c[0] as Uint8Array) === bytesToBase64(indexKey))).toBe(true)
  })
})

describe('push and key_outdated', () => {
  it('refreshes, adopts the newest bundle, re-encrypts the batch at the new version and retries once', async () => {
    const w = setup({ meta: { pushedRev: 1 } })
    w.changed = { maxRev: 9, records: [expenseRecord('mine')] }
    const sk2 = generateSpaceKey()
    const wrapV2 = await wrapSpaceKeyBundleForPublicKey({ v: 1, keyVersion: 2, sk: sk2, indexKey }, ownerPair.publicKeyJwk)
    w.spaces.pushSpaceRecords
      .mockRejectedValueOnce(new CloudError('key_outdated', 'MINIMA:key_outdated:2'))
    w.spaces.getMySpace.mockResolvedValueOnce(ownerSpace()).mockResolvedValue(
      ownerSpace({ key_version: 2, my_keys: [{ key_version: 1, wrapped_key: wrapV1 }, { key_version: 2, wrapped_key: wrapV2 }] }),
    )

    const result = await run(w)

    expect(w.spaces.pushSpaceRecords).toHaveBeenCalledTimes(2)
    expect(w.spaces.pushSpaceRecords.mock.calls[0][2]).toBe(1)
    expect(w.spaces.pushSpaceRecords.mock.calls[1][2]).toBe(2)
    expect(w.local.adoptSpaceKey).toHaveBeenCalledWith(expect.objectContaining({ keyVersion: 2 }))
    expect(result.status).toBe('synced')
    expect(w.meta.pushedRev).toBe(9)
  })

  it('a second key_outdated is an error and pushedRev does not advance', async () => {
    const w = setup({ meta: { pushedRev: 1 } })
    w.changed = { maxRev: 9, records: [expenseRecord('mine')] }
    w.spaces.pushSpaceRecords.mockRejectedValue(new CloudError('key_outdated', 'MINIMA:key_outdated:2'))

    await run(w)

    expect(w.spaces.pushSpaceRecords).toHaveBeenCalledTimes(2)
    expect(stateOf(w).status).toBe('error')
    expect(w.meta.pushedRev).toBe(1)
  })

  it('stale results are applied with preferIncomingOnTie (the server wins ties)', async () => {
    const w = setup({ meta: { pushedRev: 1 } })
    w.changed = { maxRev: 9, records: [expenseRecord('mine')] }
    const server = row(expenseRecord('mine', '2026-10-30T13:00:00.000Z'), 50, 1)
    w.spaces.pushSpaceRecords.mockResolvedValueOnce({
      results: [{ record_key: 'key-expense-mine', status: 'stale', current: server }],
      last_seq: 50,
    })

    const result = await run(w)

    expect(result.stale).toBe(1)
    const last = w.local.applyIncomingRecords.mock.calls.at(-1)
    expect(last?.[2]).toEqual({ preferIncomingOnTie: true })
  })
})

describe('rotation', () => {
  function twoMembers() {
    return ownerSpace({
      members: [member(OWNER, 'owner', 'active', ownerPair), member(BOB, 'member', 'active', bobPair)],
    })
  }

  it('rotates when the wrap set holds a member who is no longer active', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB, CAROL] } },
      my: twoMembers(),
    })
    w.spaces.rotateSpaceKey.mockImplementation((spaceId: string, version: number) => {
      w.my = twoMembers()
      w.my.key_version = version
      return Promise.resolve({ space_id: spaceId, key_version: version })
    })

    const result = await run(w)

    expect(result.rotated).toBe(true)
    expect(w.spaces.rotateSpaceKey).toHaveBeenCalledTimes(1)
    const [spaceId, version, wraps] = w.spaces.rotateSpaceKey.mock.calls[0] as [string, number, Array<{ user_id: string; wrapped_key: WrappedSpaceKey }>]
    expect(spaceId).toBe(SPACE)
    expect(version).toBe(2)
    expect(wraps.map((x) => x.user_id).sort()).toEqual([BOB, OWNER].sort())
  })

  it('wraps a fresh sk with the SAME indexKey for every remaining member, each openable only by its owner', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB, CAROL] } },
      my: twoMembers(),
    })

    await run(w)

    const wraps = w.spaces.rotateSpaceKey.mock.calls[0][2] as Array<{ user_id: string; wrapped_key: WrappedSpaceKey }>
    const bobWrap = wraps.find((x) => x.user_id === BOB)?.wrapped_key
    const ownerWrap = wraps.find((x) => x.user_id === OWNER)?.wrapped_key
    if (!bobWrap || !ownerWrap) throw new Error('missing wrap')
    const bundle = await unwrapSpaceKeyBundle(bobWrap, bobPair.privateKeyJwk)
    expect(bundle.keyVersion).toBe(2)
    expect(bytesToBase64(bundle.indexKey)).toBe(bytesToBase64(indexKey))
    expect(bytesToBase64(bundle.sk)).not.toBe(bytesToBase64(sk1))
    await expect(unwrapSpaceKeyBundle(bobWrap, ownerPair.privateKeyJwk)).rejects.toBeDefined()
    expect((await unwrapSpaceKeyBundle(ownerWrap, ownerPair.privateKeyJwk)).keyVersion).toBe(2)
  })

  it('stores the new version (old kept), records the wrap set and re-encrypts the full snapshot', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB, CAROL] } },
      my: twoMembers(),
      meta: { pushedRev: 7 },
    })
    w.spaces.rotateSpaceKey.mockImplementation((spaceId: string, version: number) => {
      w.my = { ...twoMembers(), key_version: version }
      return Promise.resolve({ space_id: spaceId, key_version: version })
    })
    w.changed = { maxRev: 7, records: [expenseRecord('a'), expenseRecord('b')] }

    const result = await run(w)

    expect(w.local.adoptSpaceKey).toHaveBeenCalledWith(expect.objectContaining({ spaceId: SPACE, keyVersion: 2 }))
    const adopted = w.local.adoptSpaceKey.mock.calls[0][0] as { indexKey: Uint8Array }
    expect(bytesToBase64(adopted.indexKey)).toBe(bytesToBase64(indexKey))
    expect(w.entries.get(SPACE)?.keyVersion).toBe(2)
    expect(w.entries.get(SPACE)?.previousKeys?.map((k) => k.keyVersion)).toContain(1)
    expect(w.entries.get(SPACE)?.wrappedFor).toEqual({ keyVersion: 2, userIds: expect.arrayContaining([OWNER, BOB]) })
    expect(w.entries.get(SPACE)?.wrappedFor?.userIds).not.toContain(CAROL)
    expect(w.local.listChangedRecords).toHaveBeenCalledWith(SPACE, -1)
    expect(w.spaces.pushSpaceRecords.mock.calls[0][2]).toBe(2)
    expect(result.reencrypted).toBe(2)
    expect(w.meta.reencryptPending).toBeFalsy()
    expect(w.meta.keyVersion).toBe(2)
  })

  it('rotates after an explicit removal (rotationPendingFrom >= server version)', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB] } },
      my: twoMembers(),
      meta: { rotationPendingFrom: 1 },
    })
    w.spaces.rotateSpaceKey.mockImplementation((spaceId: string, version: number) => {
      w.my = { ...twoMembers(), key_version: version }
      return Promise.resolve({ space_id: spaceId, key_version: version })
    })

    await run(w)

    expect(w.spaces.rotateSpaceKey).toHaveBeenCalledTimes(1)
    expect(w.meta.rotationPendingFrom).toBeUndefined()
  })

  it('does not rotate when the wrap set matches the active members', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB] } },
      my: twoMembers(),
    })

    const result = await run(w)

    expect(w.spaces.rotateSpaceKey).not.toHaveBeenCalled()
    expect(result.rotated).toBe(false)
  })

  it('a failed rotation (offline) is rotation-pending: pull runs, every push waits, retry is asked', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB, CAROL] } },
      my: twoMembers(),
      meta: { pushedRev: 1 },
    })
    w.changed = { maxRev: 9, records: [expenseRecord('queued')] }
    w.spaces.rotateSpaceKey.mockRejectedValue(new CloudError('network', 'offline'))

    const result = await run(w)

    expect(stateOf(w).status).toBe('rotation-pending')
    expect(w.spaces.pullSpaceRecords).toHaveBeenCalled()
    expect(w.spaces.pushSpaceRecords).not.toHaveBeenCalled()
    expect(w.meta.rotationPendingFrom).toBe(1)
    expect(result.retry).toBe(true)
  })

  it('the next cycle retries the rotation and then pushes', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB, CAROL] } },
      my: twoMembers(),
      meta: { pushedRev: 1 },
    })
    w.changed = { maxRev: 9, records: [expenseRecord('queued')] }
    w.spaces.rotateSpaceKey.mockRejectedValueOnce(new CloudError('network', 'offline')).mockImplementation((spaceId: string, version: number) => {
      w.my = { ...twoMembers(), key_version: version }
      return Promise.resolve({ space_id: spaceId, key_version: version })
    })
    await run(w)

    await run(w)

    expect(w.spaces.rotateSpaceKey).toHaveBeenCalledTimes(2)
    expect(stateOf(w).status).toBe('synced')
    expect(w.spaces.pushSpaceRecords).toHaveBeenCalled()
  })

  it('members_mismatch refreshes get_my_space and retries once', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER, BOB, CAROL] } },
      my: twoMembers(),
    })
    w.spaces.rotateSpaceKey
      .mockRejectedValueOnce(new CloudError('members_mismatch', 'MINIMA:members_mismatch'))
      .mockImplementation((spaceId: string, version: number) => {
        w.my = { ...twoMembers(), key_version: version }
        return Promise.resolve({ space_id: spaceId, key_version: version })
      })
    const readsBefore = w.spaces.getMySpace.mock.calls.length

    const result = await run(w)

    expect(w.spaces.rotateSpaceKey).toHaveBeenCalledTimes(2)
    expect(w.spaces.getMySpace.mock.calls.length - readsBefore).toBeGreaterThanOrEqual(2)
    expect(result.rotated).toBe(true)
  })

  it('a member does not rotate', async () => {
    const w = setup({
      entry: { role: 'member', wrappedFor: undefined },
      my: { ...twoMembers(), role: 'member', owner_id: BOB },
      meta: { rotationPendingFrom: 1 },
    })

    await run(w)

    expect(w.spaces.rotateSpaceKey).not.toHaveBeenCalled()
  })
})

describe('join completion and requests', () => {
  it('adopts the newest bundle, writes the profile, clears the pending join and announces the join', async () => {
    const w = setup({
      entry: null,
      my: {
        ...ownerSpace(),
        role: 'member',
        owner_id: BOB,
        members: [member(BOB, 'owner', 'active', bobPair), member(OWNER, 'member', 'active', ownerPair)],
      },
    })
    w.pendingJoin = { spaceId: SPACE, ownerEmail: 'bob@example.com', requestedAt: NOW }
    w.pulled = [row(expenseRecord('theirs'), 1, 1)]

    await run(w)

    expect(w.local.adoptSpaceKey).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: SPACE, keyVersion: 1, role: 'member', name: 'Family' }),
    )
    expect(w.local.upsertMemberProfile).toHaveBeenCalledWith(
      SPACE,
      expect.objectContaining({ id: OWNER, displayName: `${OWNER}`.split('@')[0] }),
    )
    expect(w.pendingJoin).toBeNull()
    expect(w.events.find((e) => e.type === 'joined')).toMatchObject({ type: 'joined', spaceId: SPACE, name: 'Home' })
    expect(w.local.applyIncomingRecords).toHaveBeenCalled()
  })

  it('a running member adopts versions missing from its entry and syncs a changed role', async () => {
    const sk2 = generateSpaceKey()
    const wrapV2 = await wrapSpaceKeyBundleForPublicKey({ v: 1, keyVersion: 2, sk: sk2, indexKey }, ownerPair.publicKeyJwk)
    const w = setup({
      entry: { role: 'member' },
      my: ownerSpace({ key_version: 2, my_keys: [{ key_version: 1, wrapped_key: wrapV1 }, { key_version: 2, wrapped_key: wrapV2 }] }),
    })

    await run(w)

    expect(w.entries.get(SPACE)?.keyVersion).toBe(2)
    expect(w.entries.get(SPACE)?.role).toBe('owner')
  })

  it('emits join-request once per pending member and never again', async () => {
    const w = setup({
      entry: { wrappedFor: { keyVersion: 1, userIds: [OWNER] } },
      my: ownerSpace({
        members: [member(OWNER, 'owner', 'active', ownerPair), member(BOB, 'member', 'pending', bobPair)],
      }),
    })

    await run(w)
    await run(w)

    const requests = w.events.filter((e) => e.type === 'join-request')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ spaceId: SPACE, userId: BOB, email: `${BOB}@example.com` })
    expect(w.meta.notifiedRequests).toContain(BOB)
  })

  it('a second pending member is announced on its own', async () => {
    const w = setup({
      my: ownerSpace({
        members: [member(OWNER, 'owner', 'active', ownerPair), member(BOB, 'member', 'pending', bobPair)],
      }),
    })
    await run(w)
    w.my = ownerSpace({
      members: [
        member(OWNER, 'owner', 'active', ownerPair),
        member(BOB, 'member', 'pending', bobPair),
        member(CAROL, 'member', 'pending', bobPair),
      ],
    })

    await run(w)

    const ids = w.events.flatMap((e) => (e.type === 'join-request' ? [e.userId] : []))
    expect(ids).toEqual([BOB, CAROL])
  })
})

describe('state store', () => {
  it('notifies subscribers when the state changes and stops after unsubscribe', async () => {
    const w = setup()
    const listener = vi.fn()
    const off = w.stream.subscribe(listener)

    await run(w)
    expect(listener).toHaveBeenCalled()
    const calls = listener.mock.calls.length
    off()
    await run(w)

    expect(listener.mock.calls.length).toBe(calls)
  })

  it('emits state events while running and settles on synced', async () => {
    const w = setup()

    await run(w)

    const states = w.events.flatMap((e) => (e.type === 'state' ? [e.state.status] : []))
    expect(states).toContain('syncing')
    expect(states.at(-1)).toBe('synced')
  })

  it('refreshFromLocal reads entries and meta without any server call', async () => {
    const w = setup({ meta: { lastSyncAt: NOW, state: 'synced' } })

    const state = await w.stream.refreshFromLocal()

    expect(state.spaceId).toBe(SPACE)
    expect(state.name).toBe('Home')
    expect(w.spaces.getMySpace).not.toHaveBeenCalled()
    expect(w.spaces.pullSpaceRecords).not.toHaveBeenCalled()
  })

  it('markOffline shows offline, setSpace stores the snapshot', async () => {
    const w = setup()
    await run(w)

    w.stream.markOffline()
    expect(stateOf(w).status).toBe('offline')

    w.stream.setSpace(ownerSpace({ paused: true }))
    expect(stateOf(w).space?.paused).toBe(true)
  })

  it('onLocalChange fires when the local port reports a change in the space', async () => {
    const w = setup()
    const listener = vi.fn()
    w.stream.onLocalChange(listener)
    const registered = w.local.onSpaceLocalChange.mock.calls.at(-1)?.[0] as ((id: string) => void) | undefined

    registered?.(SPACE)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('decodes nothing it cannot read: the stored key stays base64 of 32 bytes', () => {
    expect(base64ToBytes(bytesToBase64(sk1)).byteLength).toBe(32)
  })
})
