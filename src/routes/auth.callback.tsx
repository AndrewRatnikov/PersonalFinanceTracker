import { createFileRoute, redirect } from '@tanstack/react-router'
import { exchangeAuthCode } from '../lib/auth'

export const Route = createFileRoute('/auth/callback')({
  loader: async ({ location }) => {
    // In TanStack Start, loaders on the server can execute server-side code
    // We expect Supabase to have appended `code` and `redirect_to` to the URL.
    const url = new URL(location.href, 'http://localhost')
    const code = url.searchParams.get('code')
    const redirectTo = url.searchParams.get('redirect_to') || '/'

    if (code) {
      // Execute the server function to swap the code for cookies
      await exchangeAuthCode({ data: code } as any)
    }

    // Always redirect back to the app to clear the callback URL parameters
    throw redirect({ to: redirectTo })
  },
})
