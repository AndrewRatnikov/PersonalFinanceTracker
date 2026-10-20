// No CONTRACT_GAPs: updateCategory / updateIncomeCategory keep, set, clear and
// reject defaultCurrency exactly as the Interface Contract describes (module:
// localDb). Real localDb, idb-keyval backed by a Map (as localDb.categories).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Category, Currency } from '@/lib/domain'
import {
  addCategory,
  addIncomeCategory,
  getAllCategories,
  getAllIncomeCategories,
  unlockLocalDb,
  updateCategory,
  updateIncomeCategory,
} from '@/lib/localDb'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

// Values the type system would reject; the store must reject them at runtime.
const NOT_A_CURRENCY = 'GBP' as unknown as Currency
const OTHER_JUNK = 'xyz' as unknown as Currency

interface Api {
  label: string
  storeKey: string
  add: (input: { name: string; icon?: string | null }) => Promise<Category>
  update: (input: {
    id: string
    name: string
    icon?: string | null
    defaultCurrency?: Currency | null
  }) => Promise<Category>
  list: () => Promise<Array<Category>>
}

const APIS: Array<Api> = [
  {
    label: 'expense categories',
    storeKey: 'categories',
    add: addCategory,
    update: updateCategory,
    list: getAllCategories,
  },
  {
    label: 'income categories',
    storeKey: 'incomeCategories',
    add: addIncomeCategory,
    update: updateIncomeCategory,
    list: getAllIncomeCategories,
  },
]

beforeEach(async () => {
  mockStore.clear()
  unlockLocalDb(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  )
})

describe.each(APIS)('$label: defaultCurrency', (api) => {
  it('a new category has no default currency', async () => {
    const created = await api.add({ name: 'Food' })

    expect(created.defaultCurrency).toBeUndefined()
    expect((await api.list())[0].defaultCurrency).toBeUndefined()
  })

  it('sets a default currency and reads it back', async () => {
    const created = await api.add({ name: 'Servers' })

    const updated = await api.update({
      id: created.id,
      name: 'Servers',
      defaultCurrency: 'USD',
    })

    expect(updated.defaultCurrency).toBe('USD')
    expect((await api.list())[0].defaultCurrency).toBe('USD')
  })

  it('replaces one default currency with another', async () => {
    const created = await api.add({ name: 'Servers' })
    await api.update({ id: created.id, name: 'Servers', defaultCurrency: 'USD' })

    await api.update({ id: created.id, name: 'Servers', defaultCurrency: 'EUR' })

    expect((await api.list())[0].defaultCurrency).toBe('EUR')
  })

  it('keeps the stored value when defaultCurrency is undefined (a rename keeps it)', async () => {
    const created = await api.add({ name: 'Servers', icon: '🖥️' })
    await api.update({
      id: created.id,
      name: 'Servers',
      icon: '🖥️',
      defaultCurrency: 'USD',
    })

    const renamed = await api.update({
      id: created.id,
      name: 'Hosting',
      icon: '🖥️',
    })

    expect(renamed.name).toBe('Hosting')
    expect(renamed.defaultCurrency).toBe('USD')
    const [stored] = await api.list()
    expect(stored.name).toBe('Hosting')
    expect(stored.defaultCurrency).toBe('USD')
  })

  it('keeps the value for an explicit undefined too', async () => {
    const created = await api.add({ name: 'Servers' })
    await api.update({ id: created.id, name: 'Servers', defaultCurrency: 'EUR' })

    await api.update({
      id: created.id,
      name: 'Servers',
      defaultCurrency: undefined,
    })

    expect((await api.list())[0].defaultCurrency).toBe('EUR')
  })

  it('null removes the key, it is never stored as null', async () => {
    const created = await api.add({ name: 'Servers' })
    await api.update({ id: created.id, name: 'Servers', defaultCurrency: 'USD' })

    const cleared = await api.update({
      id: created.id,
      name: 'Servers',
      defaultCurrency: null,
    })

    expect(cleared.defaultCurrency).toBeUndefined()
    expect('defaultCurrency' in cleared).toBe(false)
    const [stored] = await api.list()
    expect(stored.defaultCurrency).toBeUndefined()
    expect('defaultCurrency' in stored).toBe(false)
  })

  it('clearing a category that has no default is harmless', async () => {
    const created = await api.add({ name: 'Food' })

    const result = await api.update({
      id: created.id,
      name: 'Food',
      defaultCurrency: null,
    })

    expect('defaultCurrency' in result).toBe(false)
  })

  it('rejects an invalid currency with "Invalid currency" and writes nothing', async () => {
    const created = await api.add({ name: 'Servers' })
    const before = mockStore.get(api.storeKey)

    await expect(
      api.update({
        id: created.id,
        name: 'Servers',
        defaultCurrency: NOT_A_CURRENCY,
      }),
    ).rejects.toThrow('Invalid currency')

    expect(mockStore.get(api.storeKey)).toBe(before)
    expect((await api.list())[0].defaultCurrency).toBeUndefined()
  })

  it('an invalid currency does not clear a stored one', async () => {
    const created = await api.add({ name: 'Servers' })
    await api.update({ id: created.id, name: 'Servers', defaultCurrency: 'USD' })

    await expect(
      api.update({
        id: created.id,
        name: 'Servers',
        defaultCurrency: OTHER_JUNK,
      }),
    ).rejects.toThrow('Invalid currency')

    expect((await api.list())[0].defaultCurrency).toBe('USD')
  })

  it('changes one category without touching another', async () => {
    const a = await api.add({ name: 'A' })
    const b = await api.add({ name: 'B' })

    await api.update({ id: a.id, name: 'A', defaultCurrency: 'EUR' })

    const all = await api.list()
    expect(all.find((c) => c.id === a.id)?.defaultCurrency).toBe('EUR')
    expect(all.find((c) => c.id === b.id)?.defaultCurrency).toBeUndefined()
  })

  it('still applies the name rules', async () => {
    const a = await api.add({ name: 'Food' })
    const b = await api.add({ name: 'Transport' })

    await expect(
      api.update({ id: b.id, name: 'FOOD', defaultCurrency: 'USD' }),
    ).rejects.toThrow(/already exists/)
    await expect(
      api.update({ id: a.id, name: '  ', defaultCurrency: 'USD' }),
    ).rejects.toThrow(/required/)

    const all = await api.list()
    expect(all.every((c) => c.defaultCurrency === undefined)).toBe(true)
  })
})
