// No CONTRACT_GAPs: profile-page, profile-content and profile-sign-out-btn are
// in the Interface Contract (Routes: Transactions, Income, Profile, Terms,
// Privacy). The route component is rendered with Route.useLoaderData spied (no
// router is mounted); useNavigate is mocked (importOriginal keeps the rest of
// the router), and @/lib/auth and @/lib/accountSession are mocked so nothing
// touches the network.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactRouter from '@tanstack/react-router'

import type { UserProfile } from '@/lib/auth'
import { setLang } from '@/i18n/core'
import { I18nProvider } from '@/i18n/react'
import { signOutAccount } from '@/lib/accountSession'
import { Route } from '@/routes/profile'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => navigate,
}))
vi.mock('@/lib/auth', () => ({ getServerUserProfile: vi.fn() }))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  signOutAccount: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ANNA: UserProfile = {
  full_name: 'Anna Example',
  email: 'anna@example.com',
  avatar_url: null,
}
const BORYS: UserProfile = {
  full_name: 'Borys Sample',
  email: 'borys@example.com',
  avatar_url: null,
}

function renderProfile(user: UserProfile | null) {
  vi.spyOn(Route, 'useLoaderData').mockReturnValue(user)
  const Page = Route.options.component
  if (!Page) throw new Error('profile route has no component')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLang="en">
        <Page />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  setLang('en', { persist: false })
  vi.mocked(signOutAccount).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('profile page container', () => {
  it('renders inside a full-width PageContainer', () => {
    renderProfile(ANNA)

    const page = screen.getByTestId('profile-page')
    expect(page.getAttribute('data-page-container')).toBe('full')
    const classes = page.className.split(/\s+/)
    for (const token of ['max-w-6xl', 'mx-auto', 'px-4', 'md:px-8']) {
      expect(classes, token).toContain(token)
    }
    // The narrow width moved to the inner wrapper.
    expect(classes).not.toContain('max-w-xl')
    expect(classes).not.toContain('sm:px-6')
  })

  it('centres the content at max-w-xl inside the container', () => {
    renderProfile(ANNA)

    const page = screen.getByTestId('profile-page')
    const content = screen.getByTestId('profile-content')
    const classes = content.className.split(/\s+/)
    expect(classes).toContain('mx-auto')
    expect(classes).toContain('max-w-xl')
    expect(classes).not.toContain('max-w-6xl')
    expect(content.parentElement).toBe(page)
  })

  it('holds the heading and the card with the sign-out button', () => {
    renderProfile(ANNA)

    const content = screen.getByTestId('profile-content')
    expect(content.querySelector('h1')?.textContent).toBe('Profile')
    expect(content.contains(screen.getByTestId('profile-sign-out-btn'))).toBe(true)
    expect(content.textContent).toContain('Anna Example')
    expect(content.textContent).toContain('anna@example.com')
  })

  it('shows the data of the signed-in user, whoever it is', () => {
    renderProfile(BORYS)

    const content = screen.getByTestId('profile-content')
    expect(content.textContent).toContain('Borys Sample')
    expect(content.textContent).toContain('borys@example.com')
    expect(content.textContent).not.toContain('Anna Example')
  })

  it('renders nothing without a user', () => {
    renderProfile(null)

    expect(screen.queryByTestId('profile-page')).toBeNull()
    expect(screen.queryByTestId('profile-content')).toBeNull()
    expect(screen.queryByTestId('profile-sign-out-btn')).toBeNull()
  })

  it('signing out still works from inside the container', async () => {
    renderProfile(ANNA)

    fireEvent.click(screen.getByTestId('profile-sign-out-btn'))

    await waitFor(() => expect(signOutAccount).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
  })
})
