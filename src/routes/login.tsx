import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { Button } from '@/components/ui/button'

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

        <Button
          onClick={handleGoogleLogin}
          disabled={isLoading}
          className="flex w-full items-center justify-center gap-3 rounded-xl bg-black px-4 py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-70 disabled:hover:scale-100"
        >
          {isLoading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <GoogleIcon className="h-5 w-5" />
          )}
          <span>Continue with Google</span>
        </Button>
      </div>
    </div>
  )
}
