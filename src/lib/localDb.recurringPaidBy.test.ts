// CONTRACT_GAP: the date of each generated occurrence is not asserted; entries
//   are identified by recurringId only.
//
// Recurring paidBy (plan section 3): a Family item defaults to its creator,
// keeps an explicit payer, generated entries inherit it, personal items never
// carry it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreateRecurringInput } from '@/lib/domain'
import { getAccountSession } from '@/lib/accountSession'
import {
  addCategory,
  addRecurring,
  createLocalSpace,
  getAllExpenses,
  getAllRecurring,
  getLocalStore,
  spaceDb,
  unlockLocalDb,
  updateRecurring,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { setSyncChannel } from '@/lib/syncChannel'
import { storeState } from '@/test/sync/memoryIdb'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({ getAccountSession: vi.fn() }))

const TODAY = '2026-10-20'

let famId: string

function input(categoryId: string, extra: Partial<CreateRecurringInput> = {}): CreateRecurringInput {
  return {
    kind: 'expense',
    amount: 200,
    currency: 'UAH',
    categoryId,
    description: 'subscription',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-08-20',
    end: { type: 'never' },
    mode: 'auto',
    ...extra,
  }
}

beforeEach(async () => {
  const store = getLocalStore()
  if (!store) throw new Error('no store')
  storeState(store).data.clear()
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 20, 12, 0, 0))
  setSyncChannel(null)
  clearKeyring()
  vi.mocked(getAccountSession).mockResolvedValue({ userId: 'u-me', email: null })
  unlockLocalDb(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
  famId = (await createLocalSpace({ name: 'Our home', lang: 'en' })).id
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('Family recurring items', () => {
  it('store an explicit paidBy', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()

    const item = await fam.addRecurring(input(cat.id, { paidBy: 'u-olena' }), {
      createThroughToday: false,
      today: TODAY,
    })

    expect(item.paidBy).toBe('u-olena')
    expect(item.createdBy).toBe('u-me')
    expect((await fam.getAllRecurring())[0].paidBy).toBe('u-olena')
  })

  it('default the payer to the creator when none is given', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()

    const item = await fam.addRecurring(input(cat.id), { createThroughToday: false, today: TODAY })

    expect(item.paidBy).toBe('u-me')
  })

  it('generated entries inherit the payer of the item, not the generating member', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()
    const item = await fam.addRecurring(input(cat.id, { paidBy: 'u-olena' }), {
      createThroughToday: true,
      today: TODAY,
    })

    const generated = (await fam.getAllExpenses()).filter((e) => e.recurringId === item.id)

    expect(generated.length).toBeGreaterThanOrEqual(2)
    expect(generated.every((e) => e.paidBy === 'u-olena')).toBe(true)
    expect(generated.every((e) => e.createdBy === 'u-me')).toBe(true)
  })

  it('a different payer on another item gives different entries', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()
    const a = await fam.addRecurring(input(cat.id, { paidBy: 'u-olena', description: 'a' }), {
      createThroughToday: true,
      today: TODAY,
    })
    const b = await fam.addRecurring(input(cat.id, { paidBy: 'u-taras', description: 'b' }), {
      createThroughToday: true,
      today: TODAY,
    })

    const all = await fam.getAllExpenses()

    expect(all.filter((e) => e.recurringId === a.id).every((e) => e.paidBy === 'u-olena')).toBe(true)
    expect(all.filter((e) => e.recurringId === b.id).every((e) => e.paidBy === 'u-taras')).toBe(true)
  })

  it('update changes the payer, and an update without paidBy keeps it', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()
    const item = await fam.addRecurring(input(cat.id, { paidBy: 'u-olena' }), {
      createThroughToday: false,
      today: TODAY,
    })

    const kept = await fam.updateRecurring(item.id, { amount: 250 })
    expect(kept.paidBy).toBe('u-olena')
    expect(kept.amount).toBe(250)

    const changed = await fam.updateRecurring(item.id, { paidBy: 'u-taras' })
    expect(changed.paidBy).toBe('u-taras')
    expect((await fam.getAllRecurring())[0].paidBy).toBe('u-taras')
  })

  it('a quick repeat of a Family expense gives the item the payer of the entry', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()

    await fam.addRepeatingExpense(
      { amount: 40, currency: 'UAH', categoryId: cat.id, createdAt: '2026-10-20T10:00:00.000Z', paidBy: 'u-olena' },
      'month',
    )

    const items = await fam.getAllRecurring()
    expect(items).toHaveLength(1)
    expect(items[0].paidBy).toBe('u-olena')
  })
})

describe('personal recurring items', () => {
  it('never carry paidBy, even when one is passed', async () => {
    const cat = await addCategory({ name: 'Bills' })

    const item = await addRecurring(input(cat.id, { paidBy: 'u-olena' }), {
      createThroughToday: true,
      today: TODAY,
    })

    expect(item.paidBy).toBeUndefined()
    expect((await getAllRecurring())[0].paidBy).toBeUndefined()
    const generated = (await getAllExpenses()).filter((e) => e.recurringId === item.id)
    expect(generated.length).toBeGreaterThanOrEqual(1)
    expect(generated.every((e) => e.paidBy === undefined)).toBe(true)
  })

  it('ignore paidBy on update', async () => {
    const cat = await addCategory({ name: 'Bills' })
    const item = await addRecurring(input(cat.id), { createThroughToday: false, today: TODAY })

    const updated = await updateRecurring(item.id, { paidBy: 'u-taras' })

    expect(updated.paidBy).toBeUndefined()
  })
})
