// One user, two devices (phone and laptop), one Family: what is written on one
// device reaches the other through the Family stream, whichever device existed
// first and whoever owns the Family.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice } from '@/test/sync/simDevice'
import type { FamilyUser } from '@/test/sql/familyHarness'
import type { SqlTestDb } from '@/test/sql/harness'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  cycle,
  familyExpense,
  familyExpenses,
  firstDevice,
  joinFamily,
  newUser,
  nextDevice,
  settle,
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
let userO: FamilyUser
let userB: FamilyUser
let phone: SimDevice
let laptop: SimDevice
let b1: SimDevice
let spaceId: string

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  userO = await newUser(ctx)
  userB = await newUser(ctx)
  phone = await firstDevice(userO, 'phone')
  // The laptop exists before the Family does.
  laptop = await nextDevice(userO, 'laptop')
  await settle([phone, laptop])
  b1 = await firstDevice(userB, 'B1')
  spaceId = await createFamilyOn(phone, 'Home')
}, 240_000)

afterAll(async () => {
  for (const d of [phone, laptop, b1]) d.dispose()
  vi.useRealTimers()
  await ctx.close()
})

async function descriptions(device: SimDevice): Promise<Array<string>> {
  return (await familyExpenses(device, spaceId)).map((e) => e.description ?? '').sort()
}

describe('the owner has a phone and a laptop', () => {
  it('the laptop gets the Family and its first entry in one cycle', async () => {
    await familyExpense(phone, spaceId, 100, 'first on phone')
    await cycle(phone)
    await cycle(laptop)

    expect(laptop.family?.getState()).toMatchObject({ status: 'synced', spaceId })
    expect(await descriptions(laptop)).toEqual(['first on phone'])
  })

  it('a later phone entry reaches the laptop', async () => {
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'))
    await familyExpense(phone, spaceId, 200, 'second on phone')
    await cycle(phone)
    await cycle(laptop)

    expect(await descriptions(laptop)).toEqual(['first on phone', 'second on phone'])
  })

  it('a laptop entry reaches the phone', async () => {
    vi.setSystemTime(new Date('2026-10-30T11:00:00.000Z'))
    await familyExpense(laptop, spaceId, 300, 'on laptop')
    await cycle(laptop)
    await cycle(phone)

    expect(await descriptions(phone)).toEqual(['first on phone', 'on laptop', 'second on phone'])
  })

  it('still syncs both ways after a member joined', async () => {
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'))
    await joinFamily(phone, b1)
    await settle([phone, laptop, b1])
    await familyExpense(b1, spaceId, 400, 'from B')
    await familyExpense(phone, spaceId, 500, 'phone after join')
    await settle([b1, phone, laptop])

    const all = ['first on phone', 'from B', 'on laptop', 'phone after join', 'second on phone']
    expect(await descriptions(laptop)).toEqual(all)
    expect(await descriptions(phone)).toEqual(all)
    expect(await descriptions(b1)).toEqual(all)
    for (const d of [phone, laptop, b1]) {
      expect(d.family?.getState().status).toBe('synced')
    }
  })

  it('a budget set on the phone reaches the laptop', async () => {
    vi.setSystemTime(new Date('2026-10-30T13:00:00.000Z'))
    await act(phone, async () => {
      const db = phone.localDb.spaceDb(spaceId)
      const [category] = await db.getAllCategories()
      await db.upsertBudget({ categoryId: category.id, monthlyLimit: 1234, currency: 'UAH' })
    })
    await cycle(phone)
    await cycle(laptop)

    const budgets = await act(laptop, () => laptop.localDb.spaceDb(spaceId).getAllBudgets())
    expect(budgets.map((b) => b.monthlyLimit)).toEqual([1234])
  })
})
