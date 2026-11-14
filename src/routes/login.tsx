import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useT } from '@/i18n'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'

export const Route = createFileRoute('/login')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; error?: 'auth' } => ({
    ...(typeof search.redirect === 'string' ? { redirect: search.redirect } : {}),
    ...(search.error === 'auth' ? { error: 'auth' as const } : {}),
  }),
  component: Login,
})

const REACHABILITY_TIMEOUT_MS = 8000

// True when the auth server answers at all. An opaque (no-cors) response is
// enough: only a network failure (DNS, offline, timeout) rejects. Without this
// the browser would leave the app for a page that never loads.
async function authServerReachable(): Promise<boolean> {
  const base: unknown = import.meta.env.VITE_SUPABASE_URL
  if (typeof base !== 'string' || base === '') return true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS)
  try {
    await fetch(`${base}/auth/v1/health`, {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function Login() {
  const [isLoading, setIsLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const supabase = createBrowserSupabaseClient()
  const { t } = useT()

  // Extract the redirect path from the search params, default to '/'
  const search: { redirect?: string; error?: 'auth' } = Route.useSearch()
  const fallback = search.redirect ?? '/'
  // The callback sends a failed sign-in back here with ?error=auth.
  const shownError = authError ?? (search.error === 'auth' ? t('login.failed') : null)

  const handleGoogleLogin = async () => {
    try {
      setIsLoading(true)
      setAuthError(null)
      if (!(await authServerReachable())) {
        setAuthError(t('login.unreachable'))
        return
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Tell Supabase where to redirect after Google auth
          redirectTo: `${window.location.origin}/auth/callback?redirect_to=${encodeURIComponent(fallback)}`,
        },
      })

      if (error) {
        setAuthError(error.message)
        console.error('Error logging in with Google:', error.message)
      }
    } catch (err: any) {
      setAuthError(err.message || t('login.unexpected'))
      console.error('Unexpected error during login:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm border shadow-xl">
        <CardHeader className="text-center space-y-2">
          <CardTitle className="text-3xl font-bold tracking-tight">
            MinimaSpend
          </CardTitle>
          <CardDescription>{t('login.description')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {shownError && (
            <Alert variant="destructive" className="mb-6" data-testid="login-error">
              <AlertDescription>{shownError}</AlertDescription>
            </Alert>
          )}

          <Button
            data-testid="login-google-btn"
            onClick={handleGoogleLogin}
            disabled={isLoading}
            variant="outline"
            size="lg"
            className="w-full gap-3 font-semibold h-12 shadow-sm transition-all hover:bg-accent"
          >
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <GoogleIcon className="h-5 w-5" />
            )}
            <span>{t('login.google')}</span>
          </Button>

          <p className="mt-8 text-center text-xs text-muted-foreground">
            {t('login.agree.prefix')}
            <Link
              to="/terms"
              data-testid="login-terms-link"
              className="underline underline-offset-4 hover:text-foreground"
            >
              {t('login.agree.terms')}
            </Link>
            {t('login.agree.and')}
            <Link
              to="/privacy"
              data-testid="login-privacy-link"
              className="underline underline-offset-4 hover:text-foreground"
            >
              {t('login.agree.privacy')}
            </Link>
            {t('login.agree.suffix')}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
