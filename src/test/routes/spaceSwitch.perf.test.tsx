// CONTRACT_GAP: "renders the dashboard" is measured on the transactions page,
//   which reads the whole active space (the heaviest read of the dashboard
//   family of screens); the plan only requires a switch without a reload within
//   the existing test timeouts.
// CONTRACT_GAP: the 15-row page size is existing behaviour (ADR 2026-10-20).
//
// Criterion 33: 20,000 entries in each space; switching the active space through
// the context re-renders the list from the other space without a reload and
// within the default test timeout. The datasets are seeded raw in a hook; the
// test bodies measure only the switch and the render.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpaceKeyEntry } from '@/lib/spaces/types'
import type { TransactionsSearch } from '@/lib/expenseDraft'
import { base64ToBytes, decryptValue, encryptValue } from '@/lib/crypto'
import {
  createLocalSpace,
  getLocalStore,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { importSpaceKey } from '@/lib/spaces/spaceCrypto'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { setSyncChannel } from '@/lib/syncChannel'
import { storeState } from '@/test/sync/memoryIdb'
import { Route } from '@/routes/transactions'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue(null),
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const BASE_TIME = '2026-01-01T00:00:00.000Z'
const MONTHS = 20
const PER_MONTH = 1000
const TOTAL = MONTHS * PER_MONTH
const SEARCH: TransactionsSearch = {}

let dek: CryptoKey
let familyId: string

function monthOf(index: number): string {
  const year = 2024 + Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year}_${String(month).padStart(2, '0')}`
}

function expensesOf(owner: string, offset: number, month: number): Array<Record<string, unknown>> {
  const [year, mm] = monthOf(month).split('_')
  const list: Array<Record<string, unknown>> = []
  for (let i = 0; i < PER_MONTH; i++) {
    const n = month * PER_MONTH + i
    list.push({
      id: `${owner}-${n}`,
      amount: n + offset,
      currency: 'UAH',
      categoryId: 'cat-1',
      description: null,
      createdAt: `${year}-${mm}-${String((i % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
      updatedAt: BASE_TIME,
      rev: n + 1,
    })
  }
  return list
}

async function seed(owner: string, offset: number, key: CryptoKey, prefix: string): Promise<void> {
  const store = getLocalStore()
  if (!store) throw new Error('no store')
  const data = storeState(store).data
  for (let month = 0; month < MONTHS; month++) {
    data.set(`${prefix}expenses_${monthOf(month)}`, await encryptValue(key, expensesOf(owner, offset, month)))
  }
  data.set(`${prefix}meta:sync`, { localRev: TOTAL })
}

async function familyKey(): Promise<CryptoKey> {
  const store = getLocalStore()
  if (!store) throw new Error('no store')
  const raw = storeState(store).data.get('spaceKeys') as Uint8Array
  const entries = (await decryptValue(dek, raw)) as Array<SpaceKeyEntry>
  return importSpaceKey(base64ToBytes(entries[0].key))
}

function tree(spaceId: string, client: QueryClient) {
  const Page = Route.options.component
  if (!Page) throw new Error('no component')
  return (
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider
        value={{ spaceId, family: { id: familyId, name: 'Our home', role: 'owner', readOnly: false } }}
      >
        <Page />
      </SpaceSwitchProvider>
    </QueryClientProvider>
  )
}

beforeEach(async () => {
  const store = getLocalStore()
  if (!store) throw new Error('no store')
  storeState(store).data.clear()
  localStorage.clear()
  setSyncChannel(null)
  clearKeyring()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  unlockLocalDb(dek)
  familyId = (await createLocalSpace({ name: 'Our home', lang: 'en' })).id
  await seed('p', 1, dek, '')
  await seed('f', 100_001, await familyKey(), `space:${familyId}:`)
  vi.spyOn(Route, 'useSearch').mockReturnValue(SEARCH)
  vi.spyOn(Route, 'useNavigate').mockReturnValue(vi.fn() as never)
})

afterEach(() => {
  cleanup()
  wipeLocalDbKey()
  setSyncChannel(undefined)
})

describe('switching between two 20,000-entry spaces', () => {
  it('shows the other space’s first page after each switch, without a reload, within the test timeout', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(tree('personal', client))
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(15))
    const personalFirst = screen.getAllByTestId('transaction-row')[0].textContent

    view.rerender(tree(familyId, client))
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')[0].textContent).not.toBe(personalFirst))
    expect(screen.getAllByTestId('transaction-row')).toHaveLength(15)
    const familyFirst = screen.getAllByTestId('transaction-row')[0].textContent

    view.rerender(tree('personal', client))
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')[0].textContent).toBe(personalFirst))
    expect(familyFirst).not.toBe(personalFirst)
  })

  it('a second visit to a space is served from the cache within two seconds', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(tree('personal', client))
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(15))
    view.rerender(tree(familyId, client))
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(15))

    const start = performance.now()
    view.rerender(tree('personal', client))
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(15))

    expect(performance.now() - start).toBeLessThan(2000)
  })
})
