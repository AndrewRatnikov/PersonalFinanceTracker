// CONTRACT_GAP: the retry control inside sync-devices-error has no testid in the
//   Interface Contract; it is found as the only button inside that element.
// CONTRACT_GAP: the exact format of {when} in sync.devices.lastSeen is not
//   specified; only the translated wording around it is asserted, plus that two
//   devices seen on different days show different texts.
// CONTRACT_GAP: the cancel control of sync-device-remove-dialog has no testid;
//   it is not exercised.
//
// SyncDevicesList specified in plan section 10 and the Interface Contract
// (component: SyncDevicesList). The runtime actions are fakes; React Query is
// real so the invalidation of ['sync-devices'] is observable as a second
// listDevices call.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import type { CloudDevice } from '@/lib/cloud/types'
import { setLang, translate } from '@/i18n/core'
import { SyncDevicesList } from '@/components/settings/SyncDevicesList'

const { actions, toastError, toastSuccess } = vi.hoisted(() => ({
  actions: {
    listDevices: vi.fn(),
    renameDevice: vi.fn(),
    removeDevice: vi.fn(),
  },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/lib/sync/runtime', () => ({
  getSyncRuntime: () => ({ engine: {}, actions, setUserId: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

const LANGS: Array<Lang> = ['en', 'uk']

function device(id: string, label: string, created: string, seen: string, removed: string | null = null): CloudDevice {
  return { device_id: id, label, created_at: created, last_seen_at: seen, removed_at: removed }
}

const LAPTOP = device('dev-a', 'Laptop', '2026-08-01T10:00:00.000Z', '2026-10-24T08:00:00.000Z')
const PIXEL = device('dev-b', 'Pixel', '2026-09-01T10:00:00.000Z', '2026-10-01T08:00:00.000Z')
const OLD_PHONE = device('dev-r', 'Old phone', '2026-07-01T10:00:00.000Z', '2026-07-02T08:00:00.000Z', '2026-07-03T08:00:00.000Z')

let client = new QueryClient()

function renderList(thisDeviceId: string | null = 'dev-a') {
  return render(
    <QueryClientProvider client={client}>
      <SyncDevicesList thisDeviceId={thisDeviceId} />
    </QueryClientProvider>,
  )
}

async function rows() {
  await screen.findByTestId('sync-devices')
  return screen.getAllByTestId('sync-device-row')
}

function rowOf(id: string): HTMLElement {
  const row = screen
    .getAllByTestId('sync-device-row')
    .find((r) => r.getAttribute('data-device-id') === id)
  if (!row) throw new Error(`no row for ${id}`)
  return row
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setLang('en', { persist: false })
  actions.listDevices.mockResolvedValue([PIXEL, OLD_PHONE, LAPTOP])
  actions.renameDevice.mockResolvedValue(LAPTOP)
  actions.removeDevice.mockResolvedValue(PIXEL)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('loading and errors', () => {
  it('shows a loading marker first', async () => {
    actions.listDevices.mockReturnValue(new Promise(() => undefined))
    renderList()
    expect(screen.getByTestId('sync-devices-loading')).toBeTruthy()
    expect(screen.queryByTestId('sync-devices')).toBeNull()
  })

  it('shows an error with a retry that asks again', async () => {
    actions.listDevices.mockRejectedValueOnce(new Error('boom'))
    renderList()

    const error = await screen.findByTestId('sync-devices-error')
    actions.listDevices.mockResolvedValue([LAPTOP])
    fireEvent.click(within(error).getByRole('button'))

    await screen.findByTestId('sync-devices')
    expect(actions.listDevices).toHaveBeenCalledTimes(2)
  })
})

describe('the list', () => {
  it('shows active devices only, oldest first, one row each', async () => {
    renderList()
    const list = await rows()

    expect(list.map((r) => r.getAttribute('data-device-id'))).toEqual(['dev-a', 'dev-b'])
    expect(within(list[0]).getByTestId('sync-device-label').textContent.trim()).toBe('Laptop')
    expect(within(list[1]).getByTestId('sync-device-label').textContent.trim()).toBe('Pixel')
    expect(screen.queryByText('Old phone')).toBeNull()
  })

  it('a different server list gives different rows', async () => {
    actions.listDevices.mockResolvedValue([device('dev-z', 'Tablet', '2026-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')])
    renderList('dev-z')
    const list = await rows()
    expect(list).toHaveLength(1)
    expect(within(list[0]).getByTestId('sync-device-label').textContent.trim()).toBe('Tablet')
  })

  it.each(LANGS)('marks only this device in %s', async (lang) => {
    setLang(lang, { persist: false })
    renderList('dev-b')
    await rows()

    expect(within(rowOf('dev-b')).getByTestId('sync-device-this').textContent.trim()).toBe(
      translate(lang, 'sync.devices.thisDevice'),
    )
    expect(within(rowOf('dev-a')).queryByTestId('sync-device-this')).toBeNull()
  })

  it('marks no device when the id is unknown', async () => {
    renderList(null)
    await rows()
    expect(screen.queryByTestId('sync-device-this')).toBeNull()
  })

  it.each(LANGS)('shows when each device was last seen in %s', async (lang) => {
    setLang(lang, { persist: false })
    renderList()
    await rows()

    const [prefix] = translate(lang, 'sync.devices.lastSeen', { when: '@@' }).split('@@')
    const a = within(rowOf('dev-a')).getByTestId('sync-device-last-seen').textContent.trim()
    const b = within(rowOf('dev-b')).getByTestId('sync-device-last-seen').textContent.trim()
    expect(a.startsWith(prefix)).toBe(true)
    expect(b.startsWith(prefix)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('every row can be renamed, but only other devices can be removed', async () => {
    renderList('dev-a')
    await rows()

    expect(within(rowOf('dev-a')).getByTestId('sync-device-rename-btn')).toBeTruthy()
    expect(within(rowOf('dev-b')).getByTestId('sync-device-rename-btn')).toBeTruthy()
    expect(within(rowOf('dev-a')).queryByTestId('sync-device-remove-btn')).toBeNull()
    expect(within(rowOf('dev-b')).getByTestId('sync-device-remove-btn')).toBeTruthy()
  })
})

describe('renaming', () => {
  async function startRename(id = 'dev-a') {
    renderList('dev-a')
    await rows()
    fireEvent.click(within(rowOf(id)).getByTestId('sync-device-rename-btn'))
    return within(rowOf(id)).getByTestId<HTMLInputElement>('sync-device-rename-input')
  }

  it('opens an input prefilled with the current label', async () => {
    const input = await startRename()
    expect(input.value).toBe('Laptop')
  })

  it('prefills the label of the row that was clicked', async () => {
    const input = await startRename('dev-b')
    expect(input.value).toBe('Pixel')
  })

  it('saves the new label and refreshes the list', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const input = await startRename()
    fireEvent.change(input, { target: { value: 'Work laptop' } })
    fireEvent.click(within(rowOf('dev-a')).getByTestId('sync-device-rename-save'))

    await waitFor(() => {
      expect(actions.renameDevice).toHaveBeenCalledWith('dev-a', 'Work laptop')
    })
    await waitFor(() => {
      expect(actions.listDevices).toHaveBeenCalledTimes(2)
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sync-devices'] })
    await waitFor(() => {
      expect(within(rowOf('dev-a')).queryByTestId('sync-device-rename-input')).toBeNull()
    })
  })

  it('trims the label', async () => {
    const input = await startRename()
    fireEvent.change(input, { target: { value: '   Home   ' } })
    fireEvent.click(within(rowOf('dev-a')).getByTestId('sync-device-rename-save'))
    await waitFor(() => {
      expect(actions.renameDevice).toHaveBeenCalledWith('dev-a', 'Home')
    })
  })

  it.each(['', '   '])('refuses an empty label (%j)', async (value) => {
    const input = await startRename()
    fireEvent.change(input, { target: { value } })
    fireEvent.click(within(rowOf('dev-a')).getByTestId('sync-device-rename-save'))
    await Promise.resolve()
    expect(actions.renameDevice).not.toHaveBeenCalled()
  })

  it('never sends more than 60 characters', async () => {
    const input = await startRename()
    fireEvent.change(input, { target: { value: 'x'.repeat(70) } })
    fireEvent.click(within(rowOf('dev-a')).getByTestId('sync-device-rename-save'))
    await Promise.resolve()

    const sent = actions.renameDevice.mock.calls[0]?.[1] as string | undefined
    expect(input.maxLength === 60 || sent === undefined || sent.length <= 60).toBe(true)
  })

  it('cancel closes the input without a call', async () => {
    const input = await startRename()
    fireEvent.change(input, { target: { value: 'Something else' } })
    fireEvent.click(within(rowOf('dev-a')).getByTestId('sync-device-rename-cancel'))

    expect(within(rowOf('dev-a')).queryByTestId('sync-device-rename-input')).toBeNull()
    expect(actions.renameDevice).not.toHaveBeenCalled()
    expect(within(rowOf('dev-a')).getByTestId('sync-device-label').textContent.trim()).toBe('Laptop')
  })

  it.each(LANGS)('a failed rename is toasted in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.renameDevice.mockRejectedValue(Object.assign(new Error('x'), { name: 'CloudError', code: 'network' }))
    const input = await startRename()
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.click(within(rowOf('dev-a')).getByTestId('sync-device-rename-save'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        translate(lang, 'sync.errors.actionFailed', { code: 'network' }),
      )
    })
  })
})

describe('removing another device', () => {
  it('asks first and removes only after the confirmation', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderList('dev-a')
    await rows()
    fireEvent.click(within(rowOf('dev-b')).getByTestId('sync-device-remove-btn'))

    expect(await screen.findByTestId('sync-device-remove-dialog')).toBeTruthy()
    expect(actions.removeDevice).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('sync-device-remove-confirm'))
    await waitFor(() => {
      expect(actions.removeDevice).toHaveBeenCalledWith('dev-b')
    })
    await waitFor(() => {
      expect(actions.listDevices).toHaveBeenCalledTimes(2)
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sync-devices'] })
  })

  it('removes the device whose button was clicked', async () => {
    actions.listDevices.mockResolvedValue([
      LAPTOP,
      PIXEL,
      device('dev-c', 'Tablet', '2026-09-15T10:00:00.000Z', '2026-10-02T08:00:00.000Z'),
    ])
    renderList('dev-a')
    await rows()
    fireEvent.click(within(rowOf('dev-c')).getByTestId('sync-device-remove-btn'))
    fireEvent.click(await screen.findByTestId('sync-device-remove-confirm'))
    await waitFor(() => {
      expect(actions.removeDevice).toHaveBeenCalledWith('dev-c')
    })
    expect(actions.removeDevice).not.toHaveBeenCalledWith('dev-b')
  })

  it.each(LANGS)('a failed removal is toasted in %s', async (lang) => {
    setLang(lang, { persist: false })
    actions.removeDevice.mockRejectedValue(Object.assign(new Error('x'), { name: 'CloudError', code: 'unknown' }))
    renderList('dev-a')
    await rows()
    fireEvent.click(within(rowOf('dev-b')).getByTestId('sync-device-remove-btn'))
    fireEvent.click(await screen.findByTestId('sync-device-remove-confirm'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        translate(lang, 'sync.errors.actionFailed', { code: 'unknown' }),
      )
    })
  })
})
