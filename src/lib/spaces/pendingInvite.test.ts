// No CONTRACT_GAPs: storage keys, TTL and the stored shape are specified in
// plan section 2 and the Interface Contract (pendingInvite.ts). The fragment
// round-trip uses parseInviteFragment from invite.ts to read the stored value.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  PENDING_INVITE_KEY,
  PENDING_INVITE_TTL_MS,
  PENDING_JOIN_KEY,
  clearPendingInvite,
  clearPendingJoin,
  readPendingInvite,
  readPendingJoin,
  savePendingInvite,
  savePendingJoin,
} from '@/lib/spaces/pendingInvite'
import { parseInviteFragment } from '@/lib/spaces/invite'

const NOW = 1_800_000_000_000
const ID = '5f0f6c1e-0000-4000-8000-00000000abcd'

function secret(seed: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) % 256)
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('constants', () => {
  it('names the keys and the 1 hour TTL', () => {
    expect(PENDING_INVITE_KEY).toBe('minima_pending_invite')
    expect(PENDING_JOIN_KEY).toBe('minima_pending_join')
    expect(PENDING_INVITE_TTL_MS).toBe(3_600_000)
  })
})

describe('pending invite (sessionStorage)', () => {
  it('stores { fragment, expiresAt } with the inviteId and a base64url secret', () => {
    savePendingInvite({ inviteId: ID, secret: secret(1) }, NOW)

    const stored = JSON.parse(sessionStorage.getItem(PENDING_INVITE_KEY) ?? 'null') as {
      fragment: string
      expiresAt: number
    }
    expect(stored.expiresAt).toBe(NOW + PENDING_INVITE_TTL_MS)
    expect(stored.fragment.startsWith(`${ID}.`)).toBe(true)
    expect(stored.fragment).toMatch(/^[\w-]+\.[A-Za-z0-9_-]+$/)
    expect(parseInviteFragment(`#${stored.fragment}`)?.inviteId).toBe(ID)
  })

  it('reads back the same invite before it expires', () => {
    const s = secret(3)
    savePendingInvite({ inviteId: ID, secret: s }, NOW)

    const back = readPendingInvite(NOW + 1000)

    expect(back?.inviteId).toBe(ID)
    expect(Array.from(back?.secret ?? [])).toEqual(Array.from(s))
  })

  it('different invites read back differently', () => {
    savePendingInvite({ inviteId: ID, secret: secret(1) }, NOW)
    const first = readPendingInvite(NOW)
    savePendingInvite({ inviteId: '5f0f6c1e-0000-4000-8000-00000000ffff', secret: secret(9) }, NOW)
    const second = readPendingInvite(NOW)

    expect(second?.inviteId).not.toBe(first?.inviteId)
    expect(Array.from(second?.secret ?? [])).not.toEqual(Array.from(first?.secret ?? []))
  })

  it('an expired entry reads as null and is removed', () => {
    savePendingInvite({ inviteId: ID, secret: secret(1) }, NOW)

    expect(readPendingInvite(NOW + PENDING_INVITE_TTL_MS + 1)).toBeNull()
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
  })

  it.each(['not json', '{"fragment":5}', '{"fragment":"nodot","expiresAt":9999999999999}', '[]'])(
    'a malformed entry %j reads as null and is removed',
    (value) => {
      sessionStorage.setItem(PENDING_INVITE_KEY, value)

      expect(readPendingInvite(NOW)).toBeNull()
      expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
    },
  )

  it('clear removes it', () => {
    savePendingInvite({ inviteId: ID, secret: secret(1) }, NOW)
    clearPendingInvite()

    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
    expect(readPendingInvite(NOW)).toBeNull()
  })

  it('never writes the secret to localStorage', () => {
    savePendingInvite({ inviteId: ID, secret: secret(1) }, NOW)

    expect(localStorage.length).toBe(0)
  })
})

describe('pending join (localStorage)', () => {
  const JOIN = { spaceId: 'space-1', ownerEmail: 'owner@example.com', requestedAt: '2026-10-30T10:00:00.000Z' }

  it('round-trips', () => {
    savePendingJoin(JOIN)

    expect(readPendingJoin()).toEqual(JOIN)
    expect(JSON.parse(localStorage.getItem(PENDING_JOIN_KEY) ?? 'null')).toEqual(JOIN)
  })

  it('keeps a null owner email', () => {
    savePendingJoin({ ...JOIN, ownerEmail: null })

    expect(readPendingJoin()?.ownerEmail).toBeNull()
  })

  it('is null when nothing is stored, malformed, or cleared', () => {
    expect(readPendingJoin()).toBeNull()
    localStorage.setItem(PENDING_JOIN_KEY, '{oops')
    expect(readPendingJoin()).toBeNull()
    savePendingJoin(JOIN)
    clearPendingJoin()
    expect(readPendingJoin()).toBeNull()
    expect(localStorage.getItem(PENDING_JOIN_KEY)).toBeNull()
  })
})
