// CONTRACT_GAP: the layout of the target record (key order, chunk) is not
//   fixed; tests read through the public getters and listChangedRecords.
// CONTRACT_GAP: an unknown source category id keeps its categoryId (plan
//   section 3); not asserted beyond "the record still moves".
// CONTRACT_GAP: whether a "Family" fixture id is a real UUID: createLocalSpace
//   generates it, so tests read it from the returned space instead of the
//   contract's illustrative fam-1.
//
// Integration style (as localDb.spaces.test.ts): real crypto and real localDb,
// idb-keyval backed by the in-memory store so setMany calls can be inspected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAccountSession } from '@/lib/accountSession'
import { isAppError } from '@/lib/appErrors'
import { convertPending } from '@/lib/conversion'
import {
  MOVE_RECORDS_MAX,
  SYNC_META_KEY,
  SpaceReadOnlyError,
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  addRecurring,
  copyCategoriesFromSpace,
  createLocalSpace,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getLocalRev,
  getLocalStore,
  listChangedRecords,
  moveRecords,
  spaceDb,
  unlockLocalDb,
  updateSpaceEntry,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { setSyncChannel } from '@/lib/syncChannel'
import { failNextSetMany, storeState } from '@/test/sync/memoryIdb'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({ getAccountSession: vi.fn() }))

const MAY = '2026-10-15T12:00:00.000Z'

let dek: CryptoKey
let famId: string

function state() {
  const store = getLocalStore()
  if (!store) throw new Error('no store')
  return storeState(store)
}

function snapshot(): Map<string, unknown> {
  return new Map(state().data)
}

function changedKeys(before: Map<string, unknown>): Array<string> {
  const after = state().data
  const all = new Set([...before.keys(), ...after.keys()])
  return Array.from(all).filter((k) => before.get(k) !== after.get(k))
}

async function personalFood() {
  return addCategory({ name: 'Food', icon: '🍔' })
}

async function personalExpenses(count: number) {
  const cat = await personalFood()
  const out = []
  for (let i = 0; i < count; i++) {
    out.push(
      await addExpense({
        amount: 100 + i,
        currency: 'UAH',
        categoryId: cat.id,
        description: `lunch ${i}`,
        createdAt: MAY,
      }),
    )
  }
  return { cat, expenses: out }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  )
}

beforeEach(async () => {
  state().data.clear()
  state().setManyCalls.length = 0
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  setSyncChannel(null)
  clearKeyring()
  vi.mocked(getAccountSession).mockResolvedValue({ userId: 'u-me', email: null })
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  unlockLocalDb(dek)
  famId = (await createLocalSpace({ name: 'Our home', lang: 'en' })).id
  state().setManyCalls.length = 0
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('moving personal expenses into the Family', () => {
  it('3 personal expenses become 3 Family records with the same ids and 3 personal tombstones', async () => {
    const { expenses } = await personalExpenses(3)
    const ids = expenses.map((e) => e.id)

    const result = await moveRecords({ from: 'personal', to: famId, type: 'expense', ids })

    expect(result.moved).toBe(3)
    expect(result.skipped).toBe(0)
    const fam = await spaceDb(famId).getAllExpenses()
    expect(fam.map((e) => e.id).sort()).toEqual([...ids].sort())
    expect(fam.map((e) => e.amount).sort()).toEqual([100, 101, 102])
    expect(await getAllExpenses()).toEqual([])
    const changed = await listChangedRecords(-1)
    const tombstones = changed.records.filter((r) => r.type === 'expense' && r.deletedAt !== undefined)
    expect(tombstones.map((r) => r.id).sort()).toEqual([...ids].sort())
  })

  it('writes both spaces in ONE setMany', async () => {
    const { expenses } = await personalExpenses(2)
    state().setManyCalls.length = 0

    await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: expenses.map((e) => e.id) })

    expect(state().setManyCalls).toHaveLength(1)
    const keys = state().setManyCalls[0]
    expect(keys).toContain('expenses_2026_10')
    expect(keys).toContain(SYNC_META_KEY)
    expect(keys).toContain(`space:${famId}:expenses_2026_10`)
    expect(keys).toContain(`space:${famId}:${SYNC_META_KEY}`)
  })

  it('bumps the rev counter of both spaces', async () => {
    const { expenses } = await personalExpenses(1)
    const personalBefore = await getLocalRev()
    const familyBefore = await spaceDb(famId).getLocalRev()

    await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [expenses[0].id] })

    expect(await getLocalRev()).toBeGreaterThan(personalBefore)
    expect(await spaceDb(famId).getLocalRev()).toBeGreaterThan(familyBefore)
    const familyChanges = await listChangedRecords(famId, familyBefore)
    expect(familyChanges.records.map((r) => r.id)).toContain(expenses[0].id)
  })

  it('sets paidBy / createdBy / updatedBy to me and clears conversion and manual rate', async () => {
    const { expenses } = await personalExpenses(1)
    await convertPending()
    const converted = (await getAllExpenses())[0]
    expect(converted.conversion).toBeDefined()

    await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [expenses[0].id] })

    const moved = (await spaceDb(famId).getAllExpenses())[0]
    expect(moved.paidBy).toBe('u-me')
    expect(moved.createdBy).toBe('u-me')
    expect(moved.updatedBy).toBe('u-me')
    expect(moved.conversion).toBeUndefined()
    expect(moved.manualRate).toBeUndefined()
    expect(moved.description).toBe('lunch 0')
    expect(moved.createdAt).toBe(MAY)
  })

  it('the target converts the cleared entry to its own main currency later', async () => {
    const { expenses } = await personalExpenses(1)
    await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [expenses[0].id] })
    expect((await spaceDb(famId).getAllExpenses())[0].conversion).toBeUndefined()

    await convertPending({ spaceId: famId })

    const after = (await spaceDb(famId).getAllExpenses())[0]
    expect(after.conversion).toBeDefined()
    expect(after.conversion?.mainAmount).toBe(100)
  })

  it('only the selected ids move', async () => {
    const { expenses } = await personalExpenses(3)

    await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [expenses[1].id] })

    expect((await getAllExpenses()).map((e) => e.id).sort()).toEqual([expenses[0].id, expenses[2].id].sort())
    expect((await spaceDb(famId).getAllExpenses()).map((e) => e.id)).toEqual([expenses[1].id])
  })
})

describe('moving Family expenses back to Personal', () => {
  it('creates personal records without member fields and tombstones the Family ones', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()
    const e = await fam.addExpense({
      amount: 77,
      currency: 'UAH',
      categoryId: cat.id,
      description: 'family lunch',
      createdAt: MAY,
      paidBy: 'u-olena',
    })

    const result = await moveRecords({ from: famId, to: 'personal', type: 'expense', ids: [e.id] })

    expect(result.moved).toBe(1)
    const personal = await getAllExpenses()
    expect(personal.map((x) => x.id)).toEqual([e.id])
    expect(personal[0].paidBy).toBeUndefined()
    expect(personal[0].createdBy).toBeUndefined()
    expect(personal[0].updatedBy).toBeUndefined()
    expect(await fam.getAllExpenses()).toEqual([])
    const tomb = (await listChangedRecords(famId, -1)).records.find((r) => r.id === e.id)
    expect(tomb?.deletedAt).toBeDefined()
    expect((tomb?.data as { updatedBy?: string }).updatedBy).toBe('u-me')
  })
})

describe('categories', () => {
  it('maps by name ignoring case and diacritics and does not create a duplicate', async () => {
    const fam = spaceDb(famId)
    const target = await fam.addCategory({ name: 'Café' })
    const src = await addCategory({ name: ' CAFE ', icon: '☕' })
    const e = await addExpense({ amount: 5, currency: 'UAH', categoryId: src.id, createdAt: MAY })
    const before = (await fam.getAllCategories()).length

    const result = await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [e.id] })

    expect(result.createdCategories).toBe(0)
    expect((await fam.getAllExpenses())[0].categoryId).toBe(target.id)
    expect((await fam.getAllCategories()).length).toBe(before)
  })

  it('creates a missing category in the target with its icon and default currency, once per name', async () => {
    const fam = spaceDb(famId)
    const src = await addCategory({ name: 'Pets', icon: '🐶', defaultCurrency: 'USD' })
    const a = await addExpense({ amount: 5, currency: 'UAH', categoryId: src.id, createdAt: MAY })
    const b = await addExpense({ amount: 6, currency: 'UAH', categoryId: src.id, createdAt: MAY })

    const result = await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [a.id, b.id] })

    expect(result.createdCategories).toBe(1)
    const created = (await fam.getAllCategories()).filter((c) => c.name === 'Pets')
    expect(created).toHaveLength(1)
    expect(created[0].icon).toBe('🐶')
    expect(created[0].defaultCurrency).toBe('USD')
    expect(created[0].createdBy).toBe('u-me')
    const moved = await fam.getAllExpenses()
    expect(moved.every((x) => x.categoryId === created[0].id)).toBe(true)
    expect(state().setManyCalls.at(-1)).toContain(`space:${famId}:categories`)
  })

  it('maps income categories by name', async () => {
    const src = await addIncomeCategory({ name: 'Salary' })
    const i = await addIncome({ amount: 900, currency: 'UAH', categoryId: src.id, createdAt: MAY })

    const result = await moveRecords({ from: 'personal', to: famId, type: 'income', ids: [i.id] })

    expect(result.moved).toBe(1)
    const famIncome = await spaceDb(famId).getAllIncome()
    expect(famIncome).toHaveLength(1)
    expect(famIncome[0].paidBy).toBe('u-me')
    const famCats = await spaceDb(famId).getAllIncomeCategories()
    expect(famCats.find((c) => c.id === famIncome[0].categoryId)?.name).toBe('Salary')
    expect(await getAllIncome()).toEqual([])
  })
})

describe('recurring', () => {
  it('moves the item with the same id and keeps its progress; the source becomes a tombstone', async () => {
    const cat = await personalFood()
    const item = await addRecurring(
      {
        kind: 'expense',
        amount: 300,
        currency: 'UAH',
        categoryId: cat.id,
        description: 'rent',
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-09-15',
        end: { type: 'never' },
        mode: 'auto',
      },
      { createThroughToday: true, today: '2026-10-30' },
    )
    const before = (await getAllRecurring())[0]
    expect(before.handledThrough).not.toBeNull()

    const result = await moveRecords({ from: 'personal', to: famId, type: 'recurring', ids: [item.id] })

    expect(result.moved).toBe(1)
    const moved = (await spaceDb(famId).getAllRecurring())[0]
    expect(moved.id).toBe(item.id)
    expect(moved.handledThrough).toBe(before.handledThrough)
    expect(moved.occurrenceCount).toBe(before.occurrenceCount)
    expect(moved.paused).toBe(before.paused)
    expect(moved.mode).toBe('auto')
    expect(moved.paidBy).toBe('u-me')
    expect(await getAllRecurring()).toEqual([])
  })

  it('already generated expenses stay in Personal; later occurrences are generated in the Family only', async () => {
    const cat = await personalFood()
    const item = await addRecurring(
      {
        kind: 'expense',
        amount: 300,
        currency: 'UAH',
        categoryId: cat.id,
        description: 'rent',
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-09-15',
        end: { type: 'never' },
        mode: 'auto',
      },
      { createThroughToday: true, today: '2026-10-30' },
    )
    const generatedBefore = (await getAllExpenses()).filter((e) => e.recurringId === item.id)
    expect(generatedBefore.length).toBeGreaterThanOrEqual(1)
    const idsBefore = generatedBefore.map((e) => e.id).sort()
    const handledThrough = (await getAllRecurring())[0].handledThrough
    expect(handledThrough).not.toBeNull()

    await moveRecords({ from: 'personal', to: famId, type: 'recurring', ids: [item.id] })

    const personalAfter = (await getAllExpenses()).filter((e) => e.recurringId === item.id)
    expect(personalAfter.map((e) => e.id).sort()).toEqual(idsBefore)
    expect((await spaceDb(famId).getAllExpenses()).filter((e) => e.recurringId === item.id)).toEqual([])

    vi.setSystemTime(new Date('2026-11-20T09:00:00.000Z'))
    const run = await spaceDb(famId).processDueRecurring('2026-11-20')

    expect(run.created).toBe(1)
    const famGenerated = (await spaceDb(famId).getAllExpenses()).filter((e) => e.recurringId === item.id)
    expect(famGenerated).toHaveLength(1)
    expect(famGenerated[0].occurrenceDate && handledThrough && famGenerated[0].occurrenceDate > handledThrough).toBe(true)
    expect(famGenerated[0].paidBy).toBe('u-me')
    const personalLater = (await getAllExpenses()).filter((e) => e.recurringId === item.id)
    expect(personalLater.map((e) => e.id).sort()).toEqual(idsBefore)
  })
})

describe('refusals write nothing', () => {
  it('refuses to move into the same space', async () => {
    const before = snapshot()

    const err = await rejection(moveRecords({ from: 'personal', to: 'personal', type: 'expense', ids: ['x'] }))

    expect(isAppError(err) && err.code).toBe('move-same-space')
    expect(changedKeys(before)).toEqual([])
  })

  it('refuses more than MOVE_RECORDS_MAX ids', async () => {
    const before = snapshot()
    const ids = Array.from({ length: MOVE_RECORDS_MAX + 1 }, (_, i) => `id-${i}`)

    const err = await rejection(moveRecords({ from: 'personal', to: famId, type: 'expense', ids }))

    expect(MOVE_RECORDS_MAX).toBe(500)
    expect(isAppError(err) && err.code).toBe('move-too-many')
    expect(changedKeys(before)).toEqual([])
  })

  it('refuses a read-only Family target with SpaceReadOnlyError and no change', async () => {
    const { expenses } = await personalExpenses(1)
    await updateSpaceEntry(famId, { status: 'removed' })
    wipeLocalDbKey()
    unlockLocalDb(dek)
    await spaceDb(famId).getAllExpenses()
    const before = snapshot()

    const err = await rejection(moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [expenses[0].id] }))

    expect(err).toBeInstanceOf(SpaceReadOnlyError)
    expect(changedKeys(before)).toEqual([])
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([expenses[0].id])
  })

  it('refuses moving out of a read-only Family (the source would get tombstones)', async () => {
    const fam = spaceDb(famId)
    const [cat] = await fam.getAllCategories()
    const e = await fam.addExpense({ amount: 1, currency: 'UAH', categoryId: cat.id, createdAt: MAY })
    await updateSpaceEntry(famId, { status: 'removed' })
    wipeLocalDbKey()
    unlockLocalDb(dek)
    await spaceDb(famId).getAllExpenses()
    const before = snapshot()

    const err = await rejection(moveRecords({ from: famId, to: 'personal', type: 'expense', ids: [e.id] }))

    expect(err).toBeInstanceOf(SpaceReadOnlyError)
    expect(changedKeys(before)).toEqual([])
  })

  it('an injected setMany failure leaves both spaces unchanged', async () => {
    const { expenses } = await personalExpenses(2)
    const before = snapshot()
    const personalRev = await getLocalRev()
    const familyRev = await spaceDb(famId).getLocalRev()
    failNextSetMany(getLocalStore())

    const err = await rejection(
      moveRecords({ from: 'personal', to: famId, type: 'expense', ids: expenses.map((e) => e.id) }),
    )

    expect(err).toBeInstanceOf(Error)
    expect(changedKeys(before)).toEqual([])
    expect(await getLocalRev()).toBe(personalRev)
    expect(await spaceDb(famId).getLocalRev()).toBe(familyRev)
    expect(await getAllExpenses()).toHaveLength(2)
    expect(await spaceDb(famId).getAllExpenses()).toEqual([])
  })
})

describe('missing and duplicate ids', () => {
  it('no live ids: moved 0 and nothing is written', async () => {
    await personalExpenses(1)
    state().setManyCalls.length = 0
    const before = snapshot()

    const result = await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: ['nope'] })

    expect(result.moved).toBe(0)
    expect(state().setManyCalls).toEqual([])
    expect(changedKeys(before)).toEqual([])
  })

  it('an empty list is a no-op', async () => {
    const result = await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [] })

    expect(result).toEqual({ moved: 0, createdCategories: 0, skipped: 0 })
    expect(state().setManyCalls).toEqual([])
  })

  it('skips an id that is gone and moves the rest', async () => {
    const { expenses } = await personalExpenses(1)

    const result = await moveRecords({
      from: 'personal',
      to: famId,
      type: 'expense',
      ids: [expenses[0].id, 'gone-id'],
    })

    expect(result.moved).toBe(1)
    expect(await spaceDb(famId).getAllExpenses()).toHaveLength(1)
  })

  it('a round trip (to Family and back) lands the record in Personal again with the same id', async () => {
    const { expenses } = await personalExpenses(1)
    const id = expenses[0].id

    await moveRecords({ from: 'personal', to: famId, type: 'expense', ids: [id] })
    const back = await moveRecords({ from: famId, to: 'personal', type: 'expense', ids: [id] })

    expect(back.moved).toBe(1)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([id])
    expect(await spaceDb(famId).getAllExpenses()).toEqual([])
  })
})

describe('copyCategoriesFromSpace', () => {
  it('adds only the names missing in the target, never a duplicate', async () => {
    const fam = spaceDb(famId)
    const famBefore = (await fam.getAllCategories()).map((c) => c.name)
    await addCategory({ name: 'Pets', icon: '🐶' })
    await addCategory({ name: famBefore[0].toUpperCase() })
    await addIncomeCategory({ name: 'Side gig' })

    const first = await copyCategoriesFromSpace({ from: 'personal', to: famId })

    const names = (await fam.getAllCategories()).map((c) => c.name)
    expect(names).toContain('Pets')
    expect(names.filter((n) => n.toLowerCase() === famBefore[0].toLowerCase())).toHaveLength(1)
    expect(first.categories).toBeGreaterThanOrEqual(1)
    expect((await fam.getAllIncomeCategories()).map((c) => c.name)).toContain('Side gig')
    expect(first.incomeCategories).toBeGreaterThanOrEqual(1)

    state().setManyCalls.length = 0
    const second = await copyCategoriesFromSpace({ from: 'personal', to: famId })
    expect(second).toEqual({ categories: 0, incomeCategories: 0 })
    expect(state().setManyCalls).toEqual([])
  })

  it('refuses a read-only target', async () => {
    await addCategory({ name: 'Pets' })
    await updateSpaceEntry(famId, { status: 'removed' })
    wipeLocalDbKey()
    unlockLocalDb(dek)
    await spaceDb(famId).getAllExpenses()

    const err = await rejection(copyCategoriesFromSpace({ from: 'personal', to: famId }))

    expect(err).toBeInstanceOf(SpaceReadOnlyError)
  })

  it('leaves the personal categories alone', async () => {
    await addCategory({ name: 'Pets' })
    const before = (await getAllCategories()).length
    const beforeIncome = (await getAllIncomeCategories()).length

    await copyCategoriesFromSpace({ from: 'personal', to: famId })

    expect((await getAllCategories()).length).toBe(before)
    expect((await getAllIncomeCategories()).length).toBe(beforeIncome)
  })
})
