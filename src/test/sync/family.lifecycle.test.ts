// CONTRACT_GAP: "the server has nothing for the space" after delete is asserted
//   on the spaces, space_members and space_records tables only.
// CONTRACT_GAP: auto-rotation when a member's ACCOUNT is deleted (criterion 23)
//   needs the account deletion RPC and is covered by the wrap-set unit test in
//   familyStream.test.ts; here it is exercised through a member who leaves.
//
// Lifecycle (criteria 20, 23, 26, 27, 28): C leaves and O rotates on its own;
// O transfers to B and leaves; B (now owner) rotates again and then deletes the
// Family; D, still a member, ends in space-gone with a read-only copy.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import { isSpaceReadOnlyError } from '@/lib/spaces/types'
import {
  act,
  createFamilyOn,
  cycle,
  familyActionsOf,
  familyExpense,
  familyExpenses,
  firstDevice,
  joinFamily,
  newUser,
  serverRows,
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
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

let ctx: SqlTestDb
let o1: SimDevice
let b1: SimDevice
let c1: SimDevice
let d1: SimDevice
let spaceId: string

async function keyVersionOnServer(): Promise<number | undefined> {
  const my = await act(b1, () => spacesOf(b1).getMySpace())
  return my?.key_version ?? undefined
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  o1 = await firstDevice(await newUser(ctx), 'O1')
  b1 = await firstDevice(await newUser(ctx), 'B1')
  c1 = await firstDevice(await newUser(ctx), 'C1')
  d1 = await firstDevice(await newUser(ctx), 'D1')
  spaceId = await createFamilyOn(o1, 'Lifecycle')
  for (const joiner of [b1, c1, d1]) await joinFamily(o1, joiner)
  await familyExpense(o1, spaceId, 500, 'Marker lifecycle')
  await settle([o1, b1, c1, d1], 3)
}, 300_000)

afterAll(async () => {
  for (const d of [o1, b1, c1, d1]) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('members: names and the space name', () => {
  it('"Your name in Family" shows up on the other devices', async () => {
    await act(b1, () => familyActionsOf(b1).setMyDisplayName('Mum'))
    await settle([b1, o1])

    const profiles = await act(o1, () => o1.localDb.getMemberProfiles(spaceId))
    expect(profiles.find((p) => p.id === userIdOf(b1))?.displayName).toBe('Mum')
  })

  it('any member can rename the Family and everyone sees it', async () => {
    await act(d1, () => familyActionsOf(d1).renameFamily('Our Home'))
    await settle([d1, o1, b1])

    expect((await act(o1, () => o1.localDb.getSpaceInfo(spaceId)))?.name).toBe('Our Home')
    expect((await act(o1, () => o1.localDb.getSpaceKeyEntry(spaceId)))?.name).toBe('Our Home')
    expect((await act(b1, () => b1.localDb.getSpaceInfo(spaceId)))?.name).toBe('Our Home')
  })
})

describe('a member leaves', () => {
  it('Leave calls leave_space and keeps a read-only copy', async () => {
    await act(c1, () => familyActionsOf(c1).leaveFamily())
    await cycle(c1)

    const entry = await act(c1, () => c1.localDb.getSpaceKeyEntry(spaceId))
    expect(entry?.status).toBe('left')
    expect(c1.count('leave_space')).toBe(1)
    expect(c1.family?.getState().readOnly).toBe(true)
    expect((await familyExpenses(c1, spaceId)).map((e) => e.description)).toContain('Marker lifecycle')
    const err = await familyExpense(c1, spaceId, 1, 'blocked').then(
      () => null,
      (e: unknown) => e,
    )
    expect(isSpaceReadOnlyError(err)).toBe(true)
  })

  it('the owner rotates on its own, without any removal', async () => {
    const before = await keyVersionOnServer()
    expect(before).toBe(1)

    await settle([o1, b1, d1], 2)

    expect(await keyVersionOnServer()).toBe(2)
    expect(new Set((await serverRows(ctx, spaceId)).map((r) => r.key_version))).toEqual(new Set([2]))
    const entry = await act(o1, () => o1.localDb.getSpaceKeyEntry(spaceId))
    expect(entry?.wrappedFor?.userIds).not.toContain(userIdOf(c1))
  })

  it('a former member cannot read the new version', async () => {
    const written = await familyExpense(b1, spaceId, 7, 'Marker after leave')
    await settle([b1, o1, d1])

    const rows = await serverRows(ctx, spaceId)
    expect(rows.every((r) => r.key_version === 2)).toBe(true)
    await cycle(c1)
    expect((await familyExpenses(c1, spaceId)).map((e) => e.id)).not.toContain(written.id)
  })
})

describe('ownership moves and the old owner leaves', () => {
  it('transfer needs an active member and makes B the owner', async () => {
    await act(o1, () => familyActionsOf(o1).transferOwnership(userIdOf(b1)))
    await settle([o1, b1])

    const my = await act(b1, () => spacesOf(b1).getMySpace())
    expect(my?.role).toBe('owner')
    expect(my?.owner_id).toBe(userIdOf(b1))
    expect((await act(o1, () => o1.localDb.getSpaceKeyEntry(spaceId)))?.role).toBe('member')
    expect((await act(b1, () => b1.localDb.getSpaceKeyEntry(spaceId)))?.role).toBe('owner')
  })

  it('the old owner can now leave, and the new owner rotates', async () => {
    await act(o1, () => familyActionsOf(o1).leaveFamily())
    await cycle(o1)
    await settle([b1, d1], 2)

    expect((await act(o1, () => o1.localDb.getSpaceKeyEntry(spaceId)))?.status).toBe('left')
    expect(await keyVersionOnServer()).toBe(3)
    expect(new Set((await serverRows(ctx, spaceId)).map((r) => r.key_version))).toEqual(new Set([3]))
  })
})

describe('delete the Family', () => {
  it('a wrong name deletes nothing', async () => {
    const err = await act(b1, () => familyActionsOf(b1).deleteFamily('Wrong name')).then(
      () => null,
      (e: unknown) => e,
    )

    expect((err as { code?: string } | null)?.code).toBe('name_mismatch')
    const rows = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces where id = $1', [spaceId])
    expect(rows[0].n).toBe(1)
  })

  it('the right name removes everything on the server and forgets the owner copy', async () => {
    await act(b1, () => familyActionsOf(b1).deleteFamily('Our Home'))

    for (const [table, column] of [
      ['spaces', 'id'],
      ['space_members', 'space_id'],
      ['space_records', 'space_id'],
    ] as const) {
      const rows = await ctx.admin<{ n: number }>(`select count(*)::int as n from public.${table} where ${column} = $1`, [spaceId])
      expect(rows[0].n, table).toBe(0)
    }
    expect(await act(b1, () => b1.localDb.getSpaceKeyEntry(spaceId))).toBeNull()
    expect(b1.family?.getState().status).toBe('none')
  })

  it('a remaining member ends in space-gone with a read-only copy', async () => {
    await cycle(d1)

    expect(d1.family?.getState()).toMatchObject({ status: 'space-gone', readOnly: true })
    const entry = await act(d1, () => d1.localDb.getSpaceKeyEntry(spaceId))
    expect(entry?.status).toBe('space-gone')
    expect((await familyExpenses(d1, spaceId)).map((e) => e.description)).toContain('Marker lifecycle')
    const err = await familyExpense(d1, spaceId, 1, 'blocked').then(
      () => null,
      (e: unknown) => e,
    )
    expect(isSpaceReadOnlyError(err)).toBe(true)
  })

  it('the owner device lists no spaces any more after a further cycle', async () => {
    await cycle(b1)

    expect(await act(b1, () => b1.localDb.listLocalSpaces())).toEqual([])
  })
})
