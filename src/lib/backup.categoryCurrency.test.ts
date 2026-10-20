// No CONTRACT_GAPs: backup.ts is unchanged; these tests prove that a category's
// defaultCurrency (expense and income) survives createBackup, serializeBackup,
// parseBackupFile and restoreBackup in replace and merge mode.
//
// Integration style (as backup.incomeCategories.test.ts): real crypto, real
// vault, real localDb, idb-keyval backed by a Map.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createBackup,
  parseBackupFile,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import {
  addCategory,
  addIncomeCategory,
  getAllCategories,
  getAllIncomeCategories,
  updateCategory,
  updateIncomeCategory,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import { createVault, lockVault } from '@/lib/vault'

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
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const PW = 'correct horse battery'
const PW2 = 'second password 456'

function wipe() {
  lockVault()
  mockStore.clear()
}

// Three expense and three income categories: USD, EUR and none.
async function seedCategories() {
  const server = await addCategory({ name: 'Server Costs', icon: '🖥️' })
  const euro = await addCategory({ name: 'Trips' })
  const plain = await addCategory({ name: 'Food', icon: '🍔' })
  await updateCategory({
    id: server.id,
    name: 'Server Costs',
    icon: '🖥️',
    defaultCurrency: 'USD',
  })
  await updateCategory({ id: euro.id, name: 'Trips', defaultCurrency: 'EUR' })

  const freelance = await addIncomeCategory({ name: 'Freelance' })
  const salary = await addIncomeCategory({ name: 'Salary' })
  await updateIncomeCategory({
    id: freelance.id,
    name: 'Freelance',
    defaultCurrency: 'USD',
  })
  return { server, euro, plain, freelance, salary }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
  setSyncChannel(null)
})

afterEach(() => {
  lockVault()
})

describe('defaultCurrency in a backup', () => {
  it('replace restore brings back the expense categories with their default currency', async () => {
    await createVault(PW)
    const ids = await seedCategories()
    const before = await getAllCategories()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const after = await getAllCategories()
    expect(after).toEqual(before)
    expect(after.find((c) => c.id === ids.server.id)?.defaultCurrency).toBe('USD')
    expect(after.find((c) => c.id === ids.euro.id)?.defaultCurrency).toBe('EUR')
  })

  it('a category without a default comes back without the key', async () => {
    await createVault(PW)
    const ids = await seedCategories()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const plain = (await getAllCategories()).find((c) => c.id === ids.plain.id)
    expect(plain).toBeDefined()
    expect('defaultCurrency' in (plain ?? {})).toBe(false)
  })

  it('replace restore brings back the income categories with their default currency', async () => {
    await createVault(PW)
    const ids = await seedCategories()
    const before = await getAllIncomeCategories()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const after = await getAllIncomeCategories()
    expect(after).toEqual(before)
    expect(after.find((c) => c.id === ids.freelance.id)?.defaultCurrency).toBe('USD')
    const salary = after.find((c) => c.id === ids.salary.id)
    expect('defaultCurrency' in (salary ?? {})).toBe(false)
  })

  it('merge restore into another device keeps the default currencies', async () => {
    await createVault(PW)
    const ids = await seedCategories()
    const text = serializeBackup(await createBackup())
    wipe()
    await createVault(PW2)
    const own = await addCategory({ name: 'Own' })

    await restoreBackup(text, PW, 'merge')

    const expense = await getAllCategories()
    expect(expense.map((c) => c.id)).toEqual(
      expect.arrayContaining([own.id, ids.server.id, ids.euro.id, ids.plain.id]),
    )
    expect(expense.find((c) => c.id === ids.server.id)?.defaultCurrency).toBe('USD')
    expect(expense.find((c) => c.id === ids.euro.id)?.defaultCurrency).toBe('EUR')
    expect(expense.find((c) => c.id === own.id)?.defaultCurrency).toBeUndefined()
    const income = await getAllIncomeCategories()
    expect(income.find((c) => c.id === ids.freelance.id)?.defaultCurrency).toBe('USD')
  })

  it('the parsed backup file is accepted (the field does not fail validation)', async () => {
    await createVault(PW)
    await seedCategories()
    const text = serializeBackup(await createBackup())

    const parsed = parseBackupFile(text)

    expect(parsed.version).toBe(1)
  })

  it('a default currency set after the backup is replaced by the backup in replace mode', async () => {
    await createVault(PW)
    const ids = await seedCategories()
    const text = serializeBackup(await createBackup())
    await updateCategory({
      id: ids.server.id,
      name: 'Server Costs',
      icon: '🖥️',
      defaultCurrency: 'EUR',
    })
    await updateCategory({
      id: ids.euro.id,
      name: 'Trips',
      defaultCurrency: null,
    })

    await restoreBackup(text, PW, 'replace')

    const after = await getAllCategories()
    expect(after.find((c) => c.id === ids.server.id)?.defaultCurrency).toBe('USD')
    expect(after.find((c) => c.id === ids.euro.id)?.defaultCurrency).toBe('EUR')
  })
})
