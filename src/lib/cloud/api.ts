// Typed client for the sync server functions
// (supabase/migrations/20261023000000_sync_server.sql). Every argument name is
// the SQL parameter name, every result is validated at runtime, and every
// failure rejects with a CloudError.
//
// Only getSyncStatus is used by the app today, through the gate in
// ./entitlements.ts. Never call the other functions without that gate.

import { z } from 'zod'

import { CloudError } from './rpc'
import { SERVER_ERROR_CODES } from './types'
import type { RpcFn, RpcResponse } from './rpc'
import type {
  CloudDevice,
  CloudErrorCode,
  CloudVault,
  CloudVaultRef,
  DeleteCloudDataResult,
  EncryptedSyncRecord,
  PullResult,
  PushResult,
  ServerErrorCode,
  SyncStatus,
} from './types'
import type { VaultHeaderV2 } from '@/lib/vault'
import { createBrowserSupabaseClient } from '@/lib/supabase'

// CloudError and the rpc types live in ./rpc (shared with the Family space
// client); they are re-exported here so existing imports from
// '@/lib/cloud/api' keep working.
export { CloudError } from './rpc'
export type { RpcError, RpcResponse, RpcFn } from './rpc'

export interface CloudApi {
  getSyncStatus: () => Promise<SyncStatus>
  getVault: () => Promise<CloudVault | null>
  registerDevice: (deviceId: string, label: string) => Promise<CloudDevice>
  listDevices: () => Promise<Array<CloudDevice>>
  renameDevice: (deviceId: string, label: string) => Promise<CloudDevice>
  removeDevice: (deviceId: string) => Promise<CloudDevice>
  createVault: (
    deviceId: string,
    vaultId: string,
    header: VaultHeaderV2,
  ) => Promise<CloudVaultRef>
  updateVaultHeader: (
    deviceId: string,
    vaultId: string,
    header: VaultHeaderV2,
    expectedRev: number,
  ) => Promise<CloudVaultRef>
  pushRecords: (
    deviceId: string,
    vaultId: string,
    records: Array<EncryptedSyncRecord>,
  ) => Promise<PushResult>
  pullRecords: (
    deviceId: string,
    vaultId: string,
    since: number,
    limit?: number,
  ) => Promise<PullResult>
  deleteCloudData: () => Promise<DeleteCloudDataResult>
}

// ── Error mapping ─────────────────────────────────────────────────────────────

const MINIMA_CODE = /MINIMA:([a-z_]+)/

function isServerErrorCode(code: string): code is ServerErrorCode {
  return (SERVER_ERROR_CODES as ReadonlyArray<string>).includes(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// The code inside a `MINIMA:<code>` message: the code itself when the server
// knows it, 'unknown' for any other MINIMA code, null without one.
function minimaCode(message: string): CloudErrorCode | null {
  const match = MINIMA_CODE.exec(message)
  if (!match) return null
  return isServerErrorCode(match[1]) ? match[1] : 'unknown'
}

function fromResponse(res: { error?: unknown; status?: unknown }): CloudError {
  const message =
    isRecord(res.error) && typeof res.error.message === 'string'
      ? res.error.message
      : ''
  const code = minimaCode(message)
  if (code) return new CloudError(code, message)
  // postgrest-js reports a failed fetch as status 0.
  if (res.status === 0)
    return new CloudError('network', message || 'Network error')
  if (res.status === 401)
    return new CloudError('not_signed_in', message || 'Not signed in')
  return new CloudError('unknown', message || 'Unexpected server error')
}

// Maps anything a call can fail with to a CloudError: an RpcError (by its
// MINIMA code), an RpcResponse with an error, or an existing CloudError.
export function toCloudError(err: unknown): CloudError {
  if (err instanceof CloudError) return err
  if (isRecord(err) && 'error' in err && isRecord(err.error))
    return fromResponse(err)
  if (isRecord(err) && typeof err.message === 'string') {
    const code = minimaCode(err.message)
    return new CloudError(code ?? 'unknown', err.message)
  }
  return new CloudError('unknown', 'Unexpected error')
}

// ── Response schemas (mirror the SQL return shapes; extra keys are stripped) ──

const planFeaturesSchema = z.object({
  sync: z.boolean(),
  max_devices: z.number(),
  max_records: z.number(),
  max_bytes: z.number(),
})

const syncStatusSchema = z.object({
  plan_id: z.string(),
  has_sync: z.boolean(),
  free_for_all: z.boolean(),
  granted_by: z.enum(['entitlement', 'free_for_all', 'default']),
  beta_joined_at: z.string().nullable(),
  entitlement_status: z.enum(['active', 'past_due', 'canceled']).nullable(),
  current_period_end: z.string().nullable(),
  limits: planFeaturesSchema,
  vault: z
    .object({
      vault_id: z.string(),
      header_rev: z.number(),
      record_count: z.number(),
      total_bytes: z.number(),
      last_seq: z.number(),
    })
    .nullable(),
  devices_count: z.number(),
})

// The same checks as vault.ts's header validation, plus the string fields.
const vaultHeaderSchema = z.object({
  v: z.literal(2),
  vaultId: z.string(),
  createdAt: z.string(),
  kdf: z.object({
    alg: z.literal('PBKDF2-SHA256'),
    iterations: z.number(),
    salt: z.string(),
  }),
  wrappedByPassword: z.object({ iv: z.string(), ct: z.string() }),
  recovery: z.object({ salt: z.string(), iv: z.string(), ct: z.string() }),
  verifier: z.object({ iv: z.string(), ct: z.string() }),
})

const vaultSchema = z
  .object({
    vault_id: z.string(),
    header: vaultHeaderSchema,
    header_rev: z.number(),
  })
  .nullable()

const vaultRefSchema = z.object({
  vault_id: z.string(),
  header_rev: z.number(),
})

const deviceSchema = z.object({
  device_id: z.string(),
  label: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  removed_at: z.string().nullable(),
})

const recordRowSchema = z.object({
  record_key: z.string(),
  ciphertext: z.string(),
  iv: z.string(),
  enc_v: z.number(),
  updated_at_ms: z.number(),
  device_id: z.string(),
  seq: z.number(),
})

const pushResultSchema = z.object({
  results: z.array(
    z.discriminatedUnion('status', [
      z.object({
        record_key: z.string(),
        status: z.literal('accepted'),
        seq: z.number(),
      }),
      z.object({
        record_key: z.string(),
        status: z.literal('stale'),
        current: recordRowSchema,
      }),
    ]),
  ),
  last_seq: z.number(),
})

const pullResultSchema = z.object({
  records: z.array(recordRowSchema),
  has_more: z.boolean(),
  last_seq: z.number(),
  vault_id: z.string(),
})

const deleteResultSchema = z.object({ deleted_records: z.number() })

// ── Client ────────────────────────────────────────────────────────────────────

// The browser Supabase client, created at call time (never at import).
const defaultRpc: RpcFn = (fn, args) =>
  createBrowserSupabaseClient().rpc(fn, args)

export function createCloudApi(rpc: RpcFn = defaultRpc): CloudApi {
  async function call<T>(
    fn: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let res: RpcResponse
    try {
      res = await rpc(fn, args)
    } catch (err) {
      // A rejected call never reached the server (e.g. "Failed to fetch").
      throw new CloudError(
        'network',
        err instanceof Error && err.message ? err.message : 'Network error',
      )
    }
    if (res.error) throw fromResponse(res)
    const parsed = schema.safeParse(res.data)
    if (!parsed.success) {
      throw new CloudError('unknown', `Unexpected response from ${fn}`)
    }
    return parsed.data
  }

  return {
    getSyncStatus: () =>
      call<SyncStatus>('get_sync_status', {}, syncStatusSchema),
    getVault: () => call<CloudVault | null>('get_vault', {}, vaultSchema),
    registerDevice: (deviceId, label) =>
      call<CloudDevice>(
        'register_device',
        { p_device_id: deviceId, p_label: label },
        deviceSchema,
      ),
    listDevices: () =>
      call<Array<CloudDevice>>('list_devices', {}, z.array(deviceSchema)),
    renameDevice: (deviceId, label) =>
      call<CloudDevice>(
        'rename_device',
        { p_device_id: deviceId, p_label: label },
        deviceSchema,
      ),
    removeDevice: (deviceId) =>
      call<CloudDevice>(
        'remove_device',
        { p_device_id: deviceId },
        deviceSchema,
      ),
    createVault: (deviceId, vaultId, header) =>
      call<CloudVaultRef>(
        'create_vault',
        { p_device_id: deviceId, p_vault_id: vaultId, p_header: header },
        vaultRefSchema,
      ),
    updateVaultHeader: (deviceId, vaultId, header, expectedRev) =>
      call<CloudVaultRef>(
        'update_vault_header',
        {
          p_device_id: deviceId,
          p_vault_id: vaultId,
          p_header: header,
          p_expected_rev: expectedRev,
        },
        vaultRefSchema,
      ),
    pushRecords: (deviceId, vaultId, records) =>
      call<PushResult>(
        'push_records',
        { p_device_id: deviceId, p_vault_id: vaultId, p_records: records },
        pushResultSchema,
      ),
    pullRecords: (deviceId, vaultId, since, limit) =>
      call<PullResult>(
        'pull_records',
        {
          p_device_id: deviceId,
          p_vault_id: vaultId,
          p_since: since,
          ...(limit === undefined ? {} : { p_limit: limit }),
        },
        pullResultSchema,
      ),
    deleteCloudData: () =>
      call<DeleteCloudDataResult>('delete_cloud_data', {}, deleteResultSchema),
  }
}
