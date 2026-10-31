// CONTRACT_GAP: that B2 gets the Family entry through PERSONAL sync alone (no
//   second approval) is asserted by counting approve_member / request_join
//   calls and server members, not by an engine event.
//
// Invite, join and approve (criteria 7, 11, 16, 18, 19): O creates a Family,
// B opens the link on B1 and asks to join, both compute the same safety code,
// O approves, B1 joins and pulls everything, B2 follows with no new approval.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { FamilyUser } from '@/test/sql/familyHarness'
import type { JoinRequested } from '@/test/sync/familySim'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import { PENDING_INVITE_KEY } from '@/lib/spaces/pendingInvite'
import { safetyCode } from '@/lib/spaces/spaceCrypto'
import {
  act,
  approveOn,
  createFamilyOn,
  cycle,
  expectNoSecret,
  familyActionsOf,
  familyExpense,
  familyExpenses,
  firstDevice,
  newUser,
  nextDevice,
  requestJoinOn,
  settle,
  spacesOf,
  userIdOf,
} from '@/test/sync/familySim'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: () => {
    const id = (globalThis as Record<string, unknown>).__minimaActingUser
    return Promise.resolve(typeof id === 'string' ? { userId: id, email: null } : null)
  },
}))
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 })

const OWNER_DESCRIPTION = 'Marker written by O'

let ctx: SqlTestDb
let userO: FamilyUser
let userB: FamilyUser
let o1: SimDevice
let b1: SimDevice
let b2: SimDevice
let spaceId: string
let requested: JoinRequested
let pendingState: string
let pendingLocalSpaces: number
let expenseId: string

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  userO = await newUser(ctx)
  userB = await newUser(ctx)
  o1 = await firstDevice(userO, 'O1')
  b1 = await firstDevice(userB, 'B1')
  spaceId = await createFamilyOn(o1, 'Our Family')
  expenseId = (await familyExpense(o1, spaceId, 4242, OWNER_DESCRIPTION)).id
  await cycle(o1)

  requested = await requestJoinOn(o1, b1)
  await cycle(b1)
  pendingState = b1.family?.getState().status ?? 'missing'
  pendingLocalSpaces = (await act(b1, () => b1.localDb.listLocalSpaces())).length
  await approveOn(o1, b1)
  await settle([o1, b1])
  b2 = await nextDevice(userB, 'B2')
  await settle([b2, o1])
}, 240_000)

afterAll(async () => {
  for (const d of [o1, b1, b2]) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('the invite link', () => {
  it('the secret appears only after the # and never in a server call', () => {
    const [beforeHash, fragment] = requested.url.split('#')

    expect(beforeHash).toBe('https://minima.test/join')
    expect(fragment.length).toBeGreaterThan(40)
    expectNoSecret([o1, b1, b2], requested.invite.secret)
  })

  it('create_invite received a hash, not the secret or the token', () => {
    const call = o1.calls.find((c) => c.fn === 'create_invite')

    expect(call?.args.p_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(call?.args)).not.toContain(requested.url.split('#')[1])
  })

  it('after use nothing about the invite is left in sessionStorage', () => {
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(Buffer.from(requested.invite.secret).toString('base64url'))
  })
})

describe('asking to join', () => {
  it('shows a safety code in the XXXX-XXXX-XXXX form', () => {
    expect(requested.safetyCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it('the owner computes the same code from the joiner public key on the server', async () => {
    const members = await ctx.admin<{ public_key: JsonWebKey }>(
      'select public_key from public.space_members where space_id = $1 and user_id = $2',
      [spaceId, userB.userId],
    )

    expect(await safetyCode(members[0].public_key)).toBe(requested.safetyCode)
    expect(await act(b1, () => familyActionsOf(b1).mySafetyCode())).toBe(requested.safetyCode)
  })

  it('while pending B sees the pending state and holds no Family data', () => {
    expect(pendingState).toBe('pending-approval')
    expect(pendingLocalSpaces).toBe(0)
  })

  it('the owner state lists B as a pending request before approval (join-request event)', () => {
    const events = o1.familyEvents.filter((e) => e.type === 'join-request')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ userId: userB.userId })
  })
})

describe('after approval', () => {
  it('B1 joined as a member and shows synced', () => {
    expect(b1.family?.getState()).toMatchObject({ status: 'synced', spaceId, role: 'member' })
  })

  it('B1 emitted one joined event with the space name', () => {
    const joined = b1.familyEvents.filter((e) => e.type === 'joined')

    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ spaceId, name: 'Our Family' })
  })

  it('B1 has everything O wrote and its own profile', async () => {
    const expenses = await familyExpenses(b1, spaceId)
    const profiles = await act(b1, () => b1.localDb.getMemberProfiles(spaceId))

    expect(expenses.map((e) => e.id)).toContain(expenseId)
    expect(expenses.find((e) => e.id === expenseId)?.description).toBe(OWNER_DESCRIPTION)
    expect(profiles.map((p) => p.id).sort()).toEqual([userO.userId, userB.userId].sort())
  })

  it('B1 stores a member entry at the server key version', async () => {
    const entry = await act(b1, () => b1.localDb.getSpaceKeyEntry(spaceId))

    expect(entry).toMatchObject({ role: 'member', status: 'active', keyVersion: 1 })
  })

  it('the server lists both as active members', async () => {
    const my = await act(o1, () => spacesOf(o1).getMySpace())

    expect(my?.members.filter((m) => m.status === 'active').map((m) => m.user_id).sort()).toEqual([userO.userId, userB.userId].sort())
  })

  it('the owner can read what B wrote (merge in both directions)', async () => {
    const written = await familyExpense(b1, spaceId, 77, 'Marker written by B')
    await settle([b1, o1])

    const onO = await familyExpenses(o1, spaceId)
    expect(onO.map((e) => e.id)).toContain(written.id)
    expect(onO.find((e) => e.id === written.id)?.createdBy).toBe(userB.userId)
    expect(onO.find((e) => e.id === expenseId)?.createdBy).toBe(userO.userId)
  })
})

describe('the second device of B', () => {
  it('receives the Family through personal sync with no new approval', async () => {
    const entry = await act(b2, () => b2.localDb.getSpaceKeyEntry(spaceId))
    const expenses = await familyExpenses(b2, spaceId)

    expect(entry).toMatchObject({ role: 'member', status: 'active' })
    expect(expenses.map((e) => e.id)).toContain(expenseId)
    expect(b2.family?.getState()).toMatchObject({ status: 'synced', spaceId })
    expect(b2.count('approve_member')).toBe(0)
    expect(b2.count('request_join')).toBe(0)
    expect(o1.count('approve_member')).toBe(1)
    const rows = await ctx.admin<{ n: number }>('select count(*)::int as n from public.space_members where space_id = $1', [spaceId])
    expect(rows[0].n).toBe(2)
  })

  it('does not re-upload what it pulled (pushed nothing it did not write)', () => {
    const pushes = b2.calls.filter((c) => c.fn === 'push_space_records')
    const sent = pushes.reduce((n, c) => n + ((c.args.p_records as Array<unknown> | undefined)?.length ?? 0), 0)

    expect(sent).toBeLessThanOrEqual(1)
  })
})

describe('already in a Family', () => {
  it('B createFamily shows the existing membership instead of creating', async () => {
    const result = await act(b1, () => familyActionsOf(b1).createFamily({ name: 'Another' }))

    expect(result.kind).toBe('already-in-space')
    const spaces = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces')
    expect(spaces[0].n).toBe(1)
    expect(userIdOf(b1)).toBe(userB.userId)
  })
})

describe('rejecting a request', () => {
  it('the rejected user stays out and has no Family state', async () => {
    const userC = await newUser(ctx)
    const c1 = await firstDevice(userC, 'C1')
    try {
      await requestJoinOn(o1, c1)
      await cycle(o1)
      await act(o1, () => familyActionsOf(o1).rejectMember(userC.userId))
      await cycle(c1)

      expect(c1.family?.getState().status).toBe('none')
      expect((await act(c1, () => c1.localDb.listLocalSpaces())).length).toBe(0)
      const members = await ctx.admin<{ n: number }>(
        "select count(*)::int as n from public.space_members where space_id = $1 and user_id = $2 and status = 'active'",
        [spaceId, userC.userId],
      )
      expect(members[0].n).toBe(0)
    } finally {
      c1.dispose()
    }
  })
})
