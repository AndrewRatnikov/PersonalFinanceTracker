import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  redirect,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { User } from '@supabase/supabase-js'

import { getServerUser } from '../lib/auth'
import {
  initLocalDb,
  provisionDefaultCategories as provisionLocalCategories,
  unlockLocalDb,
} from '../lib/localDb'
import type { AuthContext } from '../lib/authContext'
import Header from '../components/Header'
import { OfflineBanner } from '../components/OfflineBanner'
import { PasswordUnlockDialog } from '../components/PasswordUnlockDialog'
import NotFoundPage from '../components/NotFoundPage'

import appCss from '../styles.css?url'

const OFFLINE_USER_KEY = 'minima_offline_user'

const queryClient = new QueryClient()

export const Route = createRootRouteWithContext<AuthContext>()({
  beforeLoad: async ({ location }) => {
    let user: User | null = null

    try {
      user = await getServerUser()
      if (typeof window !== 'undefined' && user) {
        localStorage.setItem(
          OFFLINE_USER_KEY,
          JSON.stringify({ id: user.id, email: user.email }),
        )
      }
    } catch (err) {
      if (typeof window !== 'undefined' && !navigator.onLine) {
        const raw = localStorage.getItem(OFFLINE_USER_KEY)
        user = raw ? (JSON.parse(raw) as User) : null
      } else {
        throw err
      }
    }

    const isLoading = false

    if (
      !user &&
      !location.pathname.startsWith('/login') &&
      !location.pathname.startsWith('/auth/callback')
    ) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }

    if (user && typeof window !== 'undefined') {
      initLocalDb(user.id)
    }

    return { auth: { user, isLoading } }
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'MinimaSpend',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
    ],
  }),

  shellComponent: RootDocument,
  notFoundComponent: NotFoundPage,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const [isUnlocked, setIsUnlocked] = useState(false)
  const { auth } = Route.useRouteContext()

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
    }
    setMounted(true)
  }, [])

  const handleUnlocked = async (key: CryptoKey) => {
    unlockLocalDb(key)
    await provisionLocalCategories()
    setIsUnlocked(true)
    queryClient.invalidateQueries()
  }

  const showUnlockDialog = mounted && !!auth.user && !isUnlocked

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Header />
          <OfflineBanner />
          {showUnlockDialog && (
            <PasswordUnlockDialog userId={auth.user!.id} onUnlocked={handleUnlocked} />
          )}
          {children}
          <Toaster richColors position="bottom-center" />
        </QueryClientProvider>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
