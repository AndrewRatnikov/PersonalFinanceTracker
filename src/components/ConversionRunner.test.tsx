// No CONTRACT_GAPs: ConversionRunner (named export, renders null) is fully
// specified in the Interface Contract and plan section 11. '@/lib/conversion'
// is mocked as the contract's test note says.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { startAutoConversion, subscribeConversion } from '@/lib/conversion'
import { ConversionRunner } from '@/components/ConversionRunner'

vi.mock('@/lib/conversion', () => ({
  startAutoConversion: vi.fn(),
  subscribeConversion: vi.fn(),
}))

const stopAuto = vi.fn()
const unsubscribe = vi.fn()

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidate = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockResolvedValue(undefined)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversionRunner />
    </QueryClientProvider>,
  )
  return { ...view, invalidate }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(startAutoConversion).mockReturnValue(stopAuto)
  vi.mocked(subscribeConversion).mockReturnValue(unsubscribe)
})

describe('ConversionRunner', () => {
  it('renders nothing', () => {
    const { container } = setup()

    expect(container.firstChild).toBeNull()
  })

  it('starts auto conversion and subscribes once on mount', () => {
    setup()

    expect(startAutoConversion).toHaveBeenCalledTimes(1)
    expect(subscribeConversion).toHaveBeenCalledTimes(1)
    expect(typeof vi.mocked(subscribeConversion).mock.calls[0][0]).toBe('function')
  })

  it('invalidates the data, settings and status queries when the subscription fires', () => {
    const { invalidate } = setup()
    expect(invalidate).not.toHaveBeenCalled()

    const listener = vi.mocked(subscribeConversion).mock.calls[0][0]
    listener()

    const keys = invalidate.mock.calls.map(
      (c) => (c[0] as { queryKey: Array<string> }).queryKey,
    )
    expect(keys).toEqual(
      expect.arrayContaining([
        ['expenses'],
        ['income'],
        ['analytics'],
        ['budgets'],
        ['settings'],
        ['conversion-status'],
      ]),
    )
    expect(keys).toHaveLength(6)
  })

  it('invalidates again on every notification', () => {
    const { invalidate } = setup()
    const listener = vi.mocked(subscribeConversion).mock.calls[0][0]

    listener()
    listener()

    expect(invalidate).toHaveBeenCalledTimes(12)
  })

  it('cleans up both on unmount', () => {
    const { unmount } = setup()
    expect(stopAuto).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()

    unmount()

    expect(stopAuto).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
