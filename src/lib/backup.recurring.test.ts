// No CONTRACT_GAPs: BackupPayload.recurring, replace/merge handling and the
// unchanged RestoreSummary are specified in the Interface Contract (module:
// backup) and plan section 6. Because RestoreSummary has no recurring field,
// merge outcomes are checked through the stored items and through the generic
// added / updated counters (>= 1), not through an exact count.
//
// Integration style (as backup.incomeCategories.test.ts): real crypto, real
// vault, real localDb, idb-keyval backed by a Map.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupPayload, MinimaBackupV1 } from '@/lib/backup'
import type { CreateRecurringInput, RecurringItem } from '@/lib/domain'
import {
  BackupError,
  createBackup,
  defaultRestoreMode,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import { base64ToBytes, bytesToBase64 } from '@/lib/crypto'
import {
  addCategory,
  addRecurring,
  getAllExpenses,
  getAllRecurring,
  getLocalDbKey,
  processDueRecurring,
  updateRecurring,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import { createVault, lockVault, openHeaderWithSecret } from '@/lib/vault'

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

const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const T3 = '2026-03-03T10:00:00.000Z'
// Local date of the generated schedule: explicit, so no clock dependence.
const TODAY = '2026-03-01'

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

function wipe() {
  lockVault()
  mockStore.clear()
}

async function readPayload(backup: MinimaBackupV1): Promise<BackupPayload> {
  const dek = await openHeaderWithSecret(backup.vault, PW)
  if (!dek) throw new Error('the secret did not open the backup')
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(backup.payload.iv) },
      dek,
      base64ToBytes(backup.payload.ct),
    ),
  )
  let bytes = plain
  if (backup.payload.enc === 'gzip+aes-gcm') {
    const body = new Response(plain).body
    if (!body) throw new Error('no body')
    bytes = new Uint8Array(
      await new Response(
        body.pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer(),
    )
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as BackupPayload
}

// Re-encrypts an edited payload with the unlocked device DEK (plain aes-gcm).
async function rebuildBackup(
  mutate: (payload: BackupPayload) => void,
): Promise<string> {
  const backup = await createBackup()
  const payload = await readPayload(backup)
  mutate(payload)
  const dek = getLocalDbKey()
  if (!dek) throw new Error('expected an unlocked vault')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      dek,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  )
  return serializeBackup({
    ...backup,
    payload: { enc: 'aes-gcm', iv: bytesToBase64(iv), ct: bytesToBase64(ct) },
  })
}

function monthlyInput(categoryId: string): CreateRecurringInput {
  return {
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId,
    description: 'Gym',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-01-01',
    end: { type: 'never' },
    mode: 'auto',
  }
}

// A vault with one expense category, one monthly item and its 3 generated
// expenses (Jan 1, Feb 1, Mar 1).
async function vaultWithGeneratedItem() {
  await createVault(PW)
  const category = await addCategory({ name: 'Gym' })
  const item = await addRecurring(monthlyInput(category.id), {
    createThroughToday: true,
    today: TODAY,
  })
  return { category, item }
}

function extraItem(categoryId: string): RecurringItem {
  return {
    id: 'extra',
    kind: 'expense',
    amount: 15,
    currency: 'USD',
    categoryId,
    description: 'From the backup',
    frequency: { unit: 'week', interval: 2 },
    startDate: '2026-03-01',
    end: { type: 'never' },
    mode: 'ask',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: T1,
    updatedAt: T1,
  }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createBackup carries recurring', () => {
  it('writes the stored items into the payload', async () => {
    const { item } = await vaultWithGeneratedItem()

    const payload = await readPayload(await createBackup())

    expect(payload.recurring).toEqual([item])
    expect(payload.schemaVersion).toBe(1)
  })

  it('writes an empty list when there are no items', async () => {
    await createVault(PW)

    const payload = await readPayload(await createBackup())

    expect(payload.recurring).toEqual([])
  })

  it('keeps the backup version at 1', async () => {
    await createVault(PW)

    const backup = await createBackup()

    expect(backup.version).toBe(1)
  })
})

describe('replace restore', () => {
  it('round-trips items and the generated records', async () => {
    const { item } = await vaultWithGeneratedItem()
    const expensesBefore = (await getAllExpenses()).map((e) => e.id).sort()
    const text = serializeBackup(await createBackup())
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.mode).toBe('replace')
    expect(await getAllRecurring()).toEqual([item])
    expect((await getAllExpenses()).map((e) => e.id).sort()).toEqual(expensesBefore)
    expect(expensesBefore).toHaveLength(3)
  })

  it('after restoring a backup whose generated records exist, processDueRecurring creates no duplicates', async () => {
    await vaultWithGeneratedItem()
    const text = serializeBackup(await createBackup())
    wipe()
    await restoreBackup(text, PW, 'replace')

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 0, itemsTouched: 0 })
    expect(await getAllExpenses()).toHaveLength(3)
  })

  it('an item restored with an older handledThrough does not duplicate the records that exist', async () => {
    await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      const [first] = payload.recurring ?? []
      first.handledThrough = null
      first.occurrenceCount = 0
    })
    wipe()
    await restoreBackup(text, PW, 'replace')

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(0)
    expect(await getAllExpenses()).toHaveLength(3)
    const [item] = await getAllRecurring()
    expect(item.handledThrough).toBe(TODAY)
  })

  it('the restore itself generates nothing; the next processDueRecurring does', async () => {
    await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      payload.expenses = []
      const [first] = payload.recurring ?? []
      first.handledThrough = null
      first.occurrenceCount = 0
    })
    wipe()

    await restoreBackup(text, PW, 'replace')

    expect(await getAllExpenses()).toHaveLength(0)
    const result = await processDueRecurring(TODAY)
    expect(result.created).toBe(3)
    expect(await getAllExpenses()).toHaveLength(3)
  })

  it('replaces the local items with the backup items', async () => {
    const { category, item } = await vaultWithGeneratedItem()
    const text = serializeBackup(await createBackup())
    await addRecurring(
      { ...monthlyInput(category.id), description: 'Local only' },
      { createThroughToday: false, today: TODAY },
    )
    expect(await getAllRecurring()).toHaveLength(2)

    await restoreBackup(text, PW, 'replace')

    expect((await getAllRecurring()).map((i) => i.id)).toEqual([item.id])
  })
})

describe('a backup made before this change (no recurring field)', () => {
  it('restores onto an empty device and leaves no items', async () => {
    await createVault(PW)
    await addCategory({ name: 'Gym' })
    const text = await rebuildBackup((payload) => {
      delete payload.recurring
    })
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.mode).toBe('replace')
    expect(await getAllRecurring()).toEqual([])
  })

  it('replace over a device with items writes an empty recurring list', async () => {
    const { category } = await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      delete payload.recurring
    })
    await addRecurring(
      { ...monthlyInput(category.id), description: 'Added later' },
      { createThroughToday: false, today: TODAY },
    )

    await restoreBackup(text, PW, 'replace')

    expect(await getAllRecurring()).toEqual([])
  })

  it('merge keeps the local items', async () => {
    const { item } = await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      delete payload.recurring
    })

    await restoreBackup(text, PW, 'merge')

    expect(await getAllRecurring()).toEqual([item])
  })
})

describe('merge restore', () => {
  it('adds an item that only the backup has and keeps the local one', async () => {
    const { category, item } = await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      payload.recurring = [...(payload.recurring ?? []), extraItem(category.id)]
    })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.mode).toBe('merge')
    expect(summary.added).toBeGreaterThanOrEqual(1)
    const items = await getAllRecurring()
    expect(items.map((i) => i.id).sort()).toEqual(['extra', item.id].sort())
    expect(items.find((i) => i.id === 'extra')?.amount).toBe(15)
  })

  it('the newer updatedAt wins: the backup copy replaces an older local item', async () => {
    const { item } = await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      const [first] = payload.recurring ?? []
      first.amount = 777
      first.updatedAt = T3
    })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.updated).toBeGreaterThanOrEqual(1)
    const [restored] = await getAllRecurring()
    expect(restored.id).toBe(item.id)
    expect(restored.amount).toBe(777)
    expect(restored.updatedAt).toBe(T3)
  })

  it('the newer updatedAt wins: a newer local item is kept', async () => {
    const { item } = await vaultWithGeneratedItem()
    const text = serializeBackup(await createBackup())
    setNow(T2)
    await updateRecurring(item.id, { amount: 999 })

    await restoreBackup(text, PW, 'merge')

    const [kept] = await getAllRecurring()
    expect(kept.amount).toBe(999)
    expect(kept.updatedAt).toBe(T2)
  })

  it('merging the same backup into the same device creates no duplicates after the next run', async () => {
    const { item } = await vaultWithGeneratedItem()
    const text = serializeBackup(await createBackup())

    await restoreBackup(text, PW, 'merge')
    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 0, itemsTouched: 0 })
    expect(await getAllExpenses()).toHaveLength(3)
    expect((await getAllRecurring()).map((i) => i.id)).toEqual([item.id])
  })
})

describe('validation of the recurring field', () => {
  it('rejects a recurring field that is not a list of records', async () => {
    await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      Object.assign(payload, { recurring: 'oops' })
    })

    await expect(restoreBackup(text, PW, 'merge')).rejects.toBeInstanceOf(
      BackupError,
    )
  })

  it('rejects a recurring list with an entry that has no id', async () => {
    await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      Object.assign(payload, { recurring: [{ amount: 5 }] })
    })

    await expect(restoreBackup(text, PW, 'replace')).rejects.toBeInstanceOf(
      BackupError,
    )
  })

  it('a rejected restore leaves the local items untouched', async () => {
    const { item } = await vaultWithGeneratedItem()
    const text = await rebuildBackup((payload) => {
      Object.assign(payload, { recurring: 'oops' })
    })

    await expect(restoreBackup(text, PW, 'replace')).rejects.toThrow()

    expect(await getAllRecurring()).toEqual([item])
  })
})

describe('defaultRestoreMode', () => {
  it('is merge when the device holds a recurring item, even with nothing else', async () => {
    await createVault(PW)
    const category = await addCategory({ name: 'Gym' })
    await addRecurring(monthlyInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })

    expect(await defaultRestoreMode()).toBe('merge')
  })

  it('is replace on a device with no data', async () => {
    await createVault(PW)
    await addCategory({ name: 'Gym' })

    expect(await defaultRestoreMode()).toBe('replace')
  })
})
