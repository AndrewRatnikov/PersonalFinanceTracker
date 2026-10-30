// CONTRACT_GAP: the shape of the failure injected after create_space is a
//   transport failure of push_space_records (status 0), because the contract
//   names no other injection point.
// CONTRACT_GAP: `spaces` / `space_records` column names come from the Family
//   migration (owner_id, record_key, ciphertext, iv, key_version).
//
// Create (criteria 8 to 10): owner O creates a Family on the real PGlite
// server; the server holds only ciphertext; a failure after create_space is
// healed by the next cycle without duplicates.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { FamilyUser } from '@/test/sql/familyHarness'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  cycle,
  familyActionsOf,
  familyExpense,
  firstDevice,
  newUser,
  serverRows,
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
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const FAMILY_NAME = 'Marker Family Name'
const DESCRIPTION = 'Marker lunch special'
const AMOUNT = 123457

let ctx: SqlTestDb
const devices: Array<SimDevice> = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
}, 120_000)

afterAll(async () => {
  for (const d of devices) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

async function owner(): Promise<{ user: FamilyUser; device: SimDevice }> {
  const user = await newUser(ctx)
  const device = await firstDevice(user, 'O1')
  devices.push(device)
  return { user, device }
}

describe('creating a Family', () => {
  let o: { user: FamilyUser; device: SimDevice }
  let spaceId: string

  beforeAll(async () => {
    o = await owner()
    spaceId = await createFamilyOn(o.device, FAMILY_NAME)
    await familyExpense(o.device, spaceId, AMOUNT, DESCRIPTION)
    await cycle(o.device)
  }, 180_000)

  it('the server has the space with the creator as owner at key version 1', async () => {
    const rows = await ctx.admin<{ owner_id: string }>('select owner_id::text as owner_id from public.spaces where id = $1', [spaceId])
    expect(rows).toHaveLength(1)
    expect(rows[0].owner_id).toBe(userIdOf(o.device))

    const my = await act(o.device, () => spacesOf(o.device).getMySpace())
    expect(my).toMatchObject({ space_id: spaceId, role: 'owner', status: 'active', key_version: 1 })
  })

  it('the first cycle pushed spaceInfo, categories, settings, the profile and the entry', async () => {
    const rows = await serverRows(ctx, spaceId)

    expect(rows.length).toBeGreaterThanOrEqual(5)
    expect(rows.every((r) => r.key_version === 1)).toBe(true)
    expect(new Set(rows.map((r) => r.record_key)).size).toBe(rows.length)
  })

  it('no space_records column contains the name, a category, the description or the amount', async () => {
    const rows = await ctx.admin('select * from public.space_records where space_id = $1', [spaceId])
    const text = JSON.stringify(rows)

    expect(text.length).toBeGreaterThan(100)
    for (const secret of [FAMILY_NAME, DESCRIPTION, String(AMOUNT), 'Groceries', 'Food']) {
      expect(text.includes(secret), secret).toBe(false)
    }
  })

  it('the local entry is active, has an index key and lists the creator in the wrap set', async () => {
    const entry = await act(o.device, () => o.device.localDb.getSpaceKeyEntry(spaceId))

    expect(entry).toMatchObject({ status: 'active', role: 'owner', keyVersion: 1, name: FAMILY_NAME })
    expect(entry?.indexKey?.length).toBeGreaterThan(10)
    expect(entry?.wrappedFor).toEqual({ keyVersion: 1, userIds: [userIdOf(o.device)] })
  })

  it('writes the creator profile with a colour', async () => {
    const profiles = await act(o.device, () => o.device.localDb.getMemberProfiles(spaceId))

    expect(profiles.map((p) => p.id)).toEqual([userIdOf(o.device)])
    expect(profiles[0].color).toMatch(/^var\(--/)
    expect(profiles[0].displayName).toBe(o.user.email.split('@')[0])
  })

  it('the Family state is synced', () => {
    expect(o.device.family?.getState()).toMatchObject({ status: 'synced', spaceId, role: 'owner' })
  })

  it('a second createFamily reuses the same space and adds nothing to the server', async () => {
    const before = (await serverRows(ctx, spaceId)).length

    const again = await act(o.device, () => familyActionsOf(o.device).createFamily({ name: FAMILY_NAME }))
    await cycle(o.device)

    expect(again).toEqual({ kind: 'created', spaceId })
    expect((await serverRows(ctx, spaceId)).length).toBe(before)
    const spaces = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces where owner_id = $1', [userIdOf(o.device)])
    expect(spaces[0].n).toBe(1)
    expect((await act(o.device, () => o.device.localDb.listLocalSpaces())).length).toBe(1)
  })
})

describe('a failure after create_space', () => {
  it('leaves a usable state; the next cycle completes the push without duplicates', async () => {
    const { user, device } = await owner()
    let failed = 0
    device.intercept = (call) => {
      if (call.fn === 'push_space_records' && failed === 0) {
        failed += 1
        return { data: null, error: { message: 'Failed to fetch' }, status: 0 }
      }
      return undefined
    }

    const result = await act(device, () => familyActionsOf(device).createFamily({ name: 'Retry family' }))
    if (result.kind !== 'created') throw new Error('expected created')
    const spaceId = result.spaceId

    expect(failed).toBe(1)
    const serverHasSpace = await ctx.admin<{ n: number }>('select count(*)::int as n from public.spaces where id = $1', [spaceId])
    expect(serverHasSpace[0].n).toBe(1)
    expect((await serverRows(ctx, spaceId)).length).toBe(0)
    expect(device.family?.getState().status).not.toBe('synced')

    await cycle(device)
    const afterRetry = await serverRows(ctx, spaceId)
    expect(afterRetry.length).toBeGreaterThanOrEqual(5)

    await act(device, () => familyActionsOf(device).createFamily({ name: 'Retry family' }))
    await cycle(device)
    await cycle(device)

    const final = await serverRows(ctx, spaceId)
    expect(final.length).toBe(afterRetry.length)
    expect(new Set(final.map((r) => r.record_key)).size).toBe(final.length)
    expect((await act(device, () => device.localDb.listLocalSpaces())).length).toBe(1)
    expect(device.family?.getState().status).toBe('synced')
    devices.push(device)
    expect(userIdOf(device)).toBe(user.userId)
  })
})
