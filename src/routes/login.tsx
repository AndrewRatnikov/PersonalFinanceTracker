import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'

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
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50 dark:bg-slate-950">
      <Card className="w-full max-w-sm border-none shadow-lg dark:bg-slate-900">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-gray-900 dark:text-white">MinimaSpend</CardTitle>
          <CardDescription className="text-sm text-gray-500 dark:text-slate-400">
            Sign in to manage your core expenses instantly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {authError && (
            <Alert variant="destructive" className="mb-4 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400">
              <AlertDescription>{authError}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleGoogleLogin}
            disabled={isLoading}
            variant="default"
            className="flex w-full items-center justify-center gap-3 rounded-xl bg-black dark:bg-white dark:text-black py-6 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-70"
          >
            {isLoading ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <GoogleIcon className="h-5 w-5" />
            )}
            <span>Continue with Google</span>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
