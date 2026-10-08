// No CONTRACT_GAPs: lastDataChangeAt behaviour is specified in the Interface
// Contract (module: localDb additions).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addCategory,
  addExpense,
  addIncome,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  expenseChunkKey,
  getAllBudgets,
  provisionDefaultCategories,
  quarantineKey,
  unlockLocalDb,
  updateCategory,
  updateExpense,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { failSettingsWrite: false },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    if (ctl.failSettingsWrite && key === 'meta:settings') {
      return Promise.reject(new Error('settings write failed'))
    }
    mockStore.set(key, value)
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

const T1 = '2026-06-01T10:00:00.000Z'
const T2 = '2026-06-02T11:30:00.000Z'
const T3 = '2026-06-03T12:45:00.000Z'

function changedAt(): unknown {
  return (mockStore.get('meta:settings') as { lastDataChangeAt?: unknown } | undefined)
    ?.lastDataChangeAt
}

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

beforeEach(async () => {
  mockStore.clear()
  ctl.failSettingsWrite = false
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
  unlockLocalDb(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('expenseChunkKey export', () => {
  it('maps a date to its UTC month chunk', () => {
    expect(expenseChunkKey('2026-03-15T10:00:00.000Z')).toBe('expenses_2026_03')
    expect(expenseChunkKey('2025-12-31T23:59:59.000Z')).toBe('expenses_2025_12')
  })
})

describe('lastDataChangeAt is set after every committed mutation', () => {
  it('addCategory', async () => {
    expect(changedAt()).toBeUndefined()

    await addCategory({ name: 'Food' })

    expect(changedAt()).toBe(T1)
  })

  it('moves forward with each later mutation', async () => {
    await addCategory({ name: 'Food' })
    expect(changedAt()).toBe(T1)

    setNow(T2)
    await addCategory({ name: 'Taxi' })
    expect(changedAt()).toBe(T2)

    setNow(T3)
    await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })
    expect(changedAt()).toBe(T3)
  })

  it('updateCategory', async () => {
    const cat = await addCategory({ name: 'Food' })

    setNow(T2)
    await updateCategory({ id: cat.id, name: 'Meals' })

    expect(changedAt()).toBe(T2)
  })

  it('deleteCategory', async () => {
    const cat = await addCategory({ name: 'Food' })

    setNow(T2)
    await deleteCategory(cat.id)

    expect(changedAt()).toBe(T2)
  })

  it('addExpense', async () => {
    const cat = await addCategory({ name: 'Food' })

    setNow(T2)
    await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: T1,
    })

    expect(changedAt()).toBe(T2)
  })

  it('updateExpense', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: T1,
    })

    setNow(T2)
    await updateExpense(e.id, e.createdAt, { amount: 6 })

    expect(changedAt()).toBe(T2)
  })

  it('deleteExpense', async () => {
    const cat = await addCategory({ name: 'Food' })
    const e = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: T1,
    })

    setNow(T3)
    await deleteExpense(e.id, e.createdAt)

    expect(changedAt()).toBe(T3)
  })

  it('addIncome', async () => {
    await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })

    expect(changedAt()).toBe(T1)
  })

  it('deleteIncome', async () => {
    const inc = await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })

    setNow(T2)
    await deleteIncome(inc.id)

    expect(changedAt()).toBe(T2)
  })

  it('upsertBudget', async () => {
    const cat = await addCategory({ name: 'Food' })

    setNow(T2)
    await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 100,
      currency: 'UAH',
    })

    expect(changedAt()).toBe(T2)
  })

  it('deleteBudget', async () => {
    const cat = await addCategory({ name: 'Food' })
    const budget = await upsertBudget({
      categoryId: cat.id,
      monthlyLimit: 100,
      currency: 'UAH',
    })

    setNow(T3)
    await deleteBudget(budget.id)

    expect(changedAt()).toBe(T3)
    expect(await getAllBudgets()).toEqual([])
  })

  it('provisionDefaultCategories, when it wrote', async () => {
    await provisionDefaultCategories()

    expect(changedAt()).toBe(T1)
  })

  it('provisionDefaultCategories does not mark a change when it wrote nothing', async () => {
    await provisionDefaultCategories()
    expect(changedAt()).toBe(T1)

    setNow(T2)
    await provisionDefaultCategories()

    expect(changedAt()).toBe(T1)
  })
})

describe('lastDataChangeAt merges into meta:settings', () => {
  it('keeps the other settings fields', async () => {
    mockStore.set('meta:settings', {
      autoLockMinutes: 5,
      failedUnlockAttempts: 2,
      backupReminderDays: 30,
      lastBackupAt: '2026-05-01T00:00:00.000Z',
    })

    await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })

    expect(mockStore.get('meta:settings')).toEqual({
      autoLockMinutes: 5,
      failedUnlockAttempts: 2,
      backupReminderDays: 30,
      lastBackupAt: '2026-05-01T00:00:00.000Z',
      lastDataChangeAt: T1,
    })
  })

  it('is complete by the time the mutation promise resolves', async () => {
    const pending = addCategory({ name: 'Food' })
    await pending

    expect(changedAt()).toBe(T1)
  })
})

describe('lastDataChangeAt is not set when nothing committed', () => {
  it('a mutation that throws does not set it', async () => {
    await addCategory({ name: 'Food' })
    setNow(T2)

    await expect(addCategory({ name: 'food' })).rejects.toThrow(
      'already exists',
    )

    expect(changedAt()).toBe(T1)
  })

  it('updateExpense on a missing expense does not set it', async () => {
    await addCategory({ name: 'Food' })
    setNow(T2)

    await expect(
      updateExpense('missing-id', T1, { amount: 1 }),
    ).rejects.toThrow()

    expect(changedAt()).toBe(T1)
  })

  it('a DecryptError on the underlying blob does not set it', async () => {
    mockStore.set('income', crypto.getRandomValues(new Uint8Array(64)))

    await expect(
      addIncome({ source: 'Job', amount: 5, currency: 'UAH' }),
    ).rejects.toThrow()

    expect(changedAt()).toBeUndefined()
  })

  it('quarantineKey is not a data change', async () => {
    await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })
    expect(changedAt()).toBe(T1)

    setNow(T2)
    const target = await quarantineKey('income')

    expect(target).not.toBeNull()
    expect(changedAt()).toBe(T1)
  })
})

describe('a failed lastDataChangeAt write', () => {
  it('does not fail the mutation, and is logged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctl.failSettingsWrite = true

    const created = await addIncome({
      source: 'Job',
      amount: 5,
      currency: 'UAH',
    })

    expect(created.source).toBe('Job')
    expect(errorSpy).toHaveBeenCalled()
    expect(changedAt()).toBeUndefined()
    expect(mockStore.get('income')).toBeInstanceOf(Uint8Array)
  })
})
