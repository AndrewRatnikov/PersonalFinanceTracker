// No CONTRACT_GAPs: the /auth/callback loader behaviour is specified in plan
// section 10 and the Interface Contract (route: /auth/callback). The loader is
// called directly and the thrown redirect is inspected with isRedirect.

import { isRedirect } from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { exchangeAuthCode } from '@/lib/auth'
import { Route } from '@/routes/auth.callback'

vi.mock('@/lib/auth', () => ({ exchangeAuthCode: vi.fn() }))

async function runLoader(href: string): Promise<unknown> {
  const loader = Route.options.loader
  if (!loader) throw new Error('auth callback route has no loader')
  try {
    await loader({ location: { href } } as never)
  } catch (err) {
    return err
  }
  throw new Error('the loader did not throw a redirect')
}

function redirectOf(err: unknown) {
  if (!isRedirect(err)) throw new Error('expected a redirect, got ' + String(err))
  return err.options
}

beforeEach(() => {
  vi.mocked(exchangeAuthCode).mockReset()
  vi.mocked(exchangeAuthCode).mockResolvedValue(undefined as never)
})

function callback(redirectTo: string | null, code: string | null = 'c'): string {
  const params = new URLSearchParams()
  if (code !== null) params.set('code', code)
  if (redirectTo !== null) params.set('redirect_to', redirectTo)
  return `/auth/callback?${params.toString()}`
}

describe('/auth/callback redirect', () => {
  it('keeps a redirect with its own query string intact', async () => {
    const options = redirectOf(await runLoader(callback('/settings?tab=account')))

    expect(options.href).toBe('/settings?tab=account')
  })

  it('keeps a different multi-parameter redirect intact', async () => {
    const options = redirectOf(
      await runLoader(callback('/analytics?from=2024-01-01&to=2024-03-31')),
    )

    expect(options.href).toBe('/analytics?from=2024-01-01&to=2024-03-31')
  })

  it('redirects with href, not with to', async () => {
    const options = redirectOf(await runLoader(callback('/settings?tab=account')))

    expect(options.to).toBeUndefined()
  })

  it('falls back to / for an absolute URL on another site', async () => {
    const options = redirectOf(await runLoader(callback('https://evil.example')))

    expect(options.href).toBe('/')
  })

  it('falls back to / for a relative path without a leading slash', async () => {
    const options = redirectOf(await runLoader(callback('settings')))

    expect(options.href).toBe('/')
  })

  it('falls back to / when redirect_to is missing', async () => {
    const options = redirectOf(await runLoader(callback(null)))

    expect(options.href).toBe('/')
  })

  it('exchanges the code once before redirecting', async () => {
    await runLoader(callback('/settings?tab=account', 'abc123'))

    expect(exchangeAuthCode).toHaveBeenCalledTimes(1)
    expect(exchangeAuthCode).toHaveBeenCalledWith({ data: { code: 'abc123' } })
  })

  it('passes the actual code, not a fixed one', async () => {
    await runLoader(callback('/', 'other-code'))

    expect(exchangeAuthCode).toHaveBeenCalledWith({ data: { code: 'other-code' } })
  })

  it('does not exchange anything without a code, but still redirects', async () => {
    const options = redirectOf(await runLoader(callback('/settings?tab=account', null)))

    expect(exchangeAuthCode).not.toHaveBeenCalled()
    expect(options.href).toBe('/settings?tab=account')
  })

  it('lets a failed exchange through instead of redirecting', async () => {
    const failure = new Error('exchange failed')
    vi.mocked(exchangeAuthCode).mockRejectedValue(failure)

    const err = await runLoader(callback('/settings?tab=account'))

    expect(err).toBe(failure)
    expect(isRedirect(err)).toBe(false)
  })
})
