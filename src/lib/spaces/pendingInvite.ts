// The invite and the join request a user is in the middle of (spec §22). The
// only module that touches sessionStorage.
//
// - `minima_pending_invite` (sessionStorage, 1 h): `{ fragment, expiresAt }`,
//   where fragment is `<inviteId>.<base64url secret>`, exactly the part of
//   the invite link after the `#`. It survives the vault, sign-in and sync
//   steps of /join in the same tab and dies with the tab.
// - `minima_pending_join` (localStorage): `{ spaceId, ownerEmail,
//   requestedAt }`, never a secret. It lets the Family tab say whom the
//   request waits for.
//
// Every function is a no-op without `window`; storage errors are swallowed.

import { buildInviteUrl, parseInviteFragment } from './invite'

export const PENDING_INVITE_KEY = 'minima_pending_invite'
export const PENDING_INVITE_TTL_MS = 3_600_000
export const PENDING_JOIN_KEY = 'minima_pending_join'

export interface PendingInvite {
  inviteId: string
  secret: Uint8Array<ArrayBuffer>
}

export interface PendingJoin {
  spaceId: string
  ownerEmail: string | null
  requestedAt: string
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function removeFrom(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // ignore
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function savePendingInvite(invite: PendingInvite, now: number = Date.now()): void {
  const storage = session()
  if (!storage) return
  try {
    const url = buildInviteUrl('', invite.inviteId, invite.secret)
    const fragment = url.slice(url.indexOf('#') + 1)
    storage.setItem(
      PENDING_INVITE_KEY,
      JSON.stringify({ fragment, expiresAt: now + PENDING_INVITE_TTL_MS }),
    )
  } catch {
    // ignore
  }
}

export function readPendingInvite(now: number = Date.now()): PendingInvite | null {
  const storage = session()
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(PENDING_INVITE_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (
    isRecord(parsed) &&
    typeof parsed.fragment === 'string' &&
    typeof parsed.expiresAt === 'number' &&
    Number.isFinite(parsed.expiresAt) &&
    now <= parsed.expiresAt
  ) {
    const invite = parseInviteFragment(parsed.fragment)
    if (invite) return invite
  }
  removeFrom(storage, PENDING_INVITE_KEY)
  return null
}

export function clearPendingInvite(): void {
  removeFrom(session(), PENDING_INVITE_KEY)
}

export function savePendingJoin(join: PendingJoin): void {
  const storage = local()
  if (!storage) return
  try {
    storage.setItem(
      PENDING_JOIN_KEY,
      JSON.stringify({
        spaceId: join.spaceId,
        ownerEmail: join.ownerEmail,
        requestedAt: join.requestedAt,
      }),
    )
  } catch {
    // ignore
  }
}

export function readPendingJoin(): PendingJoin | null {
  const storage = local()
  if (!storage) return null
  try {
    const raw = storage.getItem(PENDING_JOIN_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      isRecord(parsed) &&
      typeof parsed.spaceId === 'string' &&
      (parsed.ownerEmail === null || typeof parsed.ownerEmail === 'string') &&
      typeof parsed.requestedAt === 'string'
    ) {
      return {
        spaceId: parsed.spaceId,
        ownerEmail: parsed.ownerEmail,
        requestedAt: parsed.requestedAt,
      }
    }
    return null
  } catch {
    return null
  }
}

export function clearPendingJoin(): void {
  removeFrom(local(), PENDING_JOIN_KEY)
}
