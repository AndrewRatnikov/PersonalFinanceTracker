// CONTRACT_GAP: the Family settings block of a SpaceBackupPayload is only
//   asserted for mainCurrency and fetchExchangeRates (the contract lists
//   exactly these two optional fields).
// CONTRACT_GAP: the BackupError code for a malformed identity / spaceKeys /
//   spaces field is taken from the plan ("invalid-file").
//
// Integration style (as backup.recurring.test.ts): real crypto, real vault,
// real localDb, idb-keyval backed by a Map. Backups are opened with the
// password, edited, and re-encrypted with the unlocked DEK to simulate other
// payloads (an old backup, a backup without the space key, a foreign
// identity).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupPayload, MinimaBackupV1 } from '@/lib/backup'
import type { Expense } from '@/lib/domain'
import {
  BACKUP_VERSION,
  BackupError,
  createBackup,
  defaultRestoreMode,
  parseBackupFile,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import { base64ToBytes, bytesToBase64, decryptValue } from '@/lib/crypto'
import { isDecryptError } from '@/lib/dataErrors'
import {
  addCategory,
  addExpense,
  createLocalSpace,
  deleteExpense,
  ensureIdentityKeyPair,
  getAllExpenses,
  getLocalDbKey,
  listLocalSpaces,
  spaceDb,
} from '@/lib/localDb'
import { generateIdentityKeyPair, importSpaceKey } from '@/lib/spaces/spaceCrypto'
import { setSyncChannel } from '@/lib/syncChannel'
import { createVault, lockVault, openHeaderWithSecret } from '@/lib/vault'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { setManyCalls: [] as Array<Array<string>> },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  getMany: (list: Array<string>) => Promise.resolve(list.map((k) => mockStore.get(k))),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    ctl.setManyCalls.push(entries.map(([key]) => key))
    for (const [key, value] of entries) mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    mockStore.delete(key)
    return Promise.resolve()
  },
  delMany: (list: Array<string>) => {
    for (const key of list) mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue(null),
}))

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const PW = 'correct horse battery'
const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const T3 = '2026-03-03T10:00:00.000Z'
const MARCH = '2026-03-10T12:00:00.000Z'
const MARCH_CHUNK = 'expenses_2026_03'
const OLD_PAYLOAD_KEYS = [
  'budgets',
  'categories',
  'expenses',
  'income',
  'incomeCategories',
  'recurring',
  'schemaVersion',
  'settings',
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
      await new Response(body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
    )
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as BackupPayload
}

// Re-encrypts an edited payload with the unlocked device DEK (plain aes-gcm).
async function rebuildBackup(mutate: (payload: BackupPayload) => void): Promise<string> {
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

function loose(payload: BackupPayload): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>
}

// A vault with a personal expense, an identity and a Family space holding two
// live expenses and one deleted one.
async function deviceWithFamily() {
  await createVault(PW)
  const category = await addCategory({ name: 'Food' })
  const personal = await addExpense({
    amount: 11,
    currency: 'UAH',
    categoryId: category.id,
    description: 'personal',
    createdAt: MARCH,
  })
  const identity = await ensureIdentityKeyPair()
  const space = await createLocalSpace({ name: 'Our home', lang: 'en' })
  const fam = spaceDb(space.id)
  const familyCategory = (await fam.getAllCategories())[0]
  const add = (amount: number, description: string) =>
    fam.addExpense({
      amount,
      currency: 'UAH',
      categoryId: familyCategory.id,
      description,
      createdAt: MARCH,
    })
  const kept = await add(500, 'family one')
  const second = await add(600, 'family two')
  const gone = await add(700, 'family gone')
  await fam.deleteExpense(gone.id, gone.createdAt)
  return { category, personal, identity, space, fam, kept, second, gone, familyCategory }
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
  lockVault()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('createBackup without spaces', () => {
  it('has exactly today’s payload shape: no identity, spaceKeys or spaces', async () => {
    await createVault(PW)
    await addCategory({ name: 'Food' })

    const backup = await createBackup()
    const payload = await readPayload(backup)

    expect(backup.version).toBe(1)
    expect(BACKUP_VERSION).toBe(1)
    expect(Object.keys(payload).sort()).toEqual(OLD_PAYLOAD_KEYS)
  })

  it('carries the identity when the device has one, but no spaceKeys or spaces key', async () => {
    await createVault(PW)
    const identity = await ensureIdentityKeyPair()

    const payload = await readPayload(await createBackup())

    expect(payload.identity?.publicKeyJwk).toEqual(identity.publicKeyJwk)
    expect(payload.identity?.privateKeyJwk).toEqual(identity.privateKeyJwk)
    expect(payload).not.toHaveProperty('spaceKeys')
    expect(payload).not.toHaveProperty('spaces')
  })
})

describe('createBackup with a Family space', () => {
  it('carries identity, spaceKeys and a spaces entry for the held space', async () => {
    const { space, identity } = await deviceWithFamily()

    const payload = await readPayload(await createBackup())

    expect(payload.identity?.id).toBe('identity')
    expect(payload.identity?.publicKeyJwk).toEqual(identity.publicKeyJwk)
    expect(payload.spaceKeys).toHaveLength(1)
    const [entry] = payload.spaceKeys ?? []
    expect(entry.id).toBe(space.id)
    expect(entry.name).toBe('Our home')
    expect(entry.role).toBe('owner')
    expect(entry.keyVersion).toBe(1)
    expect(base64ToBytes(entry.key)).toHaveLength(32)
    expect(Object.keys(payload.spaces ?? {})).toEqual([space.id])
  })

  it('the space payload has the Family records, tombstones included', async () => {
    const { space, kept, second, gone, familyCategory } = await deviceWithFamily()

    const payload = await readPayload(await createBackup())
    const family = payload.spaces?.[space.id]

    expect(family?.spaceInfo?.name).toBe('Our home')
    expect(family?.spaceInfo?.id).toBe('space')
    expect(family?.memberProfiles).toEqual([])
    expect(family?.expenses.map((e) => e.id).sort()).toEqual(
      [kept.id, second.id, gone.id].sort(),
    )
    expect(family?.expenses.find((e) => e.id === gone.id)?.deletedAt).toBeTruthy()
    expect(family?.expenses.find((e) => e.id === kept.id)?.deletedAt).toBeUndefined()
    expect(family?.categories.map((c) => c.id)).toContain(familyCategory.id)
    expect(family?.income).toEqual([])
    expect(family?.budgets).toEqual([])
    expect(family?.recurring).toEqual([])
    expect((family?.incomeCategories ?? []).length).toBeGreaterThan(0)
    expect(family?.settings.mainCurrency).toBe('UAH')
    expect(family?.settings.fetchExchangeRates).toBe(true)
  })

  it('keeps the personal payload separate from the Family one', async () => {
    const { personal, kept } = await deviceWithFamily()

    const payload = await readPayload(await createBackup())

    expect(payload.expenses.map((e) => e.id)).toEqual([personal.id])
    expect(payload.expenses.map((e) => e.id)).not.toContain(kept.id)
  })

  it('never includes a rev, anywhere', async () => {
    await deviceWithFamily()

    const payload = await readPayload(await createBackup())

    expect(JSON.stringify(payload)).not.toMatch(/"rev"/)
  })

  it('survives serialize and parse', async () => {
    const { space } = await deviceWithFamily()

    const parsed = parseBackupFile(serializeBackup(await createBackup()))

    expect(parsed.version).toBe(1)
    expect(Object.keys((await readPayload(parsed)).spaces ?? {})).toEqual([space.id])
  })

  it('an unreadable Family blob stops a full backup with a DecryptError naming the prefixed key', async () => {
    const { space } = await deviceWithFamily()
    mockStore.set(`space:${space.id}:${MARCH_CHUNK}`, new Uint8Array(40))

    const err = await createBackup().then(
      () => null,
      (e: unknown) => e,
    )

    expect(isDecryptError(err)).toBe(true)
    expect((err as { storageKey: string }).storageKey).toBe(`space:${space.id}:${MARCH_CHUNK}`)
  })

  it('with allowPartial it skips the unreadable Family key and keeps the rest', async () => {
    const { space, personal } = await deviceWithFamily()
    mockStore.set(`space:${space.id}:${MARCH_CHUNK}`, new Uint8Array(40))

    const backup = await createBackup({ allowPartial: true })

    expect(backup.skipped).toContain(`space:${space.id}:${MARCH_CHUNK}`)
    const payload = await readPayload(backup)
    expect(payload.expenses.map((e) => e.id)).toEqual([personal.id])
    expect(payload.spaceKeys).toHaveLength(1)
  })
})

describe('restoring a Family backup', () => {
  it('a round trip on an empty device restores the space with its data', async () => {
    const { space, kept, second, gone, identity } = await deviceWithFamily()
    const text = serializeBackup(await createBackup())
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.restoredSpaces).toEqual([space.id])
    expect(summary).not.toHaveProperty('skippedSpaces')
    expect(await listLocalSpaces()).toEqual([
      expect.objectContaining({ id: space.id, name: 'Our home', role: 'owner', keyVersion: 1 }),
    ])
    const restored = await spaceDb(space.id).getAllExpenses()
    expect(restored.map((e) => e.id).sort()).toEqual([kept.id, second.id].sort())
    expect(restored.map((e) => e.id)).not.toContain(gone.id)
    expect(restored.find((e) => e.id === kept.id)?.amount).toBe(500)
    expect(await ensureIdentityKeyPair()).toEqual(identity)
    expect((await spaceDb(space.id).getAllCategories()).length).toBeGreaterThan(0)
  })

  it('restores the tombstone as a tombstone, so a later merge cannot bring the record back', async () => {
    const { space, gone } = await deviceWithFamily()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const payload = await readPayload(await createBackup())
    expect(payload.spaces?.[space.id].expenses.find((e) => e.id === gone.id)?.deletedAt).toBeTruthy()
  })

  it('restores the personal data as before', async () => {
    const { personal } = await deviceWithFamily()
    const text = serializeBackup(await createBackup())
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.expenses).toBe(1)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([personal.id])
  })

  it('writes the Family space in the same restore as the rest (one setMany)', async () => {
    await deviceWithFamily()
    const text = serializeBackup(await createBackup())
    wipe()
    ctl.setManyCalls.length = 0

    await restoreBackup(text, PW, 'replace')

    const touchedFamily = ctl.setManyCalls.filter((keys) =>
      keys.some((key) => key.startsWith('space:')),
    )
    expect(touchedFamily).toHaveLength(1)
    expect(touchedFamily[0]).toEqual(expect.arrayContaining(['spaceKeys', 'identity']))
  })

  it('replace over a device that holds the space puts the Family data back and tombstones local-only records', async () => {
    const { space, fam, kept, second, familyCategory } = await deviceWithFamily()
    const text = await rebuildBackup(() => {})
    setNow(T2)
    const extra = await fam.addExpense({
      amount: 999,
      currency: 'UAH',
      categoryId: familyCategory.id,
      description: 'only on this device',
      createdAt: MARCH,
    })
    await fam.updateExpense(kept.id, kept.createdAt, { amount: 1 })
    setNow(T3)

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.restoredSpaces).toEqual([space.id])
    const live = await fam.getAllExpenses()
    expect(live.map((e) => e.id).sort()).toEqual([kept.id, second.id].sort())
    expect(live.map((e) => e.id)).not.toContain(extra.id)
    expect(live.find((e) => e.id === kept.id)?.amount).toBe(500)
  })

  it('merge keeps a local-only Family record and takes the newer side per record', async () => {
    const { space, fam, kept, second, familyCategory } = await deviceWithFamily()
    const text = await rebuildBackup(() => {})
    setNow(T2)
    const extra = await fam.addExpense({
      amount: 999,
      currency: 'UAH',
      categoryId: familyCategory.id,
      description: 'only on this device',
      createdAt: MARCH,
    })
    await fam.updateExpense(kept.id, kept.createdAt, { amount: 1 })
    setNow(T3)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.restoredSpaces).toEqual([space.id])
    const live = await fam.getAllExpenses()
    expect(live.map((e) => e.id).sort()).toEqual([kept.id, second.id, extra.id].sort())
    // The local edit is newer than the backup's record: it wins.
    expect(live.find((e) => e.id === kept.id)?.amount).toBe(1)
  })

  it('does not touch personal data when only Family records differ', async () => {
    const { personal, fam, familyCategory } = await deviceWithFamily()
    const text = await rebuildBackup(() => {})
    await fam.addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: familyCategory.id,
      createdAt: MARCH,
    })

    await restoreBackup(text, PW, 'replace')

    expect((await getAllExpenses()).map((e) => e.id)).toEqual([personal.id])
  })
})

describe('a space without its key', () => {
  it('is skipped and reported when neither the backup nor the device has the key', async () => {
    const { space } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      delete p.spaceKeys
    })
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.skippedSpaces).toEqual([space.id])
    expect(summary).not.toHaveProperty('restoredSpaces')
    expect(await listLocalSpaces()).toEqual([])
    expect(Array.from(mockStore.keys()).some((k) => k.startsWith('space:'))).toBe(false)
  })

  it('still restores the personal data of such a backup', async () => {
    const { personal } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      delete p.spaceKeys
    })
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.expenses).toBe(1)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([personal.id])
  })

  it('is restored when the device already holds the key, even if the backup does not carry it', async () => {
    const { space, fam, kept, second, familyCategory } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      delete p.spaceKeys
    })
    await fam.addExpense({
      amount: 321,
      currency: 'UAH',
      categoryId: familyCategory.id,
      createdAt: MARCH,
    })

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.restoredSpaces).toEqual([space.id])
    expect(summary).not.toHaveProperty('skippedSpaces')
    expect((await fam.getAllExpenses()).map((e) => e.id).sort()).toEqual(
      [kept.id, second.id].sort(),
    )
  })

  it('a backup space whose key entry is a tombstone is skipped', async () => {
    const { space } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      p.spaceKeys = (p.spaceKeys ?? []).map((e) => ({
        ...e,
        key: '',
        deletedAt: T2,
        updatedAt: T2,
      }))
    })
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.skippedSpaces).toEqual([space.id])
    expect(await listLocalSpaces()).toEqual([])
  })
})

describe('a backup made before this change', () => {
  it('restores like before and keeps the identity, the space keys and the Family data', async () => {
    const { space, identity, personal, kept, second } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      delete p.identity
      delete p.spaceKeys
      delete p.spaces
    })

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary).not.toHaveProperty('restoredSpaces')
    expect(summary).not.toHaveProperty('skippedSpaces')
    expect(summary.mode).toBe('replace')
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([personal.id])
    expect(await ensureIdentityKeyPair()).toEqual(identity)
    expect(await listLocalSpaces()).toEqual([expect.objectContaining({ id: space.id })])
    expect((await spaceDb(space.id).getAllExpenses()).map((e) => e.id).sort()).toEqual(
      [kept.id, second.id].sort(),
    )
  })

  it('has the old payload keys and restores on an empty device without spaces', async () => {
    await createVault(PW)
    await addCategory({ name: 'Food' })
    const text = await rebuildBackup(() => {})
    expect(Object.keys(await readPayload(parseBackupFile(text))).sort()).toEqual(
      OLD_PAYLOAD_KEYS,
    )
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.adoptedVault).toBe(true)
    expect(await listLocalSpaces()).toEqual([])
    expect(Array.from(mockStore.keys()).some((k) => k.startsWith('space:'))).toBe(false)
  })
})

describe('identity and space keys are never destroyed by a restore', () => {
  it('an existing local identity is never replaced', async () => {
    const { identity } = await deviceWithFamily()
    const other = await generateIdentityKeyPair()
    const text = await rebuildBackup((p) => {
      p.identity = {
        id: 'identity',
        publicKeyJwk: other.publicKeyJwk,
        privateKeyJwk: other.privateKeyJwk,
        createdAt: T3,
        updatedAt: T3,
      }
    })

    await restoreBackup(text, PW, 'replace')
    expect(await ensureIdentityKeyPair()).toEqual(identity)

    await restoreBackup(text, PW, 'merge')
    expect(await ensureIdentityKeyPair()).toEqual(identity)
  })

  it('a device without an identity takes the backup’s', async () => {
    await createVault(PW)
    await addCategory({ name: 'Food' })
    const other = await generateIdentityKeyPair()
    const text = await rebuildBackup((p) => {
      p.identity = {
        id: 'identity',
        publicKeyJwk: other.publicKeyJwk,
        privateKeyJwk: other.privateKeyJwk,
        createdAt: T1,
        updatedAt: T1,
      }
    })

    await restoreBackup(text, PW, 'replace')

    expect(await ensureIdentityKeyPair()).toEqual(other)
  })

  it('a replace never empties the local space keys, even when the backup has none', async () => {
    const { space } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      p.spaceKeys = []
      delete p.spaces
    })

    await restoreBackup(text, PW, 'replace')

    expect((await listLocalSpaces()).map((s) => s.id)).toEqual([space.id])
  })

  it('merges space keys: a local space survives the restore of a backup that holds another one', async () => {
    const { space } = await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      p.spaceKeys = [
        {
          id: '11111111-2222-4333-8444-555555555555',
          keyVersion: 1,
          key: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
          name: 'Other',
          role: 'member',
          joinedAt: T1,
          updatedAt: T1,
        },
      ]
      delete p.spaces
    })

    await restoreBackup(text, PW, 'replace')

    const ids = (await listLocalSpaces()).map((s) => s.id).sort()
    expect(ids).toEqual([space.id, '11111111-2222-4333-8444-555555555555'].sort())
  })

  it('a restored space key opens the restored Family data (the key comes from the backup)', async () => {
    const { space } = await deviceWithFamily()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const dek = getLocalDbKey()
    if (!dek) throw new Error('expected an unlocked vault')
    const entries = (await decryptValue(dek, mockStore.get('spaceKeys') as Uint8Array)) as Array<{
      id: string
      key: string
    }>
    const sk = await importSpaceKey(base64ToBytes(entries.find((e) => e.id === space.id)?.key ?? ''))
    const stored = (await decryptValue(
      sk,
      mockStore.get(`space:${space.id}:${MARCH_CHUNK}`) as Uint8Array,
    )) as Array<Expense>
    expect(stored.length).toBeGreaterThan(0)
    await expect(
      decryptValue(dek, mockStore.get(`space:${space.id}:${MARCH_CHUNK}`) as Uint8Array),
    ).rejects.toBeDefined()
  })
})

describe('a malformed payload is an invalid file', () => {
  it.each([
    ['identity is not an object', (p: Record<string, unknown>) => (p.identity = 'nope')],
    ['spaceKeys is not a list', (p: Record<string, unknown>) => (p.spaceKeys = { a: 1 })],
    ['spaces is not an object', (p: Record<string, unknown>) => (p.spaces = 'nope')],
    ['a space payload is not an object', (p: Record<string, unknown>) => (p.spaces = { abc: 5 })],
    [
      'a space payload has no expenses list',
      (p: Record<string, unknown>) =>
        (p.spaces = {
          abc: { memberProfiles: [], categories: [], income: [], budgets: [], settings: {} },
        }),
    ],
  ])('%s', async (_label, mutate) => {
    await createVault(PW)
    const text = await rebuildBackup((p) => {
      mutate(loose(p))
    })

    const err = await restoreBackup(text, PW, 'replace').then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(BackupError)
    expect((err as BackupError).code).toBe('invalid-file')
  })

  it('writes nothing when the file is invalid', async () => {
    await deviceWithFamily()
    const text = await rebuildBackup((p) => {
      loose(p).spaces = 'nope'
    })
    const before = new Map(mockStore)

    await expect(restoreBackup(text, PW, 'replace')).rejects.toBeInstanceOf(BackupError)

    for (const [key, value] of before) expect(mockStore.get(key), key).toBe(value)
    expect(mockStore.size).toBe(before.size)
  })
})

describe('defaultRestoreMode', () => {
  it('ignores the identity, the space keys and every Family key', async () => {
    await createVault(PW)
    await ensureIdentityKeyPair()
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })
    const fam = spaceDb(space.id)
    const category = (await fam.getAllCategories())[0]
    await fam.addExpense({
      amount: 1,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: MARCH,
    })

    expect(await defaultRestoreMode()).toBe('replace')
  })

  it('still offers merge when personal data exists next to a Family space', async () => {
    await createVault(PW)
    const category = await addCategory({ name: 'Food' })
    await createLocalSpace({ name: 'Home', lang: 'en' })
    expect(await defaultRestoreMode()).toBe('replace')

    await addExpense({ amount: 1, currency: 'UAH', categoryId: category.id, createdAt: MARCH })

    expect(await defaultRestoreMode()).toBe('merge')
  })
})

describe('the personal tombstone path is unchanged', () => {
  it('a deleted personal expense is still carried as a tombstone', async () => {
    await createVault(PW)
    const category = await addCategory({ name: 'Food' })
    const e = await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: MARCH,
    })
    await deleteExpense(e.id, e.createdAt)

    const payload = await readPayload(await createBackup())

    expect(payload.expenses.find((x) => x.id === e.id)?.deletedAt).toBeTruthy()
  })
})
