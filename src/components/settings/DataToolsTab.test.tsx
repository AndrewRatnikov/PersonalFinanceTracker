// No CONTRACT_GAPs: DataToolsTab selectors are fully specified in the
// Interface Contract (component: DataToolsTab). StorageStatusCard and
// RemoveDataDialog are replaced by fakes (fake-storage-status,
// fake-remove-data-dialog).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataToolsTab } from '@/components/settings/DataToolsTab'

vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('@/lib/localImport', () => ({ importLocalDataFile: vi.fn() }))
vi.mock('@/components/settings/StorageStatusCard', () => ({
  StorageStatusCard: () => <div data-testid="fake-storage-status" />,
}))
vi.mock('@/components/RemoveDataDialog', () => ({
  RemoveDataDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-remove-data-dialog" /> : null,
}))

function renderTab() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <DataToolsTab />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('DataToolsTab', () => {
  it('renders the storage status card', () => {
    renderTab()

    expect(screen.getByTestId('fake-storage-status')).toBeTruthy()
  })

  it('has a Danger zone with a Remove data from this device button', () => {
    renderTab()

    const zone = screen.getByTestId('danger-zone-card')
    expect(zone.textContent).toContain('Remove all data from this device')
    expect(screen.getByTestId('remove-data-btn').textContent).toContain(
      'Remove data from this device',
    )
  })

  it('opens the remove-data dialog from the button', () => {
    renderTab()
    expect(screen.queryByTestId('fake-remove-data-dialog')).toBeNull()

    fireEvent.click(screen.getByTestId('remove-data-btn'))

    expect(screen.getByTestId('fake-remove-data-dialog')).toBeTruthy()
  })

  it('no longer offers Delete account', () => {
    renderTab()

    expect(screen.queryByTestId('delete-account-btn')).toBeNull()
    expect(screen.queryByTestId('delete-account-dialog')).toBeNull()
    expect(screen.getByTestId('danger-zone-card').textContent).not.toContain(
      'account',
    )
  })

  it('puts the storage status before the Danger zone', () => {
    renderTab()

    const storage = screen.getByTestId('fake-storage-status')
    const zone = screen.getByTestId('danger-zone-card')
    expect(
      storage.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
