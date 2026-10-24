// No CONTRACT_GAPs for behaviour. CloudError's constructor is not specified in
// the Interface Contract, so it is never constructed here: only name, code and
// instanceof are checked, and errors come from toCloudError / the API itself.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpcFn, RpcResponse } from '@/lib/cloud/api'
import { SERVER_ERROR_CODES } from '@/lib/cloud/types'
import { CloudError, createCloudApi, toCloudError } from '@/lib/cloud/api'

const { createClientCalls, clientRpc } = vi.hoisted(() => ({
  createClientCalls: { count: 0 },
  clientRpc: vi.fn(),
}))

// The default rpc must build the Supabase client lazily, so the whole module is
// replaced by a counter instead of a real client.
vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => {
    createClientCalls.count += 1
    return { rpc: clientRpc }
  },
}))

const DEVICE = '3f2b1c4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b'
const VAULT = 'vault-1'
const NOW = '2026-10-23T10:00:00.000Z'

const HEADER = {
  v: 2 as const,
  vaultId: VAULT,
  createdAt: NOW,
  kdf: { alg: 'PBKDF2-SHA256' as const, iterations: 600000, salt: 'c2FsdA==' },
  wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
  recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
  verifier: { iv: 'aXY=', ct: 'Y3Q=' },
}

const STATUS = {
  plan_id: 'beta',
  has_sync: true,
  free_for_all: true,
  granted_by: 'free_for_all' as const,
  beta_joined_at: null,
  entitlement_status: null,
  current_period_end: null,
  limits: { sync: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
  vault: null,
  devices_count: 0,
}

const DEVICE_ROW = {
  device_id: DEVICE,
  label: 'Chrome on Android',
  created_at: NOW,
  last_seen_at: NOW,
  removed_at: null,
}

const ROW = {
  record_key: 'k'.repeat(43),
  ciphertext: 'Y2lwaGVy',
  iv: 'aXZpdml2aXZpdml2',
  enc_v: 1,
  updated_at_ms: 1000,
  device_id: DEVICE,
  seq: 4,
}

const ENCRYPTED = {
  record_key: ROW.record_key,
  ciphertext: ROW.ciphertext,
  iv: ROW.iv,
  enc_v: 1,
  updated_at_ms: 1000,
}

const PUSH_RESULT = {
  results: [
    { record_key: ROW.record_key, status: 'accepted' as const, seq: 5 },
    { record_key: 'z'.repeat(43), status: 'stale' as const, current: ROW },
  ],
  last_seq: 5,
}

const PULL_RESULT = { records: [ROW], has_more: false, last_seq: 4, vault_id: VAULT }

function ok(data: unknown): RpcResponse {
  return { data, error: null, status: 200 }
}

function fakeRpc(response: RpcResponse) {
  return vi.fn<RpcFn>().mockResolvedValue(response)
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CloudError)
  expect((err as CloudError).name).toBe('CloudError')
  return (err as CloudError).code
}

describe('default rpc is lazy', () => {
  it('importing the module and creating the api build no Supabase client', () => {
    expect(createClientCalls.count).toBe(0)
    createCloudApi()
    expect(createClientCalls.count).toBe(0)
  })

  it('the first call builds the client and calls rpc with the function name and args', async () => {
    clientRpc.mockResolvedValue({ data: STATUS, error: null, status: 200 })

    const status = await createCloudApi().getSyncStatus()

    expect(createClientCalls.count).toBe(1)
    expect(clientRpc).toHaveBeenCalledWith('get_sync_status', {})
    expect(status.plan_id).toBe('beta')
  })
})

describe('each method calls the right RPC with the SQL argument names', () => {
  it('getSyncStatus', async () => {
    const rpc = fakeRpc(ok(STATUS))
    const status = await createCloudApi(rpc).getSyncStatus()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_sync_status', {})
    expect(status).toEqual(STATUS)
  })

  it('getVault returns the vault, and null when there is none', async () => {
    const vault = { vault_id: VAULT, header: HEADER, header_rev: 3 }
    const rpc = fakeRpc(ok(vault))
    expect(await createCloudApi(rpc).getVault()).toEqual(vault)
    expect(rpc).toHaveBeenCalledWith('get_vault', {})

    expect(await createCloudApi(fakeRpc(ok(null))).getVault()).toBeNull()
  })

  it('registerDevice', async () => {
    const rpc = fakeRpc(ok(DEVICE_ROW))
    const device = await createCloudApi(rpc).registerDevice(DEVICE, 'Chrome on Android')
    expect(rpc).toHaveBeenCalledWith('register_device', {
      p_device_id: DEVICE,
      p_label: 'Chrome on Android',
    })
    expect(device).toEqual(DEVICE_ROW)
  })

  it('listDevices', async () => {
    const rpc = fakeRpc(ok([DEVICE_ROW, { ...DEVICE_ROW, removed_at: NOW }]))
    const list = await createCloudApi(rpc).listDevices()
    expect(rpc).toHaveBeenCalledWith('list_devices', {})
    expect(list).toHaveLength(2)
    expect(list[1].removed_at).toBe(NOW)
    expect(await createCloudApi(fakeRpc(ok([]))).listDevices()).toEqual([])
  })

  it('renameDevice', async () => {
    const rpc = fakeRpc(ok({ ...DEVICE_ROW, label: 'New' }))
    const device = await createCloudApi(rpc).renameDevice(DEVICE, 'New')
    expect(rpc).toHaveBeenCalledWith('rename_device', { p_device_id: DEVICE, p_label: 'New' })
    expect(device.label).toBe('New')
  })

  it('removeDevice', async () => {
    const rpc = fakeRpc(ok({ ...DEVICE_ROW, removed_at: NOW }))
    const device = await createCloudApi(rpc).removeDevice(DEVICE)
    expect(rpc).toHaveBeenCalledWith('remove_device', { p_device_id: DEVICE })
    expect(device.removed_at).toBe(NOW)
  })

  it('createVault', async () => {
    const rpc = fakeRpc(ok({ vault_id: VAULT, header_rev: 1 }))
    const ref = await createCloudApi(rpc).createVault(DEVICE, VAULT, HEADER)
    expect(rpc).toHaveBeenCalledWith('create_vault', {
      p_device_id: DEVICE,
      p_vault_id: VAULT,
      p_header: HEADER,
    })
    expect(ref).toEqual({ vault_id: VAULT, header_rev: 1 })
  })

  it('updateVaultHeader', async () => {
    const rpc = fakeRpc(ok({ vault_id: VAULT, header_rev: 8 }))
    const ref = await createCloudApi(rpc).updateVaultHeader(DEVICE, VAULT, HEADER, 7)
    expect(rpc).toHaveBeenCalledWith('update_vault_header', {
      p_device_id: DEVICE,
      p_vault_id: VAULT,
      p_header: HEADER,
      p_expected_rev: 7,
    })
    expect(ref.header_rev).toBe(8)
  })

  it('pushRecords', async () => {
    const rpc = fakeRpc(ok(PUSH_RESULT))
    const result = await createCloudApi(rpc).pushRecords(DEVICE, VAULT, [ENCRYPTED])
    expect(rpc).toHaveBeenCalledWith('push_records', {
      p_device_id: DEVICE,
      p_vault_id: VAULT,
      p_records: [ENCRYPTED],
    })
    expect(result).toEqual(PUSH_RESULT)
  })

  it('pullRecords sends p_limit only when given', async () => {
    const rpc = fakeRpc(ok(PULL_RESULT))
    const api = createCloudApi(rpc)

    expect(await api.pullRecords(DEVICE, VAULT, 5)).toEqual(PULL_RESULT)
    expect(rpc).toHaveBeenLastCalledWith('pull_records', {
      p_device_id: DEVICE,
      p_vault_id: VAULT,
      p_since: 5,
    })
    const withoutLimit = rpc.mock.calls[0][1] ?? {}
    expect(Object.keys(withoutLimit)).not.toContain('p_limit')

    await api.pullRecords(DEVICE, VAULT, 5, 2)
    expect(rpc).toHaveBeenLastCalledWith('pull_records', {
      p_device_id: DEVICE,
      p_vault_id: VAULT,
      p_since: 5,
      p_limit: 2,
    })
  })

  it('deleteCloudData', async () => {
    const rpc = fakeRpc(ok({ deleted_records: 9 }))
    const result = await createCloudApi(rpc).deleteCloudData()
    expect(rpc).toHaveBeenCalledWith('delete_cloud_data', {})
    expect(result).toEqual({ deleted_records: 9 })
  })
})

describe('responses are validated and stripped', () => {
  it('drops unknown keys from the status, its limits and rows', async () => {
    const withExtras = { ...STATUS, surprise: 'x' }
    const status = await createCloudApi(fakeRpc(ok(withExtras))).getSyncStatus()
    expect(status).not.toHaveProperty('surprise')
    expect(status.plan_id).toBe('beta')

    const device = await createCloudApi(fakeRpc(ok({ ...DEVICE_ROW, extra: 1 }))).registerDevice(
      DEVICE,
      'x',
    )
    expect(device).not.toHaveProperty('extra')
  })

  it('accepts a status with a vault and a paid entitlement', async () => {
    const full = {
      ...STATUS,
      plan_id: 'sync',
      granted_by: 'entitlement',
      entitlement_status: 'active',
      current_period_end: NOW,
      beta_joined_at: NOW,
      vault: { vault_id: VAULT, header_rev: 2, record_count: 3, total_bytes: 90, last_seq: 7 },
      devices_count: 2,
    }
    const status = await createCloudApi(fakeRpc(ok(full))).getSyncStatus()
    expect(status.vault?.last_seq).toBe(7)
    expect(status.entitlement_status).toBe('active')
  })

  const malformed: Array<[string, (api: ReturnType<typeof createCloudApi>) => Promise<unknown>, unknown]> = [
    ['status: null', (a) => a.getSyncStatus(), null],
    ['status: missing plan_id', (a) => a.getSyncStatus(), Object.fromEntries(Object.entries(STATUS).filter(([k]) => k !== 'plan_id'))],
    ['status: has_sync as a string', (a) => a.getSyncStatus(), { ...STATUS, has_sync: 'yes' }],
    ['status: unknown granted_by', (a) => a.getSyncStatus(), { ...STATUS, granted_by: 'magic' }],
    ['status: limits missing', (a) => a.getSyncStatus(), { ...STATUS, limits: null }],
    ['status: devices_count as a string', (a) => a.getSyncStatus(), { ...STATUS, devices_count: '0' }],
    ['status: a string', (a) => a.getSyncStatus(), 'ok'],
    ['vault: header with v 1', (a) => a.getVault(), { vault_id: VAULT, header: { ...HEADER, v: 1 }, header_rev: 1 }],
    ['vault: missing header_rev', (a) => a.getVault(), { vault_id: VAULT, header: HEADER }],
    ['vault: header_rev as a string', (a) => a.getVault(), { vault_id: VAULT, header: HEADER, header_rev: '1' }],
    ['vault: header missing kdf', (a) => a.getVault(), { vault_id: VAULT, header: { ...HEADER, kdf: undefined }, header_rev: 1 }],
    ['device: label missing', (a) => a.registerDevice(DEVICE, 'x'), { ...DEVICE_ROW, label: undefined }],
    ['device: null', (a) => a.renameDevice(DEVICE, 'x'), null],
    ['device: removed_at as a number', (a) => a.removeDevice(DEVICE), { ...DEVICE_ROW, removed_at: 5 }],
    ['devices: not an array', (a) => a.listDevices(), DEVICE_ROW],
    ['devices: an element is wrong', (a) => a.listDevices(), [DEVICE_ROW, { device_id: 5 }]],
    ['vault ref: missing vault_id', (a) => a.createVault(DEVICE, VAULT, HEADER), { header_rev: 1 }],
    ['vault ref: null', (a) => a.updateVaultHeader(DEVICE, VAULT, HEADER, 1), null],
    ['push: unknown status', (a) => a.pushRecords(DEVICE, VAULT, [ENCRYPTED]), { results: [{ record_key: 'k', status: 'weird', seq: 1 }], last_seq: 1 }],
    ['push: stale without current', (a) => a.pushRecords(DEVICE, VAULT, [ENCRYPTED]), { results: [{ record_key: 'k', status: 'stale' }], last_seq: 1 }],
    ['push: accepted without seq', (a) => a.pushRecords(DEVICE, VAULT, [ENCRYPTED]), { results: [{ record_key: 'k', status: 'accepted' }], last_seq: 1 }],
    ['push: missing last_seq', (a) => a.pushRecords(DEVICE, VAULT, [ENCRYPTED]), { results: [] }],
    ['pull: records not an array', (a) => a.pullRecords(DEVICE, VAULT, 0), { ...PULL_RESULT, records: {} }],
    ['pull: row without ciphertext', (a) => a.pullRecords(DEVICE, VAULT, 0), { ...PULL_RESULT, records: [{ ...ROW, ciphertext: undefined }] }],
    ['pull: has_more as a string', (a) => a.pullRecords(DEVICE, VAULT, 0), { ...PULL_RESULT, has_more: 'no' }],
    ['pull: seq as a string', (a) => a.pullRecords(DEVICE, VAULT, 0), { ...PULL_RESULT, records: [{ ...ROW, seq: '4' }] }],
    ['delete: missing deleted_records', (a) => a.deleteCloudData(), {}],
    ['delete: deleted_records as a string', (a) => a.deleteCloudData(), { deleted_records: '3' }],
    ['delete: null', (a) => a.deleteCloudData(), null],
  ]

  it.each(malformed)('rejects a malformed response (%s) with code unknown', async (_name, call, data) => {
    const api = createCloudApi(fakeRpc(ok(data)))
    expect(await codeOf(call(api))).toBe('unknown')
  })
})

describe('error mapping', () => {
  it('knows the 12 server error codes', () => {
    expect([...SERVER_ERROR_CODES].sort()).toEqual(
      [
        'batch_too_large',
        'device_limit',
        'device_not_registered',
        'device_removed',
        'header_conflict',
        'invalid_input',
        'no_vault',
        'not_signed_in',
        'quota_exceeded',
        'sync_not_included',
        'vault_exists',
        'vault_mismatch',
      ].sort(),
    )
  })

  it.each([...SERVER_ERROR_CODES])('maps MINIMA:%s to that code', async (code) => {
    const rpc = fakeRpc({ data: null, error: { message: `MINIMA:${code}`, code: 'P0001' }, status: 400 })
    expect(await codeOf(createCloudApi(rpc).getSyncStatus())).toBe(code)
  })

  it('finds the MINIMA code when the message has other text around it', async () => {
    const rpc = fakeRpc({
      data: null,
      error: { message: 'Error: MINIMA:device_limit', code: 'P0001', details: 'x' },
      status: 400,
    })
    expect(await codeOf(createCloudApi(rpc).registerDevice(DEVICE, 'x'))).toBe('device_limit')
  })

  it('maps an unknown MINIMA code to unknown', async () => {
    const rpc = fakeRpc({ data: null, error: { message: 'MINIMA:bogus_code', code: 'P0001' }, status: 400 })
    expect(await codeOf(createCloudApi(rpc).getSyncStatus())).toBe('unknown')
  })

  it('maps status 0 to network', async () => {
    const rpc = fakeRpc({
      data: null,
      error: { message: 'TypeError: Failed to fetch', code: '' },
      status: 0,
    })
    expect(await codeOf(createCloudApi(rpc).getSyncStatus())).toBe('network')
  })

  it('maps a rejected rpc promise to network', async () => {
    const rpc = vi.fn<RpcFn>().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await codeOf(createCloudApi(rpc).pullRecords(DEVICE, VAULT, 0))).toBe('network')
  })

  it('maps status 401 to not_signed_in', async () => {
    const rpc = fakeRpc({ data: null, error: { message: 'JWT expired', code: 'PGRST301' }, status: 401 })
    expect(await codeOf(createCloudApi(rpc).getSyncStatus())).toBe('not_signed_in')
  })

  it('maps anything else to unknown', async () => {
    const rpc = fakeRpc({ data: null, error: { message: 'boom', code: '500' }, status: 500 })
    expect(await codeOf(createCloudApi(rpc).getSyncStatus())).toBe('unknown')
  })

  it('every method rejects with a CloudError, not a raw error', async () => {
    const response: RpcResponse = {
      data: null,
      error: { message: 'MINIMA:quota_exceeded', code: 'P0001' },
      status: 400,
    }
    const api = createCloudApi(fakeRpc(response))
    const calls = [
      api.getSyncStatus(),
      api.getVault(),
      api.registerDevice(DEVICE, 'x'),
      api.listDevices(),
      api.renameDevice(DEVICE, 'x'),
      api.removeDevice(DEVICE),
      api.createVault(DEVICE, VAULT, HEADER),
      api.updateVaultHeader(DEVICE, VAULT, HEADER, 1),
      api.pushRecords(DEVICE, VAULT, []),
      api.pullRecords(DEVICE, VAULT, 0),
      api.deleteCloudData(),
    ]
    expect(calls).toHaveLength(11)
    for (const call of calls) {
      expect(await codeOf(call)).toBe('quota_exceeded')
    }
  })
})

describe('toCloudError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps an RpcError with a MINIMA code', () => {
    const err = toCloudError({ message: 'MINIMA:header_conflict', code: 'P0001' })
    expect(err).toBeInstanceOf(CloudError)
    expect(err.name).toBe('CloudError')
    expect(err.code).toBe('header_conflict')
    expect(toCloudError({ message: 'MINIMA:vault_exists' }).code).toBe('vault_exists')
  })

  it('maps non-error values to unknown', () => {
    expect(toCloudError(42).code).toBe('unknown')
    expect(toCloudError(undefined).code).toBe('unknown')
    expect(toCloudError({ message: 'something else' }).code).toBe('unknown')
  })
})
