// CONTRACT_GAP: the exact return of dbFor(<family id>) is "localDb.spaceDb(id)"
//   (plan section 5); the tests mock `spaceDb` and assert it is called with the
//   id, not any other detail of the handle.
//
// '@/lib/localDb' is replaced by a small factory: the personal handle is the
// module namespace itself, so its top-level mocks are what a personal
// component must call; the Family handle comes from the mocked `spaceDb`.

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import {
  SpaceProvider,
  spaceQueryKey,
  useActiveSpace,
  useSpaceDb,
} from '@/lib/spaces/react'
import { dbFor, spaceArgs, withSpaceOption } from '@/lib/spaces/spaceDb'
import { getAllExpenses, spaceDb } from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getAllExpenses: vi.fn(),
  spaceDb: vi.fn(),
}))

const FAMILY = '3f2b1c4e-0000-4000-8000-00000000aaaa'

const familyGetAll = vi.fn()

let client: QueryClient

function wrapperFor(spaceId?: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <SpaceProvider spaceId={spaceId}>{children}</SpaceProvider>
      </QueryClientProvider>
    )
  }
}

// The same shape every data component uses: key through spaceQueryKey, call
// through the handle at call time.
function useExpenses() {
  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  return useQuery({
    queryKey: spaceQueryKey(spaceId, 'expenses'),
    queryFn: () => db.getAllExpenses(),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  familyGetAll.mockReset()
  vi.mocked(getAllExpenses).mockResolvedValue([{ id: 'personal-1' }] as never)
  familyGetAll.mockResolvedValue([{ id: 'family-1' }])
  vi.mocked(spaceDb).mockImplementation(
    () => ({ getAllExpenses: familyGetAll }) as never,
  )
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

describe('spaceQueryKey', () => {
  it('puts the space id second: [base, spaceId, ...rest]', () => {
    expect(spaceQueryKey('personal', 'expenses', '2026-01-01', '2026-01-31')).toEqual([
      'expenses',
      'personal',
      '2026-01-01',
      '2026-01-31',
    ])
    expect(spaceQueryKey(FAMILY, 'analytics')).toEqual(['analytics', FAMILY])
  })

  it('differs between spaces for the same base and rest', () => {
    expect(spaceQueryKey('personal', 'budgets', 1)).not.toEqual(
      spaceQueryKey(FAMILY, 'budgets', 1),
    )
  })

  it('keeps the base as the prefix, so base invalidation covers every space', () => {
    expect(spaceQueryKey(FAMILY, 'expenses', 'x')[0]).toBe('expenses')
    expect(spaceQueryKey('personal', 'expenses', 'x')[0]).toBe('expenses')
  })
})

describe('useActiveSpace', () => {
  it('is personal without a provider', () => {
    const { result } = renderHook(() => useActiveSpace())

    expect(result.current).toBe('personal')
  })

  it('is personal for a provider without a spaceId', () => {
    const { result } = renderHook(() => useActiveSpace(), { wrapper: wrapperFor() })

    expect(result.current).toBe('personal')
  })

  it('is personal for a provider even when minima_active_space names another space', () => {
    localStorage.setItem('minima_active_space', FAMILY)

    const { result } = renderHook(() => useActiveSpace(), { wrapper: wrapperFor() })

    expect(result.current).toBe('personal')
    localStorage.clear()
  })

  it('returns the spaceId a test sets on the provider', () => {
    const { result } = renderHook(() => useActiveSpace(), {
      wrapper: wrapperFor(FAMILY),
    })

    expect(result.current).toBe(FAMILY)
  })
})

describe('useSpaceDb', () => {
  it('personal: members are the top-level localDb functions', async () => {
    const { result } = renderHook(() => useSpaceDb(), { wrapper: wrapperFor() })

    await result.current.getAllExpenses()

    expect(getAllExpenses).toHaveBeenCalledTimes(1)
    expect(familyGetAll).not.toHaveBeenCalled()
    expect(spaceDb).not.toHaveBeenCalled()
  })

  it('family: members come from spaceDb(spaceId)', async () => {
    const { result } = renderHook(() => useSpaceDb(), { wrapper: wrapperFor(FAMILY) })

    await result.current.getAllExpenses()

    expect(spaceDb).toHaveBeenCalledWith(FAMILY)
    expect(familyGetAll).toHaveBeenCalledTimes(1)
    expect(getAllExpenses).not.toHaveBeenCalled()
  })

  it('returns the same handle across re-renders of one space', () => {
    const { result, rerender } = renderHook(() => useSpaceDb(), {
      wrapper: wrapperFor(FAMILY),
    })
    const first = result.current

    rerender()

    expect(result.current).toBe(first)
  })
})

describe('personal and Family caches never mix', () => {
  it('stores each space under its own key with its own data', async () => {
    const personal = renderHook(() => useExpenses(), { wrapper: wrapperFor() })
    const family = renderHook(() => useExpenses(), { wrapper: wrapperFor(FAMILY) })

    await waitFor(() => {
      expect(personal.result.current.data).toBeDefined()
      expect(family.result.current.data).toBeDefined()
    })

    expect(personal.result.current.data).toEqual([{ id: 'personal-1' }])
    expect(family.result.current.data).toEqual([{ id: 'family-1' }])
    expect(client.getQueryData(['expenses', 'personal'])).toEqual([{ id: 'personal-1' }])
    expect(client.getQueryData(['expenses', FAMILY])).toEqual([{ id: 'family-1' }])
  })

  it('switching the space shows the other space’s data, not the cached one of the first', async () => {
    let current = 'personal'
    // One stable wrapper component that reads the current space on render.
    function Dynamic({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <SpaceProvider spaceId={current}>{children}</SpaceProvider>
        </QueryClientProvider>
      )
    }
    const { result, rerender } = renderHook(() => useExpenses(), { wrapper: Dynamic })
    await waitFor(() => {
      expect(result.current.data).toEqual([{ id: 'personal-1' }])
    })

    current = FAMILY
    rerender()

    await waitFor(() => {
      expect(result.current.data).toEqual([{ id: 'family-1' }])
    })
    expect(getAllExpenses).toHaveBeenCalledTimes(1)
  })

  it('invalidating the base key refetches the queries of every space', async () => {
    const personal = renderHook(() => useExpenses(), { wrapper: wrapperFor() })
    const family = renderHook(() => useExpenses(), { wrapper: wrapperFor(FAMILY) })
    await waitFor(() => {
      expect(personal.result.current.data).toBeDefined()
      expect(family.result.current.data).toBeDefined()
    })
    vi.mocked(getAllExpenses).mockResolvedValue([{ id: 'personal-2' }] as never)
    familyGetAll.mockResolvedValue([{ id: 'family-2' }])

    await client.invalidateQueries({ queryKey: ['expenses'] })

    await waitFor(() => {
      expect(personal.result.current.data).toEqual([{ id: 'personal-2' }])
      expect(family.result.current.data).toEqual([{ id: 'family-2' }])
    })
  })

  it('invalidating one space prefix leaves the other cache alone', async () => {
    const personal = renderHook(() => useExpenses(), { wrapper: wrapperFor() })
    const family = renderHook(() => useExpenses(), { wrapper: wrapperFor(FAMILY) })
    await waitFor(() => {
      expect(personal.result.current.data).toBeDefined()
      expect(family.result.current.data).toBeDefined()
    })
    vi.mocked(getAllExpenses).mockClear()
    familyGetAll.mockClear()
    familyGetAll.mockResolvedValue([{ id: 'family-3' }])

    await client.invalidateQueries({ queryKey: ['expenses', FAMILY] })

    await waitFor(() => {
      expect(family.result.current.data).toEqual([{ id: 'family-3' }])
    })
    expect(getAllExpenses).not.toHaveBeenCalled()
  })
})

describe('spaceDb helpers', () => {
  it('spaceArgs is empty for personal and carries the id for a Family space', () => {
    expect(spaceArgs('personal')).toEqual([])
    expect(spaceArgs(FAMILY)).toEqual([{ spaceId: FAMILY }])
  })

  it('withSpaceOption returns the same object for personal and a copy with spaceId for Family', () => {
    const options = { today: '2026-01-01' }

    expect(withSpaceOption(options, 'personal')).toBe(options)
    const family = withSpaceOption(options, FAMILY)
    expect(family).toEqual({ today: '2026-01-01', spaceId: FAMILY })
    expect(family).not.toBe(options)
    expect(options).toEqual({ today: '2026-01-01' })
  })

  it('dbFor defaults to personal and only touches spaceDb for a Family id', async () => {
    await dbFor().getAllExpenses()
    expect(getAllExpenses).toHaveBeenCalledTimes(1)
    expect(spaceDb).not.toHaveBeenCalled()

    await dbFor(FAMILY).getAllExpenses()
    expect(spaceDb).toHaveBeenCalledWith(FAMILY)
    expect(familyGetAll).toHaveBeenCalledTimes(1)
  })
})
