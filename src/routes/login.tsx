import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { createBrowserSupabaseClient } from '../lib/supabase'

export const Route = createFileRoute('/login')({
  component: Login,
})

function Login() {
  const [isLoading, setIsLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const supabase = createBrowserSupabaseClient()

  // Extract the redirect path from the search params, default to '/'
  const search: { redirect?: string } = Route.useSearch()
  const fallback = search.redirect ?? '/'

  const handleGoogleLogin = async () => {
    try {
      setIsLoading(true)
      setAuthError(null)
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Tell Supabase where to redirect after Google auth
          redirectTo: `${window.location.origin}/auth/callback?redirect_to=${fallback}`,
        },
      })

      if (error) {
        setAuthError(error.message)
        console.error('Error logging in with Google:', error.message)
      }
    } catch (err: any) {
      setAuthError(err.message || 'An unexpected error occurred.')
      console.error('Unexpected error during login:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">MinimaSpend</h1>
        <p className="mb-8 text-sm text-gray-500">
          Sign in to manage your core expenses instantly.
        </p>

        {authError && (
          <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">
            {authError}
          </div>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={isLoading}
          className="flex w-full items-center justify-center gap-3 rounded-xl bg-black px-4 py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-70 disabled:hover:scale-100"
        >
          {isLoading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
          )}
          <span>Continue with Google</span>
        </button>
      </div>
    </div>
  )
}
