// No CONTRACT_GAPs: getSyncStatus keeps limits.shared_spaces / max_members /
// max_space_records / max_space_bytes and `space` when the server sends them
// (Interface Contract, api.ts). A run 2 response is unchanged.

import { describe, expect, it, vi } from 'vitest'

import type { RpcFn, RpcResponse } from '@/lib/cloud/api'
import { createCloudApi } from '@/lib/cloud/api'

const BASE = {
  plan_id: 'family',
  has_sync: true,
  free_for_all: false,
  granted_by: 'entitlement' as const,
  beta_joined_at: null,
  entitlement_status: 'active',
  current_period_end: null,
  limits: { sync: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
  vault: null,
  devices_count: 1,
}

function ok(data: unknown): RpcResponse {
  return { data, error: null, status: 200 }
}

async function statusOf(data: unknown) {
  const rpc = vi.fn<RpcFn>().mockResolvedValue(ok(data))
  return createCloudApi(rpc).getSyncStatus()
}

describe('getSyncStatus with the Family fields', () => {
  it('keeps the Family limits', async () => {
    const status = await statusOf({
      ...BASE,
      limits: {
        ...BASE.limits,
        shared_spaces: true,
        max_members: 5,
        max_space_records: 50000,
        max_space_bytes: 52428800,
      },
    })

    expect(status.limits.shared_spaces).toBe(true)
    expect(status.limits.max_members).toBe(5)
    expect(status.limits.max_space_records).toBe(50000)
    expect(status.limits.max_space_bytes).toBe(52428800)
  })

  it('distinguishes a plan with and without shared_spaces', async () => {
    const withSpaces = await statusOf({ ...BASE, limits: { ...BASE.limits, shared_spaces: true } })
    const without = await statusOf({ ...BASE, limits: { ...BASE.limits, shared_spaces: false } })

    expect(withSpaces.limits.shared_spaces).toBe(true)
    expect(without.limits.shared_spaces).toBe(false)
  })

  it('keeps status.space for a member', async () => {
    const space = { space_id: 'a1b2c3d4-0000-4000-8000-000000000001', role: 'member', status: 'active', paused: true }

    const status = await statusOf({ ...BASE, space })

    expect(status.space).toEqual(space)
  })

  it('accepts space: null', async () => {
    const status = await statusOf({ ...BASE, space: null })

    expect(status.space ?? null).toBeNull()
  })

  it('a run 2 response parses to exactly the same object', async () => {
    const status = await statusOf(BASE)

    expect(status).toEqual(BASE)
    expect('space' in status).toBe(false)
  })

  it('still rejects a response without the required fields', async () => {
    const err = await statusOf({ plan_id: 'x' }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as { name: string }).name).toBe('CloudError')
  })
})
