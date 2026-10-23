// @vitest-environment node
// No CONTRACT_GAPs: push_records / pull_records / delete_cloud_data behaviour is
// specified in plan section 3 (decision D3) and acceptance criteria 11 to 16.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  expectMinima,
  expectOk,
  newDeviceId,
  pull,
  push,
  startDb,
  userWithVault,
  validHeader,
  wireRecord,
} from './harness'
import type { Fixture, SqlTestDb } from './harness'

let ctx: SqlTestDb

beforeAll(async () => {
  ctx = await startDb()
  await ctx.admin(
    `insert into public.plans (id, name, features, is_public)
     values ('test-small', 'T', '{"sync":true,"max_devices":2,"max_records":3,"max_bytes":1000}'::jsonb, false)
     on conflict (id) do nothing`,
  )
}, 60_000)

afterAll(async () => {
  await ctx.close()
})

interface PushOut {
  results: Array<
    | { record_key: string; status: 'accepted'; seq: number }
    | { record_key: string; status: 'stale'; current: PulledRow }
  >
  last_seq: number
}
interface PulledRow {
  record_key: string
  ciphertext: string
  iv: string
  enc_v: number
  updated_at_ms: number
  device_id: string
  seq: number
}
interface PullOut {
  records: Array<PulledRow>
  has_more: boolean
  last_seq: number
  vault_id: string
}
interface StatusOut {
  vault: {
    record_count: number
    total_bytes: number
    last_seq: number
  } | null
}

async function limitedUser(): Promise<Fixture> {
  const f = await userWithVault(ctx)
  await ctx.admin(
    `insert into public.entitlements (user_id, plan_id, status, source)
     values ($1, 'test-small', 'active', 'manual')
     on conflict (user_id) do update set plan_id = 'test-small', status = 'active'`,
    [f.userId],
  )
  return f
}

async function counters(f: Fixture) {
  const s = expectOk<StatusOut>(await f.rpc('get_sync_status'))
  return s.vault
}

async function rowsOf(f: Fixture) {
  return ctx.admin<{
    record_key: string
    ciphertext: string
    size: number
    seq: string
    updated_at_ms: string
  }>(
    'select record_key, ciphertext, size, seq::text as seq, updated_at_ms::text as updated_at_ms from public.sync_records where user_id = $1 order by seq',
    [f.userId],
  )
}

describe('seq and pull (criterion 11)', () => {
  it('assigns strictly increasing seq per user, in input order', async () => {
    const f = await userWithVault(ctx)
    const first = expectOk<PushOut>(
      await push(f, [wireRecord(1), wireRecord(2), wireRecord(3)]),
    )
    expect(first.results.map((r) => r.record_key)).toEqual([
      wireRecord(1).record_key,
      wireRecord(2).record_key,
      wireRecord(3).record_key,
    ])
    expect(first.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted'])
    expect(first.results.map((r) => (r.status === 'accepted' ? r.seq : -1))).toEqual([1, 2, 3])
    expect(first.last_seq).toBe(3)

    const second = expectOk<PushOut>(await push(f, [wireRecord(4), wireRecord(5)]))
    expect(second.results.map((r) => (r.status === 'accepted' ? r.seq : -1))).toEqual([4, 5])
    expect(second.last_seq).toBe(5)
  })

  it('seq is per user, not global', async () => {
    const a = await userWithVault(ctx)
    const b = await userWithVault(ctx)
    expectOk(await push(a, [wireRecord(1), wireRecord(2), wireRecord(3)]))
    const res = expectOk<PushOut>(await push(b, [wireRecord(1)]))
    expect(res.results[0]).toMatchObject({ status: 'accepted', seq: 1 })
  })

  it('pull(since) returns exactly the rows after since, ordered by seq', async () => {
    const f = await userWithVault(ctx)
    expectOk(
      await push(f, [wireRecord(1), wireRecord(2), wireRecord(3), wireRecord(4), wireRecord(5)]),
    )

    const all = expectOk<PullOut>(await pull(f, 0))
    expect(all.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5])
    expect(all.has_more).toBe(false)
    expect(all.last_seq).toBe(5)
    expect(all.vault_id).toBe(f.vaultId)

    const after2 = expectOk<PullOut>(await pull(f, 2))
    expect(after2.records.map((r) => r.record_key)).toEqual([
      wireRecord(3).record_key,
      wireRecord(4).record_key,
      wireRecord(5).record_key,
    ])

    const after5 = expectOk<PullOut>(await pull(f, 5))
    expect(after5.records).toEqual([])
    expect(after5.has_more).toBe(false)
    expect(after5.last_seq).toBe(5)
  })

  it('pages with limit 2 over 5 rows: 2, 2, 1 with has_more true, true, false', async () => {
    const f = await userWithVault(ctx)
    expectOk(
      await push(f, [wireRecord(1), wireRecord(2), wireRecord(3), wireRecord(4), wireRecord(5)]),
    )

    const p1 = expectOk<PullOut>(await pull(f, 0, 2))
    expect(p1.records.map((r) => r.seq)).toEqual([1, 2])
    expect(p1.has_more).toBe(true)
    expect(p1.last_seq).toBe(5)

    const p2 = expectOk<PullOut>(await pull(f, 2, 2))
    expect(p2.records.map((r) => r.seq)).toEqual([3, 4])
    expect(p2.has_more).toBe(true)

    const p3 = expectOk<PullOut>(await pull(f, 4, 2))
    expect(p3.records.map((r) => r.seq)).toEqual([5])
    expect(p3.has_more).toBe(false)

    const exact = expectOk<PullOut>(await pull(f, 3, 2))
    expect(exact.records.map((r) => r.seq)).toEqual([4, 5])
    expect(exact.has_more).toBe(false)
  })

  it('pulled rows carry the record row shape and the writer device_id', async () => {
    const f = await userWithVault(ctx)
    const second = newDeviceId()
    expectOk(await f.rpc('register_device', { p_device_id: second, p_label: 'Second' }))
    const rec = wireRecord(1, 4242, 30, 'z')
    expectOk(await push(f, [rec], second))

    const out = expectOk<PullOut>(await pull(f, 0))
    expect(out.records).toEqual([
      {
        record_key: rec.record_key,
        ciphertext: rec.ciphertext,
        iv: rec.iv,
        enc_v: 1,
        updated_at_ms: 4242,
        device_id: second,
        seq: 1,
      },
    ])
  })

  it('pull validates since and limit', async () => {
    const f = await userWithVault(ctx)
    expectMinima(await pull(f, -1), 'invalid_input')
    expectMinima(
      await f.rpc('pull_records', {
        p_device_id: f.deviceId,
        p_vault_id: f.vaultId,
        p_since: null,
      }),
      'invalid_input',
    )
    expectMinima(await pull(f, 0, 0), 'invalid_input')
    expectMinima(await pull(f, 0, 1001), 'invalid_input')
    expectMinima(
      await f.rpc('pull_records', {
        p_device_id: f.deviceId,
        p_vault_id: f.vaultId,
        p_since: 0,
        p_limit: null,
      }),
      'invalid_input',
    )
    expectOk(await pull(f, 0, 1000))
    expectOk(await pull(f, 0, 1))
  })

  it('push and pull refresh the device last_seen_at', async () => {
    const f = await userWithVault(ctx)
    const seen = async () =>
      Date.parse(
        expectOk<Array<{ last_seen_at: string }>>(await f.rpc('list_devices'))[0].last_seen_at,
      )
    const backdate = async () => {
      await ctx.admin(
        `update public.devices set last_seen_at = now() - interval '1 hour' where device_id = $1`,
        [f.deviceId],
      )
    }
    // Not wall-clock gaps between calls: reset to an hour ago before each call.
    const recent = Date.now() - 30 * 60_000

    await backdate()
    expect(await seen()).toBeLessThan(recent)
    expectOk(await push(f, [wireRecord(1)]))
    expect(await seen()).toBeGreaterThan(recent)

    await backdate()
    expect(await seen()).toBeLessThan(recent)
    expectOk(await pull(f, 0))
    expect(await seen()).toBeGreaterThan(recent)
  })
})

describe('stale and replacement (criterion 12)', () => {
  it('an equal updated_at_ms is stale, returns the current row and changes nothing', async () => {
    const f = await userWithVault(ctx)
    const original = wireRecord(1, 1000, 24, 'o')
    expectOk(await push(f, [original]))

    const res = expectOk<PushOut>(
      await push(f, [{ ...original, ciphertext: 'n'.repeat(24) }]),
    )
    expect(res.results).toHaveLength(1)
    const r = res.results[0]
    expect(r.status).toBe('stale')
    if (r.status === 'stale') {
      expect(r.current).toMatchObject({
        record_key: original.record_key,
        ciphertext: original.ciphertext,
        seq: 1,
        updated_at_ms: 1000,
      })
    }
    expect(res.last_seq).toBe(1)
    const stored = await rowsOf(f)
    expect(stored).toHaveLength(1)
    expect(stored[0].ciphertext).toBe(original.ciphertext)
    expect(stored[0].seq).toBe('1')
  })

  it('an older updated_at_ms is stale too', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1, 5000, 24, 'o')]))

    const res = expectOk<PushOut>(await push(f, [wireRecord(1, 4999, 24, 'x')]))
    expect(res.results[0].status).toBe('stale')
    const out = expectOk<PullOut>(await pull(f, 0))
    expect(out.records).toHaveLength(1)
    expect(out.records[0].ciphertext).toBe('o'.repeat(24))
    expect(out.last_seq).toBe(1)
  })

  it('a newer updated_at_ms replaces the row and gets a new seq', async () => {
    const f = await userWithVault(ctx)
    const second = newDeviceId()
    expectOk(await f.rpc('register_device', { p_device_id: second, p_label: 'Second' }))
    expectOk(await push(f, [wireRecord(1, 1000, 24, 'o'), wireRecord(2, 1000, 24, 'p')]))

    const res = expectOk<PushOut>(await push(f, [wireRecord(1, 2000, 30, 'n')], second))
    expect(res.results[0]).toMatchObject({ status: 'accepted', seq: 3 })
    expect(res.last_seq).toBe(3)

    const all = expectOk<PullOut>(await pull(f, 0))
    expect(all.records.map((r) => r.record_key)).toEqual([
      wireRecord(2).record_key,
      wireRecord(1).record_key,
    ])
    const replaced = all.records[1]
    expect(replaced.ciphertext).toBe('n'.repeat(30))
    expect(replaced.updated_at_ms).toBe(2000)
    expect(replaced.seq).toBe(3)
    expect(replaced.device_id).toBe(second)

    const since2 = expectOk<PullOut>(await pull(f, 2))
    expect(since2.records.map((r) => r.record_key)).toEqual([wireRecord(1).record_key])
  })

  it('handles accepted and stale results in one batch, in input order', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1, 1000)]))

    const res = expectOk<PushOut>(
      await push(f, [wireRecord(2, 1000), wireRecord(1, 1000), wireRecord(3, 1000)]),
    )
    expect(res.results.map((r) => r.status)).toEqual(['accepted', 'stale', 'accepted'])
    expect(res.results.map((r) => r.record_key)).toEqual([
      wireRecord(2).record_key,
      wireRecord(1).record_key,
      wireRecord(3).record_key,
    ])
    expect(res.last_seq).toBe(3)
  })
})

describe('batch limits (criterion 13)', () => {
  it('accepts 500 records and refuses 501 with batch_too_large', async () => {
    const f = await userWithVault(ctx)
    const many = (n: number) => Array.from({ length: n }, (_, i) => wireRecord(i + 1, 1000, 8))

    expectMinima(await push(f, many(501)), 'batch_too_large')
    expect(expectOk<PullOut>(await pull(f, 0)).records).toHaveLength(0)

    const ok = expectOk<PushOut>(await push(f, many(500)))
    expect(ok.results).toHaveLength(500)
    expect(ok.last_seq).toBe(500)
  }, 60_000)

  it('refuses more than 1 MB of ciphertext with batch_too_large', async () => {
    const f = await userWithVault(ctx)
    const big = (n: number) =>
      Array.from({ length: n }, (_, i) => wireRecord(i + 1, 1000, 65536))

    expectMinima(await push(f, big(17)), 'batch_too_large')
    expect(expectOk<PullOut>(await pull(f, 0)).records).toHaveLength(0)

    // Exactly 1048576 characters is allowed.
    const ok = expectOk<PushOut>(await push(f, big(16)))
    expect(ok.results).toHaveLength(16)
  }, 60_000)

  it('checks the batch size before the element contents', async () => {
    const f = await userWithVault(ctx)
    const junk = Array.from({ length: 501 }, () => 'not an object')
    expectMinima(await push(f, junk), 'batch_too_large')
  })

  it('accepts an empty array and returns the current last_seq', async () => {
    const f = await userWithVault(ctx)
    expect(expectOk(await push(f, []))).toEqual({ results: [], last_seq: 0 })
    expectOk(await push(f, [wireRecord(1), wireRecord(2)]))
    expect(expectOk(await push(f, []))).toEqual({ results: [], last_seq: 2 })
  })

  it('refuses a non-array with invalid_input', async () => {
    const f = await userWithVault(ctx)
    expectMinima(await push(f, {} as unknown as Array<unknown>), 'invalid_input')
    expectMinima(await push(f, 5 as unknown as Array<unknown>), 'invalid_input')
  })
})

describe('element validation', () => {
  const bad: Array<[string, unknown]> = [
    ['not an object', 'a string'],
    ['a number', 7],
    ['record_key too short', { ...wireRecord(1), record_key: 'short-key-15chrs' .slice(0, 15) }],
    ['record_key with a plus', { ...wireRecord(1), record_key: `${'a'.repeat(20)}+` }],
    ['record_key with padding', { ...wireRecord(1), record_key: `${'a'.repeat(20)}=` }],
    ['record_key too long', { ...wireRecord(1), record_key: 'a'.repeat(129) }],
    // A JSON number record_key must be rejected: the server requires jsonb_typeof = 'string'.
    ['record_key not a string', { ...wireRecord(1), record_key: 12345678901234567890 }],
    ['empty ciphertext', { ...wireRecord(1), ciphertext: '' }],
    ['ciphertext too long', { ...wireRecord(1), ciphertext: 'c'.repeat(65537) }],
    ['ciphertext not a string', { ...wireRecord(1), ciphertext: 123 }],
    ['empty iv', { ...wireRecord(1), iv: '' }],
    ['iv too long', { ...wireRecord(1), iv: 'i'.repeat(33) }],
    ['enc_v 2', { ...wireRecord(1), enc_v: 2 }],
    ['enc_v as a string', { ...wireRecord(1), enc_v: '1' }],
    ['enc_v missing', (() => {
      const r: Record<string, unknown> = { ...wireRecord(1) }
      delete r.enc_v
      return r
    })()],
    ['negative updated_at_ms', { ...wireRecord(1), updated_at_ms: -1 }],
    ['fractional updated_at_ms', { ...wireRecord(1), updated_at_ms: 1.5 }],
    ['updated_at_ms above 2^53-1', { ...wireRecord(1), updated_at_ms: 9007199254740992 }],
    ['updated_at_ms as a string', { ...wireRecord(1), updated_at_ms: '5' }],
    ['updated_at_ms null', { ...wireRecord(1), updated_at_ms: null }],
  ]

  it.each(bad)('rejects %s with invalid_input', async (_name, record) => {
    const f = await userWithVault(ctx)
    expectMinima(await push(f, [record]), 'invalid_input')
    expect(expectOk<PullOut>(await pull(f, 0)).records).toHaveLength(0)
  })

  it('rejects the same record_key twice in one batch', async () => {
    const f = await userWithVault(ctx)
    expectMinima(await push(f, [wireRecord(1, 1000), wireRecord(1, 2000)]), 'invalid_input')
  })

  it('is all or nothing: a bad element after good ones writes nothing', async () => {
    const f = await userWithVault(ctx)
    expectMinima(
      await push(f, [wireRecord(1), wireRecord(2), { ...wireRecord(3), enc_v: 9 }]),
      'invalid_input',
    )
    const out = expectOk<PullOut>(await pull(f, 0))
    expect(out.records).toEqual([])
    expect(out.last_seq).toBe(0)
  })

  it('accepts the boundary values', async () => {
    const f = await userWithVault(ctx)
    const res = expectOk<PushOut>(
      await push(f, [
        { ...wireRecord(1), record_key: 'a'.repeat(16), updated_at_ms: 0 },
        { ...wireRecord(2), record_key: 'b'.repeat(128), updated_at_ms: 9007199254740991 },
        { ...wireRecord(3), ciphertext: 'c'.repeat(65536), iv: 'i'.repeat(32) },
        { ...wireRecord(4), record_key: `${'A-_'.repeat(5)}9` },
      ]),
    )
    expect(res.results.map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ])
    const out = expectOk<PullOut>(await pull(f, 0))
    expect(out.records.find((r) => r.record_key === 'b'.repeat(128))?.updated_at_ms).toBe(
      9007199254740991,
    )
  })
})

describe('quota (criterion 13)', () => {
  it('exceeding max_records raises quota_exceeded and rolls back the whole batch', async () => {
    const f = await limitedUser()
    expectMinima(
      await push(f, [wireRecord(1), wireRecord(2), wireRecord(3), wireRecord(4)]),
      'quota_exceeded',
    )
    expect(await rowsOf(f)).toHaveLength(0)
    expect(await counters(f)).toMatchObject({ record_count: 0, total_bytes: 0, last_seq: 0 })
    expect(expectOk<PullOut>(await pull(f, 0)).records).toEqual([])
  })

  it('a push over max_records after earlier pushes leaves the earlier data and seq intact', async () => {
    const f = await limitedUser()
    expectOk(await push(f, [wireRecord(1), wireRecord(2), wireRecord(3)]))

    expectMinima(await push(f, [wireRecord(4)]), 'quota_exceeded')
    expect(await counters(f)).toMatchObject({ record_count: 3, last_seq: 3 })
    expect(await rowsOf(f)).toHaveLength(3)

    // Replacing an existing record does not add to the count.
    const ok = expectOk<PushOut>(await push(f, [wireRecord(2, 5000)]))
    expect(ok.results[0]).toMatchObject({ status: 'accepted', seq: 4 })
  })

  it('exceeding max_bytes raises quota_exceeded; exactly max_bytes is fine', async () => {
    const f = await limitedUser()
    expectMinima(
      await push(f, [wireRecord(1, 1000, 600), wireRecord(2, 1000, 600)]),
      'quota_exceeded',
    )
    expect(await rowsOf(f)).toHaveLength(0)

    expectMinima(await push(f, [wireRecord(1, 1000, 1001)]), 'quota_exceeded')
    const ok = expectOk<PushOut>(await push(f, [wireRecord(1, 1000, 1000)]))
    expect(ok.results[0].status).toBe('accepted')
    expect(await counters(f)).toMatchObject({ record_count: 1, total_bytes: 1000 })
  })

  it('a replacement that pushes total_bytes over the limit rolls back', async () => {
    const f = await limitedUser()
    expectOk(await push(f, [wireRecord(1, 1000, 500, 'a'), wireRecord(2, 1000, 400, 'b')]))

    expectMinima(await push(f, [wireRecord(1, 2000, 700, 'n')]), 'quota_exceeded')

    const stored = await rowsOf(f)
    expect(stored.find((r) => r.record_key === wireRecord(1).record_key)?.ciphertext).toBe(
      'a'.repeat(500),
    )
    expect(await counters(f)).toMatchObject({ record_count: 2, total_bytes: 900, last_seq: 2 })
  })

  it('a different plan has different limits: beta users are not limited to 3 records', async () => {
    const f = await userWithVault(ctx)
    const res = expectOk<PushOut>(
      await push(f, [wireRecord(1), wireRecord(2), wireRecord(3), wireRecord(4)]),
    )
    expect(res.results).toHaveLength(4)
  })

  it('the device limit follows the plan row too', async () => {
    const f = await limitedUser()
    expectOk(await f.rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Second' }))
    expectMinima(
      await f.rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Third' }),
      'device_limit',
    )
  })
})

describe('counters (criterion 14)', () => {
  it('record_count and total_bytes stay correct after inserts and replacements', async () => {
    const f = await userWithVault(ctx)
    expectOk(
      await push(f, [wireRecord(1, 1000, 10), wireRecord(2, 1000, 20), wireRecord(3, 1000, 30)]),
    )
    expect(await counters(f)).toEqual({
      vault_id: f.vaultId,
      header_rev: 1,
      record_count: 3,
      total_bytes: 60,
      last_seq: 3,
    })

    // Replace the 20 with a 50.
    expectOk(await push(f, [wireRecord(2, 2000, 50)]))
    expect(await counters(f)).toMatchObject({ record_count: 3, total_bytes: 90, last_seq: 4 })

    // Replace the 50 with a 5.
    expectOk(await push(f, [wireRecord(2, 3000, 5)]))
    expect(await counters(f)).toMatchObject({ record_count: 3, total_bytes: 45, last_seq: 5 })

    // A stale write changes nothing.
    expectOk(await push(f, [wireRecord(3, 1000, 400)]))
    expect(await counters(f)).toMatchObject({ record_count: 3, total_bytes: 45, last_seq: 5 })

    const sizes = await rowsOf(f)
    expect(sizes.map((r) => Number(r.size)).sort((x, y) => x - y)).toEqual([5, 10, 30])
  })

  it('stored size is the ciphertext length', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1, 1000, 77)]))
    const rows = await rowsOf(f)
    expect(Number(rows[0].size)).toBe(77)
    expect(rows[0].ciphertext).toHaveLength(77)
  })
})

describe('delete_cloud_data (criterion 15)', () => {
  it('removes records, vault and devices and keeps the entitlement', async () => {
    const f = await userWithVault(ctx)
    expectOk(await f.rpc('register_device', { p_device_id: newDeviceId(), p_label: 'Two' }))
    expectOk(await push(f, [wireRecord(1), wireRecord(2), wireRecord(3)]))

    const res = expectOk<{ deleted_records: number }>(await f.rpc('delete_cloud_data'))
    expect(res).toEqual({ deleted_records: 3 })

    for (const table of ['sync_records', 'vaults', 'devices']) {
      const rows = await ctx.admin(`select 1 from public.${table} where user_id = $1`, [
        f.userId,
      ])
      expect(rows, table).toHaveLength(0)
    }
    const ent = await ctx.admin<{ plan_id: string }>(
      'select plan_id from public.entitlements where user_id = $1',
      [f.userId],
    )
    expect(ent).toHaveLength(1)
    expect(expectOk(await f.rpc('get_vault'))).toBeNull()
  })

  it('returns 0 when there is nothing to delete', async () => {
    const userId = await ctx.createUser()
    expect(expectOk(await ctx.rpcAs(userId)('delete_cloud_data'))).toEqual({
      deleted_records: 0,
    })
  })

  it('lets the user start over, with seq starting again at 1', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1), wireRecord(2)]))
    expectOk(await f.rpc('delete_cloud_data'))

    expectOk(await f.rpc('register_device', { p_device_id: f.deviceId, p_label: 'Again' }))
    expectOk(
      await f.rpc('create_vault', {
        p_device_id: f.deviceId,
        p_vault_id: 'fresh-vault',
        p_header: validHeader('fresh-vault'),
      }),
    )
    const res = expectOk<PushOut>(
      await f.rpc('push_records', {
        p_device_id: f.deviceId,
        p_vault_id: 'fresh-vault',
        p_records: [wireRecord(1)],
      }),
    )
    expect(res.results[0]).toMatchObject({ status: 'accepted', seq: 1 })
  })
})

describe('cascade (criterion 16)', () => {
  async function counts(userId: string) {
    const out: Record<string, number> = {}
    for (const table of ['entitlements', 'vaults', 'devices', 'sync_records']) {
      const rows = await ctx.admin(`select 1 from public.${table} where user_id = $1`, [
        userId,
      ])
      out[table] = rows.length
    }
    return out
  }

  it('delete_own_account removes the user rows in all four tables', async () => {
    const f = await userWithVault(ctx)
    const other = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1), wireRecord(2)]))
    expectOk(await push(other, [wireRecord(1)]))
    expect(await counts(f.userId)).toEqual({
      entitlements: 1,
      vaults: 1,
      devices: 1,
      sync_records: 2,
    })

    await ctx.asUser(f.userId, 'select public.delete_own_account()')

    expect(await counts(f.userId)).toEqual({
      entitlements: 0,
      vaults: 0,
      devices: 0,
      sync_records: 0,
    })
    expect(await ctx.admin('select 1 from auth.users where id = $1', [f.userId])).toHaveLength(0)
    expect((await counts(other.userId)).sync_records).toBe(1)
  })

  it('deleting the auth user directly cascades too', async () => {
    const f = await userWithVault(ctx)
    expectOk(await push(f, [wireRecord(1)]))

    await ctx.admin('delete from auth.users where id = $1', [f.userId])

    expect(await counts(f.userId)).toEqual({
      entitlements: 0,
      vaults: 0,
      devices: 0,
      sync_records: 0,
    })
  })
})
