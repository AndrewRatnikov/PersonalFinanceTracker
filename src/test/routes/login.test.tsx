// No CONTRACT_GAPs: the login route testid and approach (#8) are fully
// specified in the Interface Contract.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Route } from '@/routes/login'

const { signInWithOAuth } = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
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
})
