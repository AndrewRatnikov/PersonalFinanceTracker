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
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm border shadow-xl">
        <CardHeader className="text-center space-y-2">
          <CardTitle className="text-3xl font-bold tracking-tight">MinimaSpend</CardTitle>
          <CardDescription>
            Sign in to manage your core expenses instantly.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {authError && (
            <Alert variant="destructive" className="mb-6">
              <AlertDescription>{authError}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleGoogleLogin}
            disabled={isLoading}
            variant="outline"
            size="lg"
            className="w-full gap-3 font-semibold h-12 shadow-sm transition-all hover:bg-accent"
          >
            {isLoading ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <GoogleIcon className="h-5 w-5" />
            )}
            <span>Continue with Google</span>
          </Button>

          <p className="mt-8 text-center text-xs text-muted-foreground">
            By signing in, you agree to our Terms and Privacy Policy.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
