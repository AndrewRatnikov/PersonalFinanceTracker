// No CONTRACT_GAPs: BackupPayload.incomeCategories, RestoreSummary.incomeCategories
// and the legacy conversion are fully specified in the Interface Contract
// (module: backup).
//
// Integration style (as backup.test.ts): real crypto, real vault, real localDb,
// idb-keyval backed by a Map. A "pre-change" backup is made by taking a new
// backup, decrypting the payload, deleting incomeCategories, replacing the
// income with legacy records (source, no categoryId) and re-encrypting with
// the device DEK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupPayload, MinimaBackupV1 } from '@/lib/backup'
import type { IncomeEntry } from '@/lib/domain'
import {
  BackupError,
  createBackup,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import {
  base64ToBytes,
  bytesToBase64,
  decryptValue,
  encryptValue,
} from '@/lib/crypto'
import {
  addIncome,
  addIncomeCategory,
  ensureIncomeCategories,
  getAllIncome,
  getAllIncomeCategories,
  getLocalDbKey,
  updateIncomeCategory,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import {
  createVault,
  lockVault,
  openHeaderWithSecret,
} from '@/lib/vault'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    failSetMany: false,
    setManyCalls: [] as Array<Array<string>>,
  },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    ctl.setManyCalls.push(entries.map(([key]) => key))
    if (ctl.failSetMany) return Promise.reject(new Error('transaction aborted'))
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

const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const T3 = '2026-03-03T10:00:00.000Z'
const OLD = '2026-01-05T08:00:00.000Z'

const DEFAULT_NAMES = [
  'Salary',
  'Freelance',
  'Gifts',
  'Investments',
  'Refunds',
  'Other',
]

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

// Sources Salary / " salary " / Upwork / "" as written before this change.
function legacyIncome(): Array<IncomeEntry> {
  const rows = [
    { id: 'li1', source: 'Salary', amount: 1000, createdAt: '2026-02-01T09:00:00.000Z' },
    { id: 'li2', source: ' salary ', amount: 250, createdAt: '2026-02-02T09:00:00.000Z' },
    { id: 'li3', source: 'Upwork', amount: 75, createdAt: '2026-02-03T09:00:00.000Z' },
    { id: 'li4', source: '', amount: 5, createdAt: '2026-02-04T09:00:00.000Z' },
  ]
  return rows.map((r) => ({
    ...r,
    currency: 'UAH',
    updatedAt: OLD,
  })) as unknown as Array<IncomeEntry>
}

function legacyPayload(payload: BackupPayload) {
  delete payload.incomeCategories
  payload.income = legacyIncome()
}

async function categoryNames(): Promise<Array<string>> {
  return (await getAllIncomeCategories()).map((c) => c.name).sort()
}

async function incomeCategoryByEntry(): Promise<Map<string, string | undefined>> {
  return new Map((await getAllIncome()).map((i) => [i.id, i.category?.name]))
}

async function storedIncome(): Promise<Array<Record<string, unknown>>> {
  const dek = getLocalDbKey()
  const raw = mockStore.get('income')
  if (!dek || !(raw instanceof Uint8Array)) throw new Error('no income stored')
  return (await decryptValue(dek, raw)) as Array<Record<string, unknown>>
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
  ctl.failSetMany = false
  ctl.setManyCalls.length = 0
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a backup made now round-trips incomeCategories and income.categoryId', () => {
  it('backup, remove all data, restore: same categories, same categoryIds, same names', async () => {
    await createVault(PW)
    const salary = await addIncomeCategory({ name: 'Salary', icon: '💼' })
    const gifts = await addIncomeCategory({ name: 'Gifts' })
    await addIncome({
      categoryId: salary.id,
      amount: 1000,
      currency: 'USD',
      createdAt: '2026-02-01T09:15:00.000Z',
    })
    await addIncome({
      categoryId: gifts.id,
      amount: 20,
      currency: 'EUR',
      createdAt: '2026-02-02T09:15:00.000Z',
    })
    const categoriesBefore = await getAllIncomeCategories()
    const incomeBefore = (await getAllIncome()).map((i) => ({
      id: i.id,
      categoryId: i.categoryId,
      amount: i.amount,
      createdAt: i.createdAt,
    }))
    const text = serializeBackup(await createBackup())
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.incomeCategories).toBe(2)
    expect(summary.income).toBe(2)
    expect(await getAllIncomeCategories()).toEqual(categoriesBefore)
    const incomeAfter = await getAllIncome()
    expect(
      incomeAfter.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        amount: i.amount,
        createdAt: i.createdAt,
      })),
    ).toEqual(incomeBefore)
    expect(incomeAfter.map((i) => i.category?.name).sort()).toEqual([
      'Gifts',
      'Salary',
    ])
    // Nothing was converted: the restored records are the backup's records.
    expect(
      (await storedIncome()).every((r) => !('source' in r) && r.updatedAt === T1),
    ).toBe(true)
  })

  it('does not add default categories to a payload that carries incomeCategories', async () => {
    await createVault(PW)
    await addIncomeCategory({ name: 'Only' })
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    expect(await categoryNames()).toEqual(['Only'])
  })

  it('an empty incomeCategories list in the backup replaces the local list with an empty one', async () => {
    await createVault(PW)
    const text = serializeBackup(await createBackup())
    await addIncomeCategory({ name: 'Local only' })

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.incomeCategories).toBe(0)
    expect(await getAllIncomeCategories()).toEqual([])
  })
})

describe('a payload from before this change restores into categories', () => {
  it('replace on an empty device creates the categories from the sources and adds the defaults', async () => {
    await createVault(PW)
    const text = await rebuildBackup(legacyPayload)
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(await categoryNames()).toEqual(
      [...DEFAULT_NAMES, 'Upwork'].sort(),
    )
    const categories = await getAllIncomeCategories()
    expect(categories.filter((c) => c.name === 'Salary')).toHaveLength(1)
    // Created from a source: no icon. A default keeps its icon.
    expect(categories.find((c) => c.name === 'Salary')?.icon).toBeNull()
    expect(categories.find((c) => c.name === 'Upwork')?.icon).toBeNull()
    expect(categories.find((c) => c.name === 'Freelance')?.icon).toBe('💻')
    expect(summary.incomeCategories).toBe(7)
    expect(summary.income).toBe(4)
    const byEntry = await incomeCategoryByEntry()
    expect(byEntry.get('li1')).toBe('Salary')
    expect(byEntry.get('li2')).toBe('Salary')
    expect(byEntry.get('li3')).toBe('Upwork')
    expect(byEntry.get('li4')).toBe('Other')
  })

  it('keeps the amounts, dates and the backup updatedAt, and drops source', async () => {
    await createVault(PW)
    const text = await rebuildBackup(legacyPayload)
    wipe()
    setNow(T3)

    await restoreBackup(text, PW, 'replace')

    const stored = await storedIncome()
    expect(stored).toHaveLength(4)
    const li2 = stored.find((r) => r.id === 'li2')
    expect(li2?.amount).toBe(250)
    expect(li2?.createdAt).toBe('2026-02-02T09:00:00.000Z')
    expect(li2?.updatedAt).toBe(OLD)
    for (const record of stored) expect('source' in record).toBe(false)
  })

  it('replace over an existing device converts the same way and writes everything in one setMany', async () => {
    await createVault(PW)
    await addIncomeCategory({ name: 'Stale' })
    const text = await rebuildBackup(legacyPayload)
    ctl.setManyCalls.length = 0

    const summary = await restoreBackup(text, PW, 'replace')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(
      expect.arrayContaining(['income', 'incomeCategories']),
    )
    expect(summary.mode).toBe('replace')
    expect(await categoryNames()).not.toContain('Stale')
    expect((await incomeCategoryByEntry()).get('li3')).toBe('Upwork')
  })

  it('merge into a device that already has income categories reuses them and adds only the new source', async () => {
    await createVault(PW)
    await ensureIncomeCategories()
    const before = await getAllIncomeCategories()
    const localSalary = before.find((c) => c.name === 'Salary')
    const localOther = before.find((c) => c.name === 'Other')
    const text = await rebuildBackup(legacyPayload)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.mode).toBe('merge')
    expect(summary.income).toBe(4)
    expect(summary.incomeCategories).toBe(1)
    expect(await categoryNames()).toEqual([...DEFAULT_NAMES, 'Upwork'].sort())
    const after = await getAllIncomeCategories()
    expect(after.find((c) => c.name === 'Salary')?.id).toBe(localSalary?.id)
    expect(after.find((c) => c.name === 'Other')?.id).toBe(localOther?.id)
    const income = await getAllIncome()
    expect(income.find((i) => i.id === 'li1')?.categoryId).toBe(localSalary?.id)
    expect(income.find((i) => i.id === 'li2')?.categoryId).toBe(localSalary?.id)
    expect(income.find((i) => i.id === 'li4')?.categoryId).toBe(localOther?.id)
    expect((await incomeCategoryByEntry()).get('li3')).toBe('Upwork')
  })

  it('merging the same legacy backup twice adds nothing the second time', async () => {
    await createVault(PW)
    await ensureIncomeCategories()
    const text = await rebuildBackup(legacyPayload)
    const first = await restoreBackup(text, PW, 'merge')
    expect(first.added).toBeGreaterThan(0)
    const incomeBlob = mockStore.get('income')
    const categoriesBlob = mockStore.get('incomeCategories')
    ctl.setManyCalls.length = 0
    setNow(T3)

    const second = await restoreBackup(text, PW, 'merge')

    expect(second).toMatchObject({
      added: 0,
      updated: 0,
      conflicts: 0,
      income: 0,
      incomeCategories: 0,
    })
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(mockStore.get('income')).toBe(incomeBlob)
    expect(mockStore.get('incomeCategories')).toBe(categoriesBlob)
    expect(await categoryNames()).toEqual([...DEFAULT_NAMES, 'Upwork'].sort())
  })

  it('a merge does not overwrite a local edit of a converted record', async () => {
    await createVault(PW)
    await ensureIncomeCategories()
    const text = await rebuildBackup(legacyPayload)
    await restoreBackup(text, PW, 'merge')
    const gifts = (await getAllIncomeCategories()).find((c) => c.name === 'Gifts')
    if (!gifts) throw new Error('expected the Gifts default')
    // The user re-categorises li3 locally (newer than the backup's updatedAt).
    const dek = getLocalDbKey()
    if (!dek) throw new Error('expected an unlocked vault')
    const stored = await storedIncome()
    const edited = stored.map((r) =>
      r.id === 'li3' ? { ...r, categoryId: gifts.id, updatedAt: T2 } : r,
    )
    mockStore.set('income', await encryptValue(dek, edited))
    setNow(T3)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.income).toBe(0)
    expect((await incomeCategoryByEntry()).get('li3')).toBe('Gifts')
  })

  it('a backup of an unconverted vault (empty incomeCategories plus legacy income) converts on restore', async () => {
    await createVault(PW)
    const dek = getLocalDbKey()
    if (!dek) throw new Error('expected an unlocked vault')
    // A vault that has not been through ensureIncomeCategories yet.
    mockStore.set('income', await encryptValue(dek, legacyIncome()))
    const backup = await createBackup()
    const payload = await readPayload(backup)
    expect(payload.incomeCategories).toEqual([])
    expect(payload.income).toHaveLength(4)
    expect('categoryId' in payload.income[0]).toBe(false)
    const text = serializeBackup(backup)
    wipe()

    await restoreBackup(text, PW, 'replace')

    // Sources, plus Other for the empty source; no defaults for this payload.
    expect(await categoryNames()).toEqual(['Other', 'Salary', 'Upwork'])
    const byEntry = await incomeCategoryByEntry()
    expect([...byEntry.values()].every((name) => name !== undefined)).toBe(true)
    expect(byEntry.get('li2')).toBe('Salary')
    expect(byEntry.get('li4')).toBe('Other')
  })

  it('a restore that wrote anything leaves the vault with an incomeCategories key', async () => {
    await createVault(PW)
    const text = await rebuildBackup(legacyPayload)
    wipe()

    await restoreBackup(text, PW, 'replace')

    expect(mockStore.get('incomeCategories')).toBeInstanceOf(Uint8Array)
    expect(await getAllIncomeCategories()).not.toEqual([])
  })
})

describe('merging a new backup', () => {
  async function backupWithIncome() {
    await createVault(PW)
    const salary = await addIncomeCategory({ name: 'Salary', icon: '💼' })
    const gifts = await addIncomeCategory({ name: 'Gifts', icon: '🎁' })
    await addIncome({
      categoryId: salary.id,
      amount: 1000,
      currency: 'USD',
      createdAt: '2026-02-01T09:15:00.000Z',
    })
    await addIncome({
      categoryId: gifts.id,
      amount: 20,
      currency: 'EUR',
      createdAt: '2026-02-02T09:15:00.000Z',
    })
    return { text: serializeBackup(await createBackup()), salary, gifts }
  }

  it('upserts income categories by id and income with their categoryId', async () => {
    const { text, salary, gifts } = await backupWithIncome()
    wipe()
    await createVault(PW2)
    const own = await addIncomeCategory({ name: 'Own' })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.incomeCategories).toBe(2)
    expect(summary.income).toBe(2)
    const ids = (await getAllIncomeCategories()).map((c) => c.id).sort()
    expect(ids).toEqual([own.id, salary.id, gifts.id].sort())
    const income = await getAllIncome()
    expect(income.map((i) => i.category?.name).sort()).toEqual(['Gifts', 'Salary'])
  })

  it('merging the same new backup twice adds nothing the second time', async () => {
    const { text } = await backupWithIncome()
    wipe()
    await createVault(PW2)
    await ensureIncomeCategories()
    const first = await restoreBackup(text, PW, 'merge')
    expect(first.added).toBe(4)
    const afterFirst = {
      categories: await getAllIncomeCategories(),
      income: (await getAllIncome()).map((i) => i.id).sort(),
    }
    ctl.setManyCalls.length = 0
    setNow(T3)

    const second = await restoreBackup(text, PW, 'merge')

    expect(second).toMatchObject({
      added: 0,
      updated: 0,
      conflicts: 0,
      income: 0,
      incomeCategories: 0,
    })
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(await getAllIncomeCategories()).toEqual(afterFirst.categories)
    expect((await getAllIncome()).map((i) => i.id).sort()).toEqual(
      afterFirst.income,
    )
  })

  it('keeps a newer local income category over an older backup record', async () => {
    await createVault(PW)
    const cat = await addIncomeCategory({ name: 'Salary' })
    const text = serializeBackup(await createBackup())
    setNow(T2)
    await updateIncomeCategory({ id: cat.id, name: 'Wages' })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.incomeCategories).toBe(0)
    expect((await getAllIncomeCategories())[0].name).toBe('Wages')
  })

  it('takes a strictly newer backup record over an older local one', async () => {
    await createVault(PW)
    const cat = await addIncomeCategory({ name: 'Salary' })
    const olderLocal = mockStore.get('incomeCategories')
    setNow(T2)
    await updateIncomeCategory({ id: cat.id, name: 'Wages' })
    const text = serializeBackup(await createBackup())
    // Back to the state before the rename: the backup is newer.
    mockStore.set('incomeCategories', olderLocal)
    expect((await getAllIncomeCategories())[0].name).toBe('Salary')

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.incomeCategories).toBe(1)
    expect(summary.updated).toBe(1)
    expect((await getAllIncomeCategories())[0]).toMatchObject({
      id: cat.id,
      name: 'Wages',
      updatedAt: T2,
    })
  })
})

describe('validation of an incomeCategories payload field', () => {
  it('rejects a payload whose incomeCategories is not a list of records and writes nothing', async () => {
    await createVault(PW)
    const text = await rebuildBackup((payload) => {
      Reflect.set(payload, 'incomeCategories', [{ name: 'no id' }])
    })
    wipe()

    const err = await restoreBackup(text, PW, 'replace').then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(BackupError)
    expect((err as BackupError).code).toBe('invalid-file')
    expect(mockStore.size).toBe(0)
  })

  it('rejects incomeCategories that is not an array', async () => {
    await createVault(PW)
    const text = await rebuildBackup((payload) => {
      Reflect.set(payload, 'incomeCategories', 'nope')
    })
    wipe()

    await expect(restoreBackup(text, PW, 'replace')).rejects.toMatchObject({
      code: 'invalid-file',
    })
    expect(mockStore.size).toBe(0)
  })

  it('accepts a payload without the field at all (a pre-change backup)', async () => {
    await createVault(PW)
    const text = await rebuildBackup((payload) => {
      delete payload.incomeCategories
    })
    wipe()

    await expect(restoreBackup(text, PW, 'replace')).resolves.toMatchObject({
      mode: 'replace',
    })
  })
})
