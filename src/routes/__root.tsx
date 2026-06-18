import { useEffect } from 'react'
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
import { provisionDefaultCategories } from '../lib/categories'
import { getLocalStore, setLocalStore } from '../lib/localStore'
import type { AuthContext } from '../lib/authContext'
import Header from '../components/Header'
import { OfflineBanner } from '../components/OfflineBanner'
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

    if (user) {
      const alreadyProvisioned = getLocalStore(user.id, 'categoriesProvisioned')
      if (!alreadyProvisioned) {
        try {
          await provisionDefaultCategories()
          setLocalStore(user.id, 'categoriesProvisioned', true)
        } catch (err) {
          if (typeof window === 'undefined' || navigator.onLine) throw err
          // Offline — skip provisioning, will retry on next online session
        }
      }
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
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
    }
  }, [])

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Header />
          <OfflineBanner />
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
