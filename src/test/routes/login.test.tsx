// No CONTRACT_GAPs: the login route testids and approach (#8) are fully
// specified in the Interface Contract. The router's Link is mocked (no router
// is mounted) with importOriginal spread so createFileRoute stays real.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import { setLang } from '@/i18n/core'
import { Route } from '@/routes/login'

const { signInWithOAuth } = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children?: ReactNode
    'data-testid'?: string
  }) => (
    <a href={to} data-testid={rest['data-testid']}>
      {children}
    </a>
  ),
}))

vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signInWithOAuth } }),
}))

function renderLogin() {
  const Page = Route.options.component
  if (!Page) throw new Error('login route has no component')
  return render(<Page />)
}

async function clickGoogleAndGetCallback(redirect: string): Promise<URL> {
  vi.spyOn(Route, 'useSearch').mockReturnValue({ redirect })
  renderLogin()
  fireEvent.click(screen.getByTestId('login-google-btn'))
  await waitFor(() => {
    expect(signInWithOAuth).toHaveBeenCalledTimes(1)
  })
  const args = signInWithOAuth.mock.calls[0][0] as {
    options: { redirectTo: string }
  }
  return new URL(args.options.redirectTo)
}

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('login redirect_to encoding (#8)', () => {
  beforeEach(() => {
    signInWithOAuth.mockReset()
    signInWithOAuth.mockResolvedValue({ error: null })
  })

  it('round-trips a redirect that carries its own query string', async () => {
    const callback = await clickGoogleAndGetCallback(
      '/analytics?from=2024-01-01&to=2024-03-31',
    )

    expect(callback.pathname).toBe('/auth/callback')
    expect(callback.searchParams.get('redirect_to')).toBe(
      '/analytics?from=2024-01-01&to=2024-03-31',
    )
    // The inner `to` param must not leak into the callback URL itself.
    expect(callback.searchParams.has('to')).toBe(false)
    expect(callback.searchParams.has('from')).toBe(false)
  })

  it('round-trips a different redirect value too', async () => {
    const callback = await clickGoogleAndGetCallback('/transactions?a=1&b=2#x')

    expect(callback.searchParams.get('redirect_to')).toBe(
      '/transactions?a=1&b=2#x',
    )
    expect(callback.searchParams.has('b')).toBe(false)
  })

  it('round-trips the Settings, Account redirect used by the Account tab', async () => {
    const callback = await clickGoogleAndGetCallback('/settings?tab=account')

    expect(callback.searchParams.get('redirect_to')).toBe('/settings?tab=account')
    expect(callback.searchParams.has('tab')).toBe(false)
  })
})

describe('login validateSearch', () => {
  function validate(input: Record<string, unknown>): unknown {
    const fn = Route.options.validateSearch
    if (typeof fn !== 'function') throw new Error('login route has no validateSearch')
    return fn(input)
  }

  it('keeps a string redirect', () => {
    expect(validate({ redirect: '/settings?tab=account' })).toEqual({
      redirect: '/settings?tab=account',
    })
    expect(validate({ redirect: '/analytics' })).toEqual({ redirect: '/analytics' })
  })

  it('drops a missing or non-string redirect', () => {
    expect(validate({})).toEqual({})
    expect(validate({ redirect: 5 })).toEqual({})
    expect(validate({ redirect: ['/a'] })).toEqual({})
  })
})

describe('login Terms and Privacy links (criterion 31)', () => {
  beforeEach(() => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    setLang('en', { persist: false })
  })

  it('links to /terms and /privacy in the agreement sentence', () => {
    renderLogin()

    const terms = screen.getByTestId('login-terms-link')
    const privacy = screen.getByTestId('login-privacy-link')
    expect(terms.getAttribute('href')).toBe('/terms')
    expect(privacy.getAttribute('href')).toBe('/privacy')
    expect(terms.textContent).toMatch(/terms/i)
    expect(privacy.textContent).toMatch(/privacy/i)
    expect(terms.textContent).not.toBe(privacy.textContent)
  })

  it('keeps the sign-in button next to the links', () => {
    renderLogin()

    expect(screen.getByTestId('login-google-btn')).toBeTruthy()
    expect(screen.getAllByTestId('login-terms-link')).toHaveLength(1)
  })

  it('labels the links in Ukrainian', () => {
    setLang('uk', { persist: false })
    renderLogin()

    expect(screen.getByTestId('login-terms-link').textContent).toMatch(/[Ѐ-ӿ]/)
    expect(screen.getByTestId('login-privacy-link').textContent).toMatch(/[Ѐ-ӿ]/)
  })
})
