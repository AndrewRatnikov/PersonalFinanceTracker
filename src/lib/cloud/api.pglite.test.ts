// @vitest-environment node
// No CONTRACT_GAPs: every API function runs end to end against the PGlite
// harness with the real SQL argument names (acceptance criterion 20), and real
// MINIMA errors are mapped to CloudError codes (criterion 21).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { VaultHeaderV2 } from '@/lib/vault'
import type { SyncRecord } from '@/lib/syncRecords'
import type { SqlTestDb } from '@/test/sql/harness'
import {
  setFreeForAll,
  startDb,
  validHeader,
  wireRecord,
} from '@/test/sql/harness'
import { CloudError, createCloudApi } from '@/lib/cloud/api'
import {
  decryptSyncRecord,
  deriveSyncKeys,
  encryptSyncRecord,
} from '@/lib/cloud/recordCrypto'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startDb()
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

function header(vaultId: string, extra: Record<string, unknown> = {}): VaultHeaderV2 {
  return validHeader(vaultId, extra) as VaultHeaderV2
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CloudError)
  return (err as CloudError).code
}

async function newApi() {
  const userId = await ctx.createUser()
  return { userId, api: createCloudApi(ctx.rpcAs(userId)) }
}

describe('every API function against the real SQL', () => {
  it('getSyncStatus returns the beta status for a new user', async () => {
    const { api } = await newApi()
    const status = await api.getSyncStatus()

    expect(status.plan_id).toBe('beta')
    expect(status.has_sync).toBe(true)
    expect(status.free_for_all).toBe(true)
    expect(status.granted_by).toBe('free_for_all')
    expect(status.limits.sync).toBe(true)
    expect(status.limits.max_devices).toBe(5)
    expect(status.vault).toBeNull()
    expect(status.devices_count).toBe(0)
  })

  it('registerDevice, listDevices, renameDevice and removeDevice', async () => {
    const { api } = await newApi()
    const id = crypto.randomUUID()

    const device = await api.registerDevice(id, 'Chrome on Android')
    expect(device.device_id).toBe(id)
    expect(device.label).toBe('Chrome on Android')
    expect(device.removed_at).toBeNull()

    const list = await api.listDevices()
    expect(list.map((d) => d.device_id)).toEqual([id])

    const renamed = await api.renameDevice(id, 'Pixel')
    expect(renamed.label).toBe('Pixel')
    expect((await api.listDevices())[0].label).toBe('Pixel')

    const removed = await api.removeDevice(id)
    expect(removed.removed_at).not.toBeNull()
    expect((await api.getSyncStatus()).devices_count).toBe(0)
  })

  it('getVault, createVault and updateVaultHeader', async () => {
    const { api } = await newApi()
    const id = crypto.randomUUID()
    await api.registerDevice(id, 'Laptop')
    expect(await api.getVault()).toBeNull()

    const ref = await api.createVault(id, 'vault-api', header('vault-api'))
    expect(ref).toEqual({ vault_id: 'vault-api', header_rev: 1 })

    const got = await api.getVault()
    expect(got?.vault_id).toBe('vault-api')
    expect(got?.header_rev).toBe(1)
    expect(got?.header.vaultId).toBe('vault-api')

    const next = header('vault-api', { createdAt: '2027-01-01T00:00:00.000Z' })
    const updated = await api.updateVaultHeader(id, 'vault-api', next, 1)
    expect(updated).toEqual({ vault_id: 'vault-api', header_rev: 2 })
    expect((await api.getVault())?.header.createdAt).toBe('2027-01-01T00:00:00.000Z')

    const status = await api.getSyncStatus()
    expect(status.vault?.header_rev).toBe(2)
  })

  it('pushRecords, pullRecords and deleteCloudData', async () => {
    const { api } = await newApi()
    const id = crypto.randomUUID()
    await api.registerDevice(id, 'Laptop')
    await api.createVault(id, 'vault-p', header('vault-p'))

    const pushed = await api.pushRecords(id, 'vault-p', [
      wireRecord(1, 1000),
      wireRecord(2, 1000),
      wireRecord(3, 1000),
    ])
    expect(pushed.last_seq).toBe(3)
    expect(pushed.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted'])

    const stale = await api.pushRecords(id, 'vault-p', [wireRecord(1, 1000, 30)])
    expect(stale.results[0].status).toBe('stale')
    const first = stale.results[0]
    if (first.status === 'stale') {
      expect(first.current.seq).toBe(1)
      expect(first.current.device_id).toBe(id)
    }

    const page1 = await api.pullRecords(id, 'vault-p', 0, 2)
    expect(page1.records.map((r) => r.seq)).toEqual([1, 2])
    expect(page1.has_more).toBe(true)
    expect(page1.vault_id).toBe('vault-p')
    const page2 = await api.pullRecords(id, 'vault-p', 2)
    expect(page2.records.map((r) => r.seq)).toEqual([3])
    expect(page2.has_more).toBe(false)

    const deleted = await api.deleteCloudData()
    expect(deleted).toEqual({ deleted_records: 3 })
    expect(await api.getVault()).toBeNull()
    expect(await api.listDevices()).toEqual([])
  })

  it('an encrypted record survives push, pull and decrypt', async () => {
    const { api } = await newApi()
    const id = crypto.randomUUID()
    await api.registerDevice(id, 'Laptop')
    await api.createVault(id, 'vault-e', header('vault-e'))
    const keys = await deriveSyncKeys(crypto.getRandomValues(new Uint8Array(32)))

    const records: Array<SyncRecord> = [
      { type: 'expense', id: 'e-1', updatedAt: '2026-10-23T10:00:00.000Z', data: { amount: 1250 } },
      { type: 'income', id: 'i-1', updatedAt: '2026-10-23T11:00:00.000Z', data: { amount: 99900 } },
    ]
    const wire = await Promise.all(records.map((r) => encryptSyncRecord(keys, r)))
    const pushed = await api.pushRecords(id, 'vault-e', wire)
    expect(pushed.results.every((r) => r.status === 'accepted')).toBe(true)

    const pulled = await api.pullRecords(id, 'vault-e', 0)
    const decrypted = await Promise.all(pulled.records.map((r) => decryptSyncRecord(keys, r)))
    expect(decrypted).toEqual(records)
    expect(pulled.records.map((r) => r.updated_at_ms)).toEqual(
      records.map((r) => Date.parse(r.updatedAt)),
    )
  })
})

describe('real server errors become CloudError codes', () => {
  it('device_limit on the 6th device', async () => {
    const { api } = await newApi()
    for (let i = 0; i < 5; i++) await api.registerDevice(crypto.randomUUID(), `D${i}`)
    expect(await codeOf(api.registerDevice(crypto.randomUUID(), 'Sixth'))).toBe('device_limit')
  })

  it('device_not_registered, device_removed and vault errors', async () => {
    const { api } = await newApi()
    const id = crypto.randomUUID()
    expect(await codeOf(api.pushRecords(id, 'v', []))).toBe('device_not_registered')

    await api.registerDevice(id, 'Laptop')
    expect(await codeOf(api.pullRecords(id, 'v', 0))).toBe('no_vault')

    await api.createVault(id, 'v', header('v'))
    expect(await codeOf(api.createVault(id, 'v2', header('v2')))).toBe('vault_exists')
    expect(await codeOf(api.pullRecords(id, 'other', 0))).toBe('vault_mismatch')
    expect(await codeOf(api.updateVaultHeader(id, 'v', header('v'), 9))).toBe('header_conflict')

    await api.removeDevice(id)
    expect(await codeOf(api.pushRecords(id, 'v', []))).toBe('device_removed')
  })

  it('invalid_input and batch_too_large', async () => {
    const { api } = await newApi()
    const id = crypto.randomUUID()
    await api.registerDevice(id, 'Laptop')
    await api.createVault(id, 'v', header('v'))

    expect(await codeOf(api.renameDevice(id, ''))).toBe('invalid_input')
    expect(await codeOf(api.pushRecords(id, 'v', [{ ...wireRecord(1), enc_v: 7 }]))).toBe(
      'invalid_input',
    )
    const tooMany = Array.from({ length: 501 }, (_, i) => wireRecord(i + 1))
    expect(await codeOf(api.pushRecords(id, 'v', tooMany))).toBe('batch_too_large')
  }, 60_000)

  it('sync_not_included when the beta switch is off', async () => {
    const { api } = await newApi()
    await setFreeForAll(ctx, false)
    try {
      expect(await codeOf(api.registerDevice(crypto.randomUUID(), 'Laptop'))).toBe(
        'sync_not_included',
      )
      const status = await api.getSyncStatus()
      expect(status.has_sync).toBe(false)
      expect(status.plan_id).toBe('free')
    } finally {
      await setFreeForAll(ctx, true)
    }
  })

  it('not_signed_in without a user', async () => {
    const api = createCloudApi(ctx.rpcAs(null))
    expect(await codeOf(api.getSyncStatus())).toBe('not_signed_in')
    expect(await codeOf(api.listDevices())).toBe('not_signed_in')
  })
})
