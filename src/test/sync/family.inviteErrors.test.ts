// CONTRACT_GAP: expiring an invite is done directly in the database
//   (space_invites.expires_at), because familyActions has no expiry option.
// CONTRACT_GAP: the exact text for each error is only compared with the
//   catalog entry of the key named in plan section 8.
//
// Invite errors (criterion 15): used, expired, revoked and wrong-secret links
// all fail with the same invite_invalid code, and familyErrorMessage turns the
// codes into plain text in both languages.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import { setLang, translate } from '@/i18n/core'
import { familyErrorMessage } from '@/i18n/errors'
import { createInviteSecret } from '@/lib/spaces/invite'
import {
  act,
  createFamilyOn,
  familyActionsOf,
  firstDevice,
  joinFamily,
  newUser,
} from '@/test/sync/familySim'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: () => {
    const id = (globalThis as Record<string, unknown>).__minimaActingUser
    return Promise.resolve(typeof id === 'string' ? { userId: id, email: null } : null)
  },
}))
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 })

let ctx: SqlTestDb
let o1: SimDevice
let b1: SimDevice
let d1: SimDevice
let x1: SimDevice
let spaceId: string

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  )
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  const [userO, userB, userD, userX] = [await newUser(ctx), await newUser(ctx), await newUser(ctx), await newUser(ctx)]
  o1 = await firstDevice(userO, 'O1')
  b1 = await firstDevice(userB, 'B1')
  d1 = await firstDevice(userD, 'D1')
  x1 = await firstDevice(userX, 'X1')
  spaceId = await createFamilyOn(o1, 'Errors')
}, 240_000)

afterAll(async () => {
  for (const d of [o1, b1, d1, x1]) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('every dead link looks the same', () => {
  it('a used link (already joined with it) is invite_invalid', async () => {
    const requested = await joinFamily(o1, b1)

    const err = await failureOf(act(d1, () => familyActionsOf(d1).previewInvite(requested.invite)))

    expect(codeOf(err)).toBe('invite_invalid')
  })

  it('an expired link is invite_invalid', async () => {
    const requested = await requestJoinOnFresh()
    await ctx.admin("update public.space_invites set expires_at = now() - interval '1 hour' where space_id = $1", [spaceId])

    const err = await failureOf(act(d1, () => familyActionsOf(d1).previewInvite(requested)))

    expect(codeOf(err)).toBe('invite_invalid')
  })

  it('a revoked link is invite_invalid', async () => {
    const created = await act(o1, () => familyActionsOf(o1).createInvite())
    await act(o1, () => familyActionsOf(o1).revokeInvite(created.inviteId))
    const parsed = parse(created.url)

    const err = await failureOf(act(d1, () => familyActionsOf(d1).previewInvite(parsed)))

    expect(codeOf(err)).toBe('invite_invalid')
  })

  it('a wrong secret is invite_invalid', async () => {
    const created = await act(o1, () => familyActionsOf(o1).createInvite())
    const parsed = parse(created.url)

    const err = await failureOf(act(d1, () => familyActionsOf(d1).previewInvite({ inviteId: parsed.inviteId, secret: createInviteSecret() })))

    expect(codeOf(err)).toBe('invite_invalid')
  })

  it('a good link previews the owner email and the member count', async () => {
    const created = await act(o1, () => familyActionsOf(o1).createInvite())

    const info = await act(d1, () => familyActionsOf(d1).previewInvite(parse(created.url)))

    expect(info.space_id).toBe(spaceId)
    expect(info.members_count).toBe(2)
    expect(typeof info.owner_email).toBe('string')
  })
})

describe('a user who is already in a Family', () => {
  it('cannot ask to join another one (already_in_space)', async () => {
    const own = await createFamilyOn(x1, 'X family')
    const invite = await requestJoinOnFresh()

    const err = await failureOf(act(x1, () => familyActionsOf(x1).requestJoin(invite, null)))

    expect(own).not.toBe(spaceId)
    expect(codeOf(err)).toBe('already_in_space')
  })
})

describe('familyErrorMessage', () => {
  const cases: Array<[string, string]> = [
    ['invite_invalid', 'family.errors.inviteInvalid'],
    ['already_in_space', 'family.errors.alreadyInSpace'],
    ['member_limit', 'family.errors.memberLimit'],
    ['space_paused', 'family.errors.paused'],
    ['network', 'family.errors.offline'],
    ['not_space_owner', 'family.errors.notOwner'],
    ['owner_must_transfer_or_delete', 'family.errors.ownerMustTransfer'],
  ]

  function cloudError(code: string): Error {
    return Object.assign(new Error(code), { name: 'CloudError', code })
  }

  it.each(cases)('%s maps to %s in English and Ukrainian', (code, key) => {
    setLang('en', { persist: false })
    const en = familyErrorMessage(cloudError(code))
    setLang('uk', { persist: false })
    const uk = familyErrorMessage(cloudError(code))
    setLang('en', { persist: false })

    expect(en).toBe(translate('en', key as never))
    expect(uk).toBe(translate('uk', key as never))
    expect(uk).not.toBe(en)
  })

  it('an unknown error falls back to the generic text with its code', () => {
    setLang('en', { persist: false })

    const text = familyErrorMessage(cloudError('something_new'))

    expect(text).toBe(translate('en', 'family.errors.generic' as never, { code: 'something_new' }))
    expect(text).toContain('something_new')
  })

  it('FamilyActionError and SpaceReadOnlyError have their own texts', () => {
    setLang('en', { persist: false })
    const action = Object.assign(new Error('x'), { name: 'FamilyActionError', code: 'name_mismatch' })
    const readOnly = Object.assign(new Error('x'), { name: 'SpaceReadOnlyError', code: 'space-read-only', spaceId: 's' })

    expect(familyErrorMessage(action)).toBe(translate('en', 'family.errors.nameMismatch' as never))
    expect(familyErrorMessage(readOnly)).toBe(translate('en', 'family.errors.readOnly' as never))
  })
})

async function requestJoinOnFresh() {
  const created = await act(o1, () => familyActionsOf(o1).createInvite())
  return parse(created.url)
}

function parse(url: string) {
  const fragment = new URL(url).hash.slice(1)
  const [inviteId, secret] = fragment.split('.')
  return { inviteId, secret: new Uint8Array(Buffer.from(secret, 'base64url')) }
}
