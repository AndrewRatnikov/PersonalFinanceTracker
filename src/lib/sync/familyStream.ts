// The Family stream (docs/free-tier-spec.md §22, decision D2): the Family
// part of every sync cycle. The engine runs it after the personal part, in the
// same 'minima-sync' lock, with the fresh get_sync_status of the cycle. It has
// its own state store and its own meta (`space:<id>:meta:sync`), and a Family
// error never changes the personal status (or the other way round).
//
// One run:
//   1. no live active entry and no server space: nothing to do (state none,
//      or removed / space-gone for a read-only copy);
//   2. get_my_space, every cycle; null with an active entry: a one-row pull
//      probe tells "removed" from "space gone" (the entry is marked, the copy
//      becomes read-only);
//   3. pending: pending-approval, nothing else;
//   4. active: join completion (adopt the newest bundle from my_keys) or adopt
//      every missing version; sync the role; another live space is removed;
//   5. paused: nothing is pulled or pushed;
//   6. owner: the wrap set (decision D3), rotation when due (rotation-pending
//      on failure: pushes wait), announce new join requests once;
//   7. pull from pullCursor with the keys of each row's key version (one
//      refresh per cycle for an unknown version; rows still missing a key are
//      skipped and the cursor stops before the first of them); records other
//      members created are counted into one `new-entries` event, never when
//      the pull started at cursor 0;
//   8. push the changes (the full snapshot after a rotation) at the current
//      version; key_outdated: refresh, adopt, re-encrypt the batch, retry once;
//   9. compact tombstones, lastSyncAt, synced.
// run() never rejects. Never logs records, keys or ciphertext.

import { SYNC_PULL_LIMIT, TOMBSTONE_RETENTION_MS, planPushBatches } from './engine'
import type { MySpace, SpaceRecordRow } from '@/lib/cloud/spacesApi'
import type {
  CloudErrorCode,
  EncryptedSyncRecord,
  SyncKeys,
} from '@/lib/cloud/types'
import type { AppliedIncomingRecord, ApplyIncomingOptions } from '@/lib/localDb'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import type { SyncRecord } from '@/lib/syncRecords'
import type {
  FamilyCryptoPort,
  FamilyCycleResult,
  FamilyProgress,
  FamilyRunContext,
  FamilyStream,
  FamilyStreamDeps,
  FamilyStreamEvent,
  FamilySyncMeta,
  FamilySyncState,
  FamilySyncStatus,
  SyncClock,
} from './types'
import { CloudError } from '@/lib/cloud/rpc'
import {
  decryptSpaceRecord,
  deriveSpaceSyncKeys,
  encryptSpaceRecord,
} from '@/lib/cloud/recordCrypto'
import { base64ToBytes } from '@/lib/crypto'
import { defaultDisplayName, memberColor } from '@/lib/spaces/member'
import {
  generateSpaceKey,
  unwrapSpaceKeyBundle,
  wrapSpaceKeyBundleForPublicKey,
} from '@/lib/spaces/spaceCrypto'
import { isReadOnlyShareStatus } from '@/lib/spaces/types'

export const INITIAL_FAMILY_STATE: FamilySyncState = {
  status: 'none',
  spaceId: null,
  role: null,
  name: null,
  readOnly: false,
  space: null,
  lastSyncAt: null,
  progress: null,
  errorCode: null,
  lastError: null,
  pendingOwnerEmail: null,
}

const ENCRYPT_YIELD_EVERY = 200
const DEFAULT_FAMILY_NAME = 'Family'

export function familyStatusForCloudError(code: CloudErrorCode): {
  status: FamilySyncStatus
  retry: boolean
} {
  switch (code) {
    case 'space_paused':
      return { status: 'paused', retry: false }
    case 'space_gone':
      return { status: 'space-gone', retry: false }
    case 'not_space_member':
      return { status: 'removed', retry: false }
    case 'network':
    case 'unknown':
      return { status: 'error', retry: true }
    default:
      return { status: 'error', retry: false }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Recognised by name + code, so an error from another module registry counts.
function cloudCodeOf(err: unknown): CloudErrorCode | null {
  if (err instanceof CloudError) return err.code
  if (
    err instanceof Error &&
    err.name === 'CloudError' &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as Error & { code: CloudErrorCode }).code
  }
  return null
}

function isDecryptError(err: unknown): boolean {
  return err instanceof Error && err.name === 'DecryptError'
}

function isHalt(err: unknown): boolean {
  return err instanceof Error && err.name === 'CycleHalted'
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

function defaultClock(): SyncClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    yieldToUi: () =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0)
      }),
  }
}

const defaultCrypto: FamilyCryptoPort = {
  deriveKeys: deriveSpaceSyncKeys,
  encrypt: encryptSpaceRecord,
  decrypt: decryptSpaceRecord,
}

// Every key version an entry holds.
function heldVersions(entry: SpaceKeyEntry): Set<number> {
  const versions = new Set<number>([entry.keyVersion])
  for (const p of entry.previousKeys ?? []) if (p.key) versions.add(p.keyVersion)
  return versions
}

function keyOfVersion(entry: SpaceKeyEntry, version: number): string | null {
  if (entry.keyVersion === version && entry.key) return entry.key
  return entry.previousKeys?.find((p) => p.keyVersion === version && p.key)?.key ?? null
}

function activeMemberIds(my: MySpace): Array<string> {
  return my.members.filter((m) => m.status === 'active').map((m) => m.user_id)
}

function sameProgress(a: FamilyProgress | null, b: FamilyProgress | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.phase === b.phase && a.done === b.done && a.total === b.total
}

function sameState(a: FamilySyncState, b: FamilySyncState): boolean {
  return (
    a.status === b.status &&
    a.spaceId === b.spaceId &&
    a.role === b.role &&
    a.name === b.name &&
    a.readOnly === b.readOnly &&
    a.space === b.space &&
    a.lastSyncAt === b.lastSyncAt &&
    a.errorCode === b.errorCode &&
    a.lastError === b.lastError &&
    a.pendingOwnerEmail === b.pendingOwnerEmail &&
    sameProgress(a.progress, b.progress)
  )
}

function readOnlyStateOf(entry: SpaceKeyEntry): FamilySyncState {
  return {
    ...INITIAL_FAMILY_STATE,
    status: entry.status === 'space-gone' ? 'space-gone' : 'removed',
    spaceId: entry.id,
    role: entry.role,
    name: entry.name,
    readOnly: true,
  }
}

// ── The stream ────────────────────────────────────────────────────────────────

export function createFamilyStream(deps: FamilyStreamDeps): FamilyStream {
  const { spaces, ports } = deps
  const local = ports.local
  const familyCrypto = deps.crypto ?? defaultCrypto
  const clock = deps.clock ?? defaultClock()
  const defaultName = deps.defaultName ?? (() => DEFAULT_FAMILY_NAME)

  let state: FamilySyncState = INITIAL_FAMILY_STATE
  const subscribers = new Set<() => void>()
  const eventListeners = new Set<(event: FamilyStreamEvent) => void>()

  function emit(event: FamilyStreamEvent): void {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(event)
      } catch (err) {
        console.error('Family event listener failed:', errorName(err))
      }
    }
  }

  function setState(next: FamilySyncState): void {
    if (sameState(state, next)) return
    state = next
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber()
      } catch (err) {
        console.error('Family state subscriber failed:', errorName(err))
      }
    }
    emit({ type: 'state', state })
  }

  function patchState(patch: Partial<FamilySyncState>): void {
    setState({ ...state, ...patch })
  }

  function emptyResult(status: FamilySyncStatus, ran: boolean): FamilyCycleResult {
    return {
      ran,
      status,
      pulled: 0,
      applied: 0,
      pushed: 0,
      stale: 0,
      skipped: 0,
      missingKey: 0,
      rotated: false,
      reencrypted: 0,
      retry: false,
    }
  }

  // ── One run ────────────────────────────────────────────────────────────────

  async function runInner(ctx: FamilyRunContext): Promise<FamilyCycleResult> {
    const result = emptyResult(state.status, true)
    const me = ctx.userId
    let spaceId: string | null = null
    let meta: FamilySyncMeta = { localRev: 0 }
    const before = state.status

    // Unwraps and adopts every version in my_keys the entry does not hold.
    // A version that does not open is skipped (its rows count as missingKey).
    const adoptMissing = async (my: MySpace, entry: SpaceKeyEntry): Promise<SpaceKeyEntry> => {
      const held = heldVersions(entry)
      const missing = my.my_keys
        .filter((k) => !held.has(k.key_version))
        .sort((a, b) => a.key_version - b.key_version)
      if (missing.length === 0) return entry
      const pair = await local.ensureIdentityKeyPair()
      let current = entry
      for (const wrap of missing) {
        let bundle
        try {
          bundle = await unwrapSpaceKeyBundle(wrap.wrapped_key, pair.privateKeyJwk)
        } catch (err) {
          console.error('Could not open a Family key:', errorName(err))
          continue
        }
        try {
          current = await local.adoptSpaceKey({
            spaceId: my.space_id,
            keyVersion: bundle.keyVersion,
            sk: bundle.sk,
            indexKey: bundle.indexKey,
            name: current.name,
            role: current.role,
          })
        } finally {
          bundle.sk.fill(0)
          bundle.indexKey.fill(0)
        }
      }
      return current
    }

    const refreshMy = async (): Promise<MySpace | null> => {
      ctx.checkpoint()
      const fresh = await spaces.getMySpace()
      patchState({ space: fresh })
      return fresh
    }

    // Applies records; a batch rejected as invalid is retried one by one and
    // the rejected records are skipped. A DecryptError (local data) propagates.
    const apply = async (
      records: Array<SyncRecord>,
      options: ApplyIncomingOptions,
    ): Promise<number> => {
      if (spaceId === null) return 0
      const id = spaceId
      try {
        return (await local.applyIncomingRecords(id, records, options)).applied
      } catch (err) {
        if (isDecryptError(err)) throw err
        if (!local.isUnlocked()) throw err
        if (records.length === 1) {
          result.skipped++
          return 0
        }
        let applied = 0
        for (const record of records) {
          try {
            applied += (await local.applyIncomingRecords(id, [record], options)).applied
          } catch (inner) {
            if (isDecryptError(inner)) throw inner
            result.skipped++
          }
        }
        return applied
      }
    }

    try {
      // 1. No work.
      const entries = await local.listSpaceKeyEntries()
      const active = entries.filter((e) => e.status === 'active')
      const serverSpace = ctx.status.space ?? null
      if (active.length === 0 && !serverSpace) {
        const readOnly = entries.find((e) => isReadOnlyShareStatus(e.status))
        const next = readOnly ? readOnlyStateOf(readOnly) : INITIAL_FAMILY_STATE
        setState(next)
        return { ...emptyResult(next.status, false) }
      }

      spaceId = serverSpace?.space_id ?? active.at(0)?.id ?? null
      patchState({ status: 'syncing', progress: null, errorCode: null, spaceId })

      // 2. The membership, fresh every cycle.
      ctx.checkpoint()
      let my = await spaces.getMySpace()
      patchState({ space: my })

      if (!my) {
        if (active.length === 0) {
          setState(INITIAL_FAMILY_STATE)
          return { ...result, status: 'none' }
        }
        // Removed or space gone: a one-row probe tells them apart.
        let last: FamilySyncState = INITIAL_FAMILY_STATE
        for (const entry of active) {
          spaceId = entry.id
          ctx.checkpoint()
          let code: CloudErrorCode | null = null
          try {
            await spaces.pullSpaceRecords(entry.id, ctx.deviceId, 0, 1)
          } catch (err) {
            code = cloudCodeOf(err)
            if (code !== 'space_gone' && code !== 'not_space_member') throw err
          }
          // Readable without a membership: not a state the server allows.
          if (code === null) {
            throw new CloudError('unknown', 'No membership but the space is readable')
          }
          const status = code === 'space_gone' ? 'space-gone' : 'removed'
          const marked = await local.updateSpaceEntry(entry.id, { status })
          last = readOnlyStateOf(marked ?? { ...entry, status })
        }
        ports.pending.clearJoin()
        setState(last)
        return { ...result, status: last.status }
      }

      spaceId = my.space_id

      // 3. Pending approval.
      if (my.status === 'pending') {
        const join = ports.pending.readJoin()
        setState({
          ...INITIAL_FAMILY_STATE,
          status: 'pending-approval',
          spaceId: my.space_id,
          role: my.role,
          space: my,
          pendingOwnerEmail: join && join.spaceId === my.space_id ? join.ownerEmail : null,
        })
        return { ...result, status: 'pending-approval' }
      }

      // 4. Active: another live space of this user is no longer theirs.
      for (const other of active) {
        if (other.id !== my.space_id) {
          await local.updateSpaceEntry(other.id, { status: 'removed' })
        }
      }

      let entry = entries.find((e) => e.id === spaceId) ?? null
      let joined = false
      if (!entry) {
        // Join completion: the newest bundle from my_keys.
        const newest = [...my.my_keys].sort((a, b) => b.key_version - a.key_version).at(0)
        if (!newest) {
          throw new CloudError('unknown', 'No key was shared with this member')
        }
        const pair = await local.ensureIdentityKeyPair()
        const bundle = await unwrapSpaceKeyBundle(newest.wrapped_key, pair.privateKeyJwk)
        try {
          entry = await local.adoptSpaceKey({
            spaceId,
            keyVersion: bundle.keyVersion,
            sk: bundle.sk,
            indexKey: bundle.indexKey,
            name: defaultName(),
            role: my.role,
          })
        } finally {
          bundle.sk.fill(0)
          bundle.indexKey.fill(0)
        }
        entry = await adoptMissing(my, entry)
        const profiles = await local.getMemberProfiles(spaceId)
        if (!profiles.some((p) => p.id === me)) {
          const email = my.members.find((m) => m.user_id === me)?.email ?? null
          await local.upsertMemberProfile(spaceId, {
            id: me,
            displayName: defaultDisplayName(email),
            color: memberColor(me),
          })
        }
        joined = true
        ports.pending.clearJoin()
      } else {
        if (entry.status !== 'active') {
          entry = (await local.updateSpaceEntry(spaceId, { status: 'active' })) ?? entry
        }
        entry = await adoptMissing(my, entry)
        if (entry.role !== my.role) {
          entry = (await local.updateSpaceEntry(spaceId, { role: my.role })) ?? entry
        }
      }

      meta = await ports.meta.read(spaceId)
      patchState({
        spaceId,
        role: my.role,
        name: entry.name,
        readOnly: false,
        lastSyncAt: meta.lastSyncAt ?? null,
        lastError: meta.lastError ?? null,
        pendingOwnerEmail: null,
      })

      // 5. Paused: local edits keep their revs and wait.
      if (my.paused) {
        setState({ ...state, status: 'paused', progress: null })
        return { ...result, status: 'paused' }
      }

      const serverVersion = (m: MySpace): number => m.key_version ?? entry?.keyVersion ?? 1
      if (
        meta.rotationPendingFrom !== undefined &&
        serverVersion(my) > meta.rotationPendingFrom
      ) {
        meta = await ports.meta.update(spaceId, { rotationPendingFrom: undefined })
      }

      // 6. Owner duties.
      let rotationPending = false
      if (my.role === 'owner') {
        const ensureWrapSet = async (m: MySpace): Promise<void> => {
          if (!entry) return
          const version = serverVersion(m)
          if (!entry.wrappedFor || entry.wrappedFor.keyVersion !== version) {
            entry =
              (await local.updateSpaceEntry(m.space_id, {
                wrappedFor: { keyVersion: version, userIds: activeMemberIds(m) },
              })) ?? entry
          }
        }
        const rotationDue = (m: MySpace): boolean => {
          if (!entry) return false
          const version = serverVersion(m)
          if (meta.rotationPendingFrom !== undefined && meta.rotationPendingFrom >= version) {
            return true
          }
          const activeIds = new Set(activeMemberIds(m))
          return (entry.wrappedFor?.userIds ?? []).some((id) => !activeIds.has(id))
        }

        await ensureWrapSet(my)
        let retried = false
        while (rotationDue(my)) {
          const current: SpaceKeyEntry = entry
          if (!current.indexKey) throw new Error('The space has no index key')
          const version = serverVersion(my) + 1
          const members = my.members.filter((m) => m.status === 'active')
          // Handed to the wraps and to adoptSpaceKey (which keeps base64
          // copies); not reused after this attempt.
          const sk = generateSpaceKey()
          const indexKey = base64ToBytes(current.indexKey)
          {
            const wraps = []
            for (const m of members) {
              wraps.push({
                user_id: m.user_id,
                wrapped_key: await wrapSpaceKeyBundleForPublicKey(
                  { v: 1, keyVersion: version, sk, indexKey },
                  m.public_key,
                ),
              })
            }
            ctx.checkpoint()
            try {
              await spaces.rotateSpaceKey(spaceId, version, wraps)
            } catch (err) {
              const code = cloudCodeOf(err)
              if (code === null) throw err
              if (!retried && (code === 'members_mismatch' || code === 'wrong_key_version')) {
                retried = true
                const fresh = await refreshMy()
                if (!fresh || fresh.space_id !== spaceId || fresh.status !== 'active') throw err
                my = fresh
                entry = await adoptMissing(my, entry)
                if (
                  meta.rotationPendingFrom !== undefined &&
                  serverVersion(my) > meta.rotationPendingFrom
                ) {
                  meta = await ports.meta.update(spaceId, { rotationPendingFrom: undefined })
                }
                await ensureWrapSet(my)
                continue
              }
              // Offline or refused: retried every cycle; pushes wait.
              meta = await ports.meta.update(spaceId, {
                rotationPendingFrom: serverVersion(my),
              })
              rotationPending = true
              result.retry = familyStatusForCloudError(code).retry
              break
            }
            entry = await local.adoptSpaceKey({
              spaceId,
              keyVersion: version,
              sk,
              indexKey,
              name: current.name,
              role: current.role,
            })
            const activeIds = members.map((m) => m.user_id)
            entry =
              (await local.updateSpaceEntry(spaceId, {
                wrappedFor: { keyVersion: version, userIds: activeIds },
              })) ?? entry
            meta = await ports.meta.update(spaceId, {
              rotationPendingFrom: undefined,
              reencryptPending: true,
            })
            my = { ...my, key_version: version }
            result.rotated = true
            break
          }
        }

        // Join requests, announced once per device.
        const notified = new Set(meta.notifiedRequests ?? [])
        const fresh = my.members.filter((m) => m.status === 'pending' && !notified.has(m.user_id))
        if (fresh.length > 0) {
          for (const m of fresh) {
            emit({ type: 'join-request', spaceId, userId: m.user_id, email: m.email })
            notified.add(m.user_id)
          }
          meta = await ports.meta.update(spaceId, { notifiedRequests: Array.from(notified) })
        }
      }
      patchState({
        status: rotationPending ? 'rotation-pending' : 'syncing',
        space: my,
        role: my.role,
      })

      // Keys per version: the index key once, a data key per held version.
      const keyCache = new Map<number, SyncKeys>()
      const keysFor = async (version: number): Promise<SyncKeys | null> => {
        const cached = keyCache.get(version)
        if (cached) return cached
        if (!entry?.indexKey) return null
        const sk = keyOfVersion(entry, version)
        if (!sk) return null
        // Fresh copies per call; the crypto port imports them as
        // non-extractable key material.
        const keys = await familyCrypto.deriveKeys(base64ToBytes(entry.indexKey), base64ToBytes(sk))
        keyCache.set(version, keys)
        return keys
      }
      let refreshedForKey = false
      const refreshForKey = async (): Promise<void> => {
        if (refreshedForKey || !entry) return
        refreshedForKey = true
        const fresh = await refreshMy()
        if (fresh && fresh.space_id === spaceId && fresh.status === 'active') {
          my = fresh
          entry = await adoptMissing(fresh, entry)
        }
      }

      // 7. Pull.
      let cursor = meta.pullCursor ?? 0
      let savedCursor = cursor
      let missingSeen = false
      const pullStart = cursor
      const pullTotal =
        typeof my.last_seq === 'number' ? Math.max(0, my.last_seq - pullStart) : null
      const recurringIds = new Set<string>()
      // Records new to this device and written by another member (D3).
      let newEntries = 0
      const onApplied = (records: Array<AppliedIncomingRecord>): void => {
        for (const r of records) {
          if (
            r.created &&
            !r.deleted &&
            (r.type === 'expense' || r.type === 'income') &&
            typeof r.createdBy === 'string' &&
            r.createdBy !== me
          ) {
            newEntries++
          }
        }
      }
      for (;;) {
        ctx.checkpoint()
        const page = await spaces.pullSpaceRecords(spaceId, ctx.deviceId, cursor, SYNC_PULL_LIMIT)
        result.pulled += page.records.length
        const decrypted: Array<SyncRecord> = []
        for (const row of page.records) {
          let keys = await keysFor(row.key_version)
          if (!keys) {
            await refreshForKey()
            keys = await keysFor(row.key_version)
          }
          if (!keys) {
            result.missingKey++
            missingSeen = true
            continue
          }
          try {
            decrypted.push(await familyCrypto.decrypt(keys, row))
          } catch {
            result.skipped++
          }
          if (!missingSeen) savedCursor = row.seq
        }
        if (decrypted.length > 0) result.applied += await apply(decrypted, { onApplied })
        for (const record of decrypted) {
          const recurringId = record.data.recurringId
          if (
            (record.type === 'expense' || record.type === 'income') &&
            typeof recurringId === 'string' &&
            recurringId !== ''
          ) {
            recurringIds.add(recurringId)
          }
        }
        const last = page.records.at(-1)
        if (last) cursor = last.seq
        if (savedCursor !== (meta.pullCursor ?? 0)) {
          meta = await ports.meta.update(spaceId, { pullCursor: savedCursor })
        }
        patchState({ progress: { phase: 'pull', done: result.pulled, total: pullTotal } })
        await clock.yieldToUi()
        if (!page.has_more || page.records.length === 0) break
      }
      if (pullStart > 0 && newEntries > 0) {
        emit({ type: 'new-entries', spaceId, count: newEntries })
      }
      if (recurringIds.size > 0) {
        ctx.checkpoint()
        await local.dedupeOccurrences(spaceId, [...recurringIds])
      }

      // The space name follows spaceInfo.
      const info = await local.getSpaceInfo(spaceId)
      if (info && info.name !== entry.name) {
        entry = (await local.updateSpaceEntry(spaceId, { name: info.name })) ?? entry
      }
      patchState({ name: entry.name })

      // 8. Push, unless a rotation is still due.
      let maxRev: number | null = null
      if (!rotationPending) {
        const reencrypt = meta.reencryptPending === true
        const since = reencrypt ? -1 : (meta.pushedRev ?? 0)
        ctx.checkpoint()
        const snapshot = await local.listChangedRecords(spaceId, since)
        maxRev = snapshot.maxRev
        const held = heldVersions(entry)
        let version =
          !reencrypt && meta.keyVersion !== undefined && held.has(meta.keyVersion)
            ? meta.keyVersion
            : entry.keyVersion
        let keys = await keysFor(version)
        if (!keys) throw new Error('The current Family key is missing')

        const recordOf = new Map<EncryptedSyncRecord, SyncRecord>()
        const encryptedAt = new Map<EncryptedSyncRecord, number>()
        const encrypted: Array<EncryptedSyncRecord> = []
        for (const [i, record] of snapshot.records.entries()) {
          const enc = await familyCrypto.encrypt(keys, record, version)
          recordOf.set(enc, record)
          encryptedAt.set(enc, version)
          encrypted.push(enc)
          if ((i + 1) % ENCRYPT_YIELD_EVERY === 0) {
            await clock.yieldToUi()
            ctx.checkpoint()
          }
        }
        const encryptBatch = async (
          batch: Array<EncryptedSyncRecord>,
          atVersion: number,
          withKeys: SyncKeys,
        ): Promise<Array<EncryptedSyncRecord>> => {
          const out: Array<EncryptedSyncRecord> = []
          for (const enc of batch) {
            if (encryptedAt.get(enc) === atVersion) {
              out.push(enc)
              continue
            }
            const record = recordOf.get(enc)
            if (!record) continue
            out.push(await familyCrypto.encrypt(withKeys, record, atVersion))
          }
          return out
        }

        const total = snapshot.records.length
        const phase: FamilyProgress['phase'] = reencrypt ? 'reencrypt' : 'push'
        let done = 0
        for (const planned of planPushBatches(encrypted)) {
          ctx.checkpoint()
          let batch = await encryptBatch(planned, version, keys)
          let response
          try {
            response = await spaces.pushSpaceRecords(spaceId, ctx.deviceId, version, batch)
          } catch (err) {
            if (cloudCodeOf(err) !== 'key_outdated') throw err
            const fresh = await refreshMy()
            if (fresh && fresh.space_id === spaceId && fresh.status === 'active') {
              my = fresh
              entry = await adoptMissing(fresh, entry)
            }
            const newest = entry.keyVersion
            const newestKeys = await keysFor(newest)
            if (newest === version || !newestKeys) throw err
            version = newest
            keys = newestKeys
            batch = await encryptBatch(planned, version, keys)
            ctx.checkpoint()
            response = await spaces.pushSpaceRecords(spaceId, ctx.deviceId, version, batch)
          }
          result.pushed += batch.length
          if (reencrypt) result.reencrypted += batch.length
          const stale: Array<SyncRecord> = []
          for (const item of response.results) {
            if (item.status !== 'stale') continue
            result.stale++
            const current: SpaceRecordRow = item.current
            let staleKeys = await keysFor(current.key_version)
            if (!staleKeys) {
              await refreshForKey()
              staleKeys = await keysFor(current.key_version)
            }
            if (!staleKeys) {
              result.missingKey++
              continue
            }
            try {
              stale.push(await familyCrypto.decrypt(staleKeys, current))
            } catch {
              result.skipped++
            }
          }
          if (stale.length > 0) {
            result.applied += await apply(stale, { preferIncomingOnTie: true })
          }
          done += batch.length
          patchState({ progress: { phase, done, total } })
          await clock.yieldToUi()
        }
        const patch: Partial<FamilySyncMeta> = {}
        if (snapshot.maxRev !== meta.pushedRev) patch.pushedRev = snapshot.maxRev
        if (reencrypt) patch.reencryptPending = undefined
        if ((total > 0 || reencrypt) && meta.keyVersion !== version) patch.keyVersion = version
        if (Object.keys(patch).length > 0) meta = await ports.meta.update(spaceId, patch)
      }

      // 9. Afterwards.
      if (maxRev !== null) {
        await local.compactTombstones(
          spaceId,
          new Date(clock.now() - TOMBSTONE_RETENTION_MS).toISOString(),
          { maxRev },
        )
      }
      const at = new Date(clock.now()).toISOString()
      const lastError =
        result.missingKey > 0
          ? { code: 'missing-key', count: result.missingKey, at }
          : result.skipped > 0
            ? { code: 'undecryptable', count: result.skipped, at }
            : null
      const finalStatus: FamilySyncStatus = rotationPending ? 'rotation-pending' : 'synced'
      meta = await ports.meta.update(spaceId, { lastSyncAt: at, lastError, state: finalStatus })
      setState({
        ...state,
        status: finalStatus,
        spaceId,
        role: my.role,
        name: entry.name,
        readOnly: false,
        space: my,
        progress: null,
        errorCode: null,
        lastSyncAt: meta.lastSyncAt ?? at,
        lastError: meta.lastError ?? null,
        pendingOwnerEmail: null,
      })
      if (joined) emit({ type: 'joined', spaceId, name: info?.name ?? entry.name })
      return { ...result, status: finalStatus }
    } catch (err) {
      if (isHalt(err)) {
        const baseline: FamilySyncStatus =
          before !== 'syncing' ? before : meta.lastSyncAt ? 'synced' : 'none'
        setState({ ...state, status: baseline, progress: null })
        return { ...result, status: baseline }
      }
      const code = cloudCodeOf(err)
      if (code !== null) {
        const { status, retry } = familyStatusForCloudError(code)
        if ((status === 'removed' || status === 'space-gone') && spaceId !== null) {
          try {
            await local.updateSpaceEntry(spaceId, { status })
          } catch (markErr) {
            console.error('Could not mark the Family copy:', errorName(markErr))
          }
          ports.pending.clearJoin()
          setState({ ...state, status, readOnly: true, progress: null, errorCode: null })
        } else if (status === 'error') {
          let lastError = state.lastError
          if (spaceId !== null) {
            try {
              const at = new Date(clock.now()).toISOString()
              meta = await ports.meta.update(spaceId, { lastError: { code, at } })
              lastError = meta.lastError ?? null
            } catch (metaErr) {
              console.error('Could not save the Family error:', errorName(metaErr))
            }
          }
          setState({ ...state, status: 'error', progress: null, errorCode: code, lastError })
        } else {
          setState({ ...state, status, progress: null, errorCode: null })
        }
        return { ...result, status, retry }
      }
      if (isDecryptError(err)) {
        emit({ type: 'data-problem', error: err })
        setState({ ...state, status: 'error', progress: null, errorCode: 'decrypt' })
        return { ...result, status: 'error' }
      }
      console.error('Family sync failed:', errorName(err))
      setState({ ...state, status: 'error', progress: null, errorCode: 'unexpected' })
      return { ...result, status: 'error' }
    }
  }

  async function run(ctx: FamilyRunContext): Promise<FamilyCycleResult> {
    try {
      return await runInner(ctx)
    } catch (err) {
      console.error('Family sync failed:', errorName(err))
      setState({ ...state, status: 'error', progress: null, errorCode: 'unexpected' })
      return emptyResult('error', true)
    }
  }

  async function refreshFromLocal(): Promise<FamilySyncState> {
    try {
      if (!local.isUnlocked()) return state
      const entries = await local.listSpaceKeyEntries()
      const active = entries.find((e) => e.status === 'active')
      if (active) {
        const meta = await ports.meta.read(active.id)
        const keep =
          state.spaceId === active.id &&
          !state.readOnly &&
          state.status !== 'none' &&
          state.status !== 'pending-approval'
        const stored = meta.state
        const status: FamilySyncStatus = keep
          ? state.status
          : stored === 'synced' ||
              stored === 'paused' ||
              stored === 'rotation-pending' ||
              stored === 'error'
            ? stored
            : meta.lastSyncAt
              ? 'synced'
              : 'syncing'
        setState({
          ...state,
          status,
          spaceId: active.id,
          role: active.role,
          name: active.name,
          readOnly: false,
          space: state.spaceId === active.id ? state.space : null,
          lastSyncAt: meta.lastSyncAt ?? null,
          lastError: meta.lastError ?? null,
          progress: keep ? state.progress : null,
          pendingOwnerEmail: null,
        })
        return state
      }
      const readOnly = entries.find((e) => isReadOnlyShareStatus(e.status))
      if (readOnly) {
        setState(readOnlyStateOf(readOnly))
        return state
      }
      if (state.status !== 'pending-approval') setState(INITIAL_FAMILY_STATE)
      return state
    } catch (err) {
      console.error('Could not read the Family state:', errorName(err))
      return state
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    onLocalChange(listener) {
      return local.onSpaceLocalChange(() => {
        listener()
      })
    },
    run,
    markOffline() {
      const s = state.status
      if (s === 'synced' || s === 'syncing' || s === 'error' || s === 'rotation-pending') {
        setState({ ...state, status: 'offline', progress: null, errorCode: null })
      }
    },
    refreshFromLocal,
    setSpace(space) {
      if (space === null) {
        if (!state.readOnly) setState({ ...INITIAL_FAMILY_STATE })
        void refreshFromLocal()
        return
      }
      if (space.status === 'pending') {
        const join = ports.pending.readJoin()
        setState({
          ...INITIAL_FAMILY_STATE,
          status: 'pending-approval',
          spaceId: space.space_id,
          role: space.role,
          space,
          pendingOwnerEmail: join && join.spaceId === space.space_id ? join.ownerEmail : null,
        })
        return
      }
      setState({
        ...state,
        space,
        spaceId: space.space_id,
        role: space.role,
        status: state.status === 'pending-approval' ? 'syncing' : state.status,
        pendingOwnerEmail: null,
      })
    },
  }
}
