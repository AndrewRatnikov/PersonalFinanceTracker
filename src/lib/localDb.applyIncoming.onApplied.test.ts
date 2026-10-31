// CONTRACT_GAP: the exact text logged for a throwing callback is not fixed;
//   only that the apply still resolves and console.error is called.
//
// ApplyIncomingOptions.onApplied (plan section 3): called once after the commit
// with the records that were taken (not the kept ones), flagged created /
// deleted, with createdBy. The result shape stays { applied, kept, conflicts }.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppliedIncomingRecord } from '@/lib/localDb'
import type { SyncRecord } from '@/lib/syncRecords'
import {
  applyIncomingRecords,
  createLocalSpace,
  getAllExpenses,
  getLocalStore,
  spaceDb,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { setSyncChannel } from '@/lib/syncChannel'
import { storeState } from '@/test/sync/memoryIdb'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue({ userId: 'u-me', email: null }),
}))

const OLD = '2026-10-01T10:00:00.000Z'
const NEW = '2026-10-10T10:00:00.000Z'
const NEWER = '2026-10-11T10:00:00.000Z'
const CREATED = '2026-10-05T12:00:00.000Z'

let famId: string

function expenseRecord(id: string, updatedAt: string, extra: Record<string, unknown> = {}, deletedAt?: string): SyncRecord {
  return {
    type: 'expense',
    id,
    updatedAt,
    ...(deletedAt ? { deletedAt } : {}),
    data: {
      id,
      amount: 10,
      currency: 'UAH',
      categoryId: 'cat-food',
      createdAt: CREATED,
      updatedAt,
      ...(deletedAt ? { deletedAt } : {}),
      ...extra,
    },
  }
}

beforeEach(async () => {
  const store = getLocalStore()
  if (!store) throw new Error('no store')
  storeState(store).data.clear()
  localStorage.clear()
  setSyncChannel(null)
  clearKeyring()
  unlockLocalDb(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
  famId = (await createLocalSpace({ name: 'Our home', lang: 'en' })).id
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.restoreAllMocks()
})

describe('onApplied', () => {
  it('is called once with created, deleted and createdBy for each taken record', async () => {
    const onApplied = vi.fn<(records: Array<AppliedIncomingRecord>) => void>()

    const result = await applyIncomingRecords(
      famId,
      [
        expenseRecord('e1', NEW, { createdBy: 'u-olena' }),
        expenseRecord('e2', NEW, { createdBy: 'u-taras' }),
      ],
      { onApplied },
    )

    expect(result).toEqual({ applied: 2, kept: 0, conflicts: 0 })
    expect(onApplied).toHaveBeenCalledTimes(1)
    const records = onApplied.mock.calls[0][0]
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.id === 'e1')).toMatchObject({
      type: 'expense',
      created: true,
      deleted: false,
      createdBy: 'u-olena',
    })
    expect(records.find((r) => r.id === 'e2')?.createdBy).toBe('u-taras')
  })

  it('created is false when a local copy existed, and true for a brand new id', async () => {
    await applyIncomingRecords(famId, [expenseRecord('e1', OLD, { createdBy: 'u-olena' })])
    const onApplied = vi.fn<(records: Array<AppliedIncomingRecord>) => void>()

    await applyIncomingRecords(
      famId,
      [expenseRecord('e1', NEWER, { createdBy: 'u-olena' }), expenseRecord('e9', NEWER, { createdBy: 'u-olena' })],
      { onApplied },
    )

    const records = onApplied.mock.calls[0][0]
    expect(records.find((r) => r.id === 'e1')?.created).toBe(false)
    expect(records.find((r) => r.id === 'e9')?.created).toBe(true)
  })

  it('flags an incoming tombstone as deleted', async () => {
    await applyIncomingRecords(famId, [expenseRecord('e1', OLD)])
    const onApplied = vi.fn<(records: Array<AppliedIncomingRecord>) => void>()

    await applyIncomingRecords(famId, [expenseRecord('e1', NEW, {}, NEW)], { onApplied })

    expect(onApplied.mock.calls[0][0]).toMatchObject([{ id: 'e1', deleted: true, created: false }])
  })

  it('does not report records that were kept (the local copy is newer)', async () => {
    await applyIncomingRecords(famId, [expenseRecord('e1', NEWER)])
    const onApplied = vi.fn<(records: Array<AppliedIncomingRecord>) => void>()

    const result = await applyIncomingRecords(famId, [expenseRecord('e1', OLD)], { onApplied })

    expect(result.kept).toBe(1)
    expect(result.applied).toBe(0)
    const reported = onApplied.mock.calls.flatMap((c) => c[0])
    expect(reported).toEqual([])
  })

  it('works for the personal space too, and without the option nothing is reported or changed', async () => {
    const onApplied = vi.fn()

    const withOpt = await applyIncomingRecords([expenseRecord('p1', NEW)], { onApplied })
    const without = await applyIncomingRecords([expenseRecord('p2', NEW)])

    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(withOpt).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect(without).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect((await getAllExpenses()).map((e) => e.id).sort()).toEqual(['p1', 'p2'])
  })

  it('a throwing callback is logged and never fails the apply', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onApplied = vi.fn(() => {
      throw new Error('boom')
    })

    const result = await applyIncomingRecords(famId, [expenseRecord('e1', NEW)], { onApplied })

    expect(result.applied).toBe(1)
    expect(spy).toHaveBeenCalled()
    expect((await spaceDb(famId).getAllExpenses()).map((e) => e.id)).toEqual(['e1'])
  })
})
