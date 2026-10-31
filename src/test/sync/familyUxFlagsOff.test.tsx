// CONTRACT_GAP: the Header root is found through its data-active-space
//   attribute (plan section 5); with no Family the attribute must be absent,
//   which is asserted over the whole document.
//
// Criterion 1 / 32: with ENABLE_SPACES off (accounts and sync on), and with the
// flags on but no Family held, the real ActiveSpaceRoot gives the default
// context: no switcher, chip, cue, banner or member UI, no data call, and the
// Supabase client sees no space rpc.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { useAccountsVisible } from '@/lib/accountSession'
import { setVaultPhase } from '@/lib/vaultSession'
import { ActiveSpaceRoot, SpaceReadyGate, useSpaceSwitch } from '@/lib/spaces/switcher'
import Header from '@/components/Header'
import PageShell from '@/components/PageShell'

const flags = vi.hoisted(() => ({ spaces: false, listLocalSpaces: [] as Array<unknown> }))
const { rpc, store } = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: new Map<string, unknown>(),
}))

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  ENABLE_SYNC: true,
  get ENABLE_SPACES() {
    return flags.spaces
  },
}))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountsVisible: vi.fn(),
  useAccountSession: () => ({ userId: 'user-1', email: 'ann@example.com' }),
  getAccountSession: () => Promise.resolve({ userId: 'user-1', email: 'ann@example.com' }),
}))
vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => ({ rpc }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode; [key: string]: unknown }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(store.get(key)),
  getMany: (list: Array<string>) => Promise.resolve(list.map((k) => store.get(k))),
  set: (key: string, value: unknown) => {
    store.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    for (const [k, v] of entries) store.set(k, v)
    return Promise.resolve()
  },
  del: (key: string) => {
    store.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    store.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(store.keys())),
}))

const SWITCH_IDS = [
  'space-switcher',
  'nav-space-switcher',
  'space-chip',
  'space-sync-state',
  'space-title-cue',
  'space-readonly-banner',
  'space-paused-banner',
  'space-settings-header',
  'member-chip',
  'member-filter',
  'paid-by-select',
  'family-month-card',
  'family-empty-state',
]

function Probe() {
  const s = useSpaceSwitch()
  return <output data-testid="probe" data-space={s.spaceId} data-family={s.family?.id ?? ''} data-ready={String(s.ready)} />
}

function renderApp(unlocked = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ActiveSpaceRoot unlocked={unlocked}>
        <SpaceReadyGate>
          <Header />
          <PageShell>
            <Probe />
            <p data-testid="page-body">content</p>
          </PageShell>
        </SpaceReadyGate>
      </ActiveSpaceRoot>
    </QueryClientProvider>,
  )
}

function expectNoFamilyUi() {
  for (const id of SWITCH_IDS) expect(screen.queryByTestId(id), id).toBeNull()
  expect(document.querySelector('[data-active-space]')).toBeNull()
}

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  localStorage.clear()
  flags.spaces = false
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  setVaultPhase('unlocked')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ENABLE_SPACES off', () => {
  it('renders the page with no switcher, chip, cue, banner or member UI', async () => {
    renderApp()

    await waitFor(() => expect(screen.getByTestId('page-body')).toBeTruthy())
    expect(screen.getByTestId('probe').getAttribute('data-space')).toBe('personal')
    expect(screen.getByTestId('probe').getAttribute('data-family')).toBe('')
    expect(screen.getByTestId('probe').getAttribute('data-ready')).toBe('true')
    expectNoFamilyUi()
  })

  it('stays the same when the stored space points at a Family (it is ignored)', async () => {
    localStorage.setItem('minima_active_space', 'fam-1')

    renderApp()

    await waitFor(() => expect(screen.getByTestId('page-body')).toBeTruthy())
    expect(screen.getByTestId('probe').getAttribute('data-space')).toBe('personal')
    expectNoFamilyUi()
  })

  it('makes no space rpc call', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'MINIMA:not_signed_in' }, status: 401 })

    renderApp()
    await waitFor(() => expect(screen.getByTestId('page-body')).toBeTruthy())

    const names = rpc.mock.calls.map((c) => String(c[0]))
    expect(names.filter((n) => /space|get_my_space|invite|join/.test(n))).toEqual([])
  })

  it('the menu sheet has no space switcher either', () => {
    renderApp()

    expect(screen.queryByTestId('nav-space-switch-personal')).toBeNull()
    expect(screen.queryByTestId('nav-space-switch-family')).toBeNull()
  })
})

describe('locked', () => {
  it('shows no Family UI and does not hold the page back', async () => {
    flags.spaces = true

    renderApp(false)

    await waitFor(() => expect(screen.getByTestId('page-body')).toBeTruthy())
    expectNoFamilyUi()
    expect(screen.getByTestId('probe').getAttribute('data-space')).toBe('personal')
  })
})
