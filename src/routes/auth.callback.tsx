import { createFileRoute, redirect } from '@tanstack/react-router'
import { exchangeAuthCode } from '../lib/auth'

export const Route = createFileRoute('/auth/callback')({
  loader: async ({ location }) => {
    // In TanStack Start, loaders on the server can execute server-side code
    // We expect Supabase to have appended `code` and `redirect_to` to the URL.
    const url = new URL(location.href, 'http://localhost')
    const code = url.searchParams.get('code')
    const raw = url.searchParams.get('redirect_to') ?? ''
    // Same-origin paths only: "//host" and "/\host" would leave the site.
    const redirectTo =
      raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')
        ? raw
        : '/'

    // The provider or Supabase refused (e.g. the user cancelled): no code.
    let failed = url.searchParams.has('error')
    if (code) {
      // Execute the server function to swap the code for cookies
      const result = await exchangeAuthCode({ data: { code } })
      if (!result.ok) failed = true
    }
    if (failed) {
      // Back to the sign-in page with a message, instead of landing in the
      // app signed out with no explanation.
      const params = new URLSearchParams({ error: 'auth' })
      if (redirectTo !== '/') params.set('redirect', redirectTo)
      throw redirect({ href: `/login?${params.toString()}` })
    }

    // Always redirect back to the app to clear the callback URL parameters.
    // `href` keeps a redirect's own query string (e.g. /settings?tab=account),
    // which `to` would not parse; only same-origin paths get here.
    throw redirect({ href: redirectTo })
  },
})
