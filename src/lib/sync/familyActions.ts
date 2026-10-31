// The Family flows (docs/free-tier-spec.md §22): create, invite, join,
// approve, reject, remove, leave, transfer, delete, forget, rename and the
// own display name. Every action needs a signed-in user and hands a fresh
// get_my_space snapshot to the stream afterwards.
//
// Create is gated like every data move: personal sync on for this device and
// a FRESH get_sync_status with hasFeature(status, 'shared_spaces'). This file
// never imports the cloud api (CloudError comes from rpc). The invite secret
// lives only in the link: only inviteToken(secret) is sent and only its hash
// is stored by the server. Nothing here logs.

import { isSyncOn } from './syncMeta'
import type { MySpace } from '@/lib/cloud/spacesApi'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import type {
  CreateFamilyResult,
  CreatedFamilyInvite,
  FamilyActionErrorCode,
  FamilyActions,
  FamilyActionsDeps,
  FamilyOverview,
  JoinRequestResult,
} from './types'
import { hasFeature } from '@/lib/cloud/entitlements'
import { CloudError } from '@/lib/cloud/rpc'
import { base64ToBytes } from '@/lib/crypto'
import {
  buildInviteUrl,
  createInviteSecret,
  inviteToken,
  inviteTokenHash,
} from '@/lib/spaces/invite'
import { defaultDisplayName, memberColor } from '@/lib/spaces/member'
import {
  safetyCode,
  unwrapSpaceKeyBundle,
  wrapSpaceKeyBundleForPublicKey,
} from '@/lib/spaces/spaceCrypto'

export class FamilyActionError extends Error {
  readonly code: FamilyActionErrorCode
  constructor(code: FamilyActionErrorCode, message: string = code) {
    super(message)
    this.name = 'FamilyActionError'
    this.code = code
  }
}

const SPACE_NAME_MAX = 60
const DISPLAY_NAME_MAX = 40

function cloudCodeOf(err: unknown): string | null {
  if (err instanceof CloudError) return err.code
  if (
    err instanceof Error &&
    err.name === 'CloudError' &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as Error & { code: string }).code
  }
  return null
}

function defaultOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

export function createFamilyActions(deps: FamilyActionsDeps): FamilyActions {
  const { api, spaces, engine, family, ports, personalMeta, getUserId } = deps
  const local = ports.local
  const origin = deps.origin ?? defaultOrigin

  function requireUser(): string {
    const userId = getUserId()
    if (userId === null) throw new FamilyActionError('not_signed_in')
    return userId
  }

  // Hands a fresh snapshot to the stream; a failed read never fails the action.
  async function refreshSnapshot(): Promise<MySpace | null> {
    try {
      const my = await spaces.getMySpace()
      family.setSpace(my)
      return my
    } catch {
      return null
    }
  }

  async function activeEntry(): Promise<SpaceKeyEntry | null> {
    const entries = await local.listSpaceKeyEntries()
    return entries.find((e) => e.status === 'active') ?? null
  }

  // The caller's active membership, else no_family.
  async function requireMySpace(): Promise<MySpace> {
    const my = await spaces.getMySpace()
    if (!my || my.status !== 'active') throw new FamilyActionError('no_family')
    return my
  }

  async function requireOwnerSpace(): Promise<MySpace> {
    const my = await requireMySpace()
    if (my.role !== 'owner') throw new FamilyActionError('not_owner')
    return my
  }

  // The entry of the space, after adopting every version of my_keys it lacks.
  async function currentEntry(my: MySpace): Promise<SpaceKeyEntry> {
    let entry = await local.getSpaceKeyEntry(my.space_id)
    if (!entry) throw new FamilyActionError('no_family')
    const held = new Set<number>([
      entry.keyVersion,
      ...(entry.previousKeys ?? []).map((p) => p.keyVersion),
    ])
    const missing = my.my_keys
      .filter((k) => !held.has(k.key_version))
      .sort((a, b) => a.key_version - b.key_version)
    if (missing.length > 0) {
      const pair = await local.ensureIdentityKeyPair()
      for (const wrap of missing) {
        const bundle = await unwrapSpaceKeyBundle(wrap.wrapped_key, pair.privateKeyJwk)
        try {
          entry = await local.adoptSpaceKey({
            spaceId: my.space_id,
            keyVersion: bundle.keyVersion,
            sk: bundle.sk,
            indexKey: bundle.indexKey,
            name: entry.name,
            role: entry.role,
          })
        } finally {
          bundle.sk.fill(0)
          bundle.indexKey.fill(0)
        }
      }
    }
    return entry
  }

  // The newest bundle the entry holds, wrapped for `publicKey`.
  async function wrapCurrent(entry: SpaceKeyEntry, publicKey: JsonWebKey) {
    if (!entry.indexKey || !entry.key) throw new FamilyActionError('no_family')
    const sk = base64ToBytes(entry.key)
    const indexKey = base64ToBytes(entry.indexKey)
    try {
      return await wrapSpaceKeyBundleForPublicKey(
        { v: 1, keyVersion: entry.keyVersion, sk, indexKey },
        publicKey,
      )
    } finally {
      sk.fill(0)
      indexKey.fill(0)
    }
  }

  async function writeOwnProfile(
    spaceId: string,
    me: string,
    my: MySpace | null,
  ): Promise<void> {
    const profiles = await local.getMemberProfiles(spaceId)
    const existing = profiles.find((p) => p.id === me)
    const email = my?.members.find((m) => m.user_id === me)?.email ?? null
    const displayName = defaultDisplayName(email) || existing?.displayName || ''
    await local.upsertMemberProfile(spaceId, {
      id: me,
      displayName,
      color: existing?.color ?? memberColor(me),
    })
  }

  return {
    async createFamily({ name }): Promise<CreateFamilyResult> {
      const me = requireUser()
      // 1. The gates.
      if (!isSyncOn(await personalMeta.read())) throw new FamilyActionError('sync_off')
      const status = await api.getSyncStatus()
      if (!hasFeature(status, 'shared_spaces')) throw new FamilyActionError('not_in_plan')
      const trimmed = name.trim()
      if (trimmed.length === 0 || trimmed.length > SPACE_NAME_MAX) {
        throw new FamilyActionError('invalid_name')
      }

      // 2. Already in another space on the server: nothing changes locally.
      let my = await spaces.getMySpace()
      const entries = await local.listSpaceKeyEntries()
      const reusable =
        entries.find(
          (e) => e.role === 'owner' && (e.status === undefined || e.status === 'active'),
        ) ?? null
      if (my && (!reusable || my.space_id !== reusable.id)) {
        family.setSpace(my)
        return { kind: 'already-in-space', space: my }
      }

      // 3. Reuse a local owner space (a failed attempt or a local space).
      let spaceId: string
      if (reusable) {
        spaceId = reusable.id
      } else {
        spaceId = (await local.createLocalSpace({ name: trimmed })).id
      }

      // 4. The version 1 bundle, wrapped for the creator.
      const entry = await local.ensureSpaceIndexKey(spaceId)
      const pair = await local.ensureIdentityKeyPair()

      // 5. The server space, unless it already exists (a retry).
      if (!my) {
        const wrapped = await wrapCurrent(entry, pair.publicKeyJwk)
        try {
          await spaces.createSpace(spaceId, pair.publicKeyJwk, wrapped)
        } catch (err) {
          if (cloudCodeOf(err) !== 'already_in_space') throw err
          const current = await spaces.getMySpace()
          family.setSpace(current)
          return { kind: 'already-in-space', space: current }
        }
        my = await spaces.getMySpace()
      }

      // 6. Shared from now on; the first push is the full snapshot.
      await local.updateSpaceEntry(spaceId, {
        status: 'active',
        wrappedFor: { keyVersion: 1, userIds: [me] },
      })
      const meta = await ports.meta.read(spaceId)
      if (meta.pushedRev === undefined) await ports.meta.update(spaceId, { pushedRev: -1 })

      // 7. The creator's profile, then a cycle pushes everything.
      await writeOwnProfile(spaceId, me, my)
      family.setSpace(my)
      await engine.runCycle({ reason: 'family' })
      return { kind: 'created', spaceId }
    },

    async createInvite(): Promise<CreatedFamilyInvite> {
      requireUser()
      const my = await requireOwnerSpace()
      const secret = createInviteSecret()
      try {
        const token = await inviteToken(secret)
        const hash = await inviteTokenHash(token)
        const created = await spaces.createInvite(my.space_id, hash)
        const url = buildInviteUrl(origin(), created.invite_id, secret)
        await refreshSnapshot()
        return { url, inviteId: created.invite_id, expiresAt: created.expires_at }
      } finally {
        secret.fill(0)
      }
    },

    async revokeInvite(inviteId) {
      requireUser()
      await spaces.revokeInvite(inviteId)
      await refreshSnapshot()
    },

    async previewInvite(invite) {
      requireUser()
      return spaces.getInvite(invite.inviteId, await inviteToken(invite.secret))
    },

    async requestJoin(invite, ownerEmail): Promise<JoinRequestResult> {
      requireUser()
      const pair = await local.ensureIdentityKeyPair()
      const token = await inviteToken(invite.secret)
      let request
      try {
        request = await spaces.requestJoin(invite.inviteId, token, pair.publicKeyJwk)
      } catch (err) {
        if (cloudCodeOf(err) === 'invite_invalid') ports.pending.clearInvite()
        throw err
      }
      ports.pending.clearInvite()
      ports.pending.saveJoin({
        spaceId: request.space_id,
        ownerEmail,
        requestedAt: new Date().toISOString(),
      })
      const code = await safetyCode(pair.publicKeyJwk)
      await refreshSnapshot()
      return { spaceId: request.space_id, safetyCode: code }
    },

    async approveMember(userId) {
      requireUser()
      let my = await requireOwnerSpace()
      let entry = await currentEntry(my)
      const approve = async () => {
        const target = my.members.find((m) => m.user_id === userId)
        if (!target) throw new FamilyActionError('no_family', 'No such join request')
        const wrapped = await wrapCurrent(entry, target.public_key)
        await spaces.approveMember(my.space_id, userId, entry.keyVersion, wrapped)
      }
      try {
        await approve()
      } catch (err) {
        if (cloudCodeOf(err) !== 'wrong_key_version') throw err
        my = await requireOwnerSpace()
        entry = await currentEntry(my)
        await approve()
      }
      const wrappedFor = entry.wrappedFor
      if (wrappedFor && wrappedFor.keyVersion === entry.keyVersion && !wrappedFor.userIds.includes(userId)) {
        await local.updateSpaceEntry(my.space_id, {
          wrappedFor: { keyVersion: wrappedFor.keyVersion, userIds: [...wrappedFor.userIds, userId] },
        })
      }
      await refreshSnapshot()
    },

    async rejectMember(userId) {
      requireUser()
      const my = await requireOwnerSpace()
      await spaces.rejectMember(my.space_id, userId)
      await refreshSnapshot()
    },

    async removeMember(userId) {
      requireUser()
      const my = await requireOwnerSpace()
      await spaces.removeMember(my.space_id, userId)
      await ports.meta.update(my.space_id, { rotationPendingFrom: my.key_version ?? 1 })
      await refreshSnapshot()
      await engine.runCycle({ reason: 'family' })
    },

    async leaveFamily() {
      requireUser()
      const my = await spaces.getMySpace()
      const spaceId = my?.space_id ?? (await activeEntry())?.id ?? null
      if (spaceId === null) throw new FamilyActionError('no_family')
      await spaces.leaveSpace()
      if (await local.getSpaceKeyEntry(spaceId)) {
        await local.updateSpaceEntry(spaceId, { status: 'left' })
      }
      ports.pending.clearJoin()
      await refreshSnapshot()
    },

    async transferOwnership(userId) {
      requireUser()
      const my = await requireOwnerSpace()
      await spaces.transferOwnership(my.space_id, userId)
      await local.updateSpaceEntry(my.space_id, { role: 'member' })
      await refreshSnapshot()
    },

    async deleteFamily(confirmName) {
      requireUser()
      const my = await requireOwnerSpace()
      const info = await local.getSpaceInfo(my.space_id)
      const expected = (info?.name ?? (await local.getSpaceKeyEntry(my.space_id))?.name ?? '').trim()
      if (expected === '' || confirmName.trim() !== expected) {
        throw new FamilyActionError('name_mismatch')
      }
      await spaces.deleteSpace(my.space_id)
      await local.forgetLocalSpace(my.space_id)
      ports.pending.clearJoin()
      family.setSpace(null)
      // Pushes the entry tombstone, so the user's other devices forget the
      // Family on their next cycle instead of marking it space-gone.
      await engine.runCycle({ reason: 'family' })
    },

    async forgetFamily(spaceId) {
      requireUser()
      await local.forgetLocalSpace(spaceId)
      family.setSpace(null)
    },

    async renameFamily(name) {
      requireUser()
      const trimmed = name.trim()
      if (trimmed.length === 0 || trimmed.length > SPACE_NAME_MAX) {
        throw new FamilyActionError('invalid_name')
      }
      const my = await spaces.getMySpace()
      const spaceId = my?.space_id ?? (await activeEntry())?.id ?? null
      if (spaceId === null) throw new FamilyActionError('no_family')
      await local.updateSpaceInfo(spaceId, { name: trimmed })
      await local.updateSpaceEntry(spaceId, { name: trimmed })
      if (my) family.setSpace(my)
    },

    async setMyDisplayName(displayName) {
      const me = requireUser()
      const trimmed = displayName.trim().slice(0, DISPLAY_NAME_MAX)
      const my = await spaces.getMySpace()
      const spaceId = my?.space_id ?? (await activeEntry())?.id ?? null
      if (spaceId === null) throw new FamilyActionError('no_family')
      const profiles = await local.getMemberProfiles(spaceId)
      const existing = profiles.find((p) => p.id === me)
      await local.upsertMemberProfile(spaceId, {
        id: me,
        displayName: trimmed,
        color: existing?.color ?? memberColor(me),
      })
    },

    async refresh() {
      requireUser()
      const my = await spaces.getMySpace()
      family.setSpace(my)
      return my
    },

    async mySafetyCode() {
      requireUser()
      const pair = await local.ensureIdentityKeyPair()
      return safetyCode(pair.publicKeyJwk)
    },

    async getOverview(spaceId): Promise<FamilyOverview> {
      const [info, profiles, entryCount] = await Promise.all([
        local.getSpaceInfo(spaceId),
        local.getMemberProfiles(spaceId),
        local.countEntries(spaceId),
      ])
      return { info, profiles, entryCount }
    },
  }
}
