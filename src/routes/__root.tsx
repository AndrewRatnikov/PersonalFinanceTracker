import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  redirect,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { getServerUser } from '../lib/auth'
import { provisionDefaultCategories } from '../lib/categories'
import { getLocalStore, setLocalStore } from '../lib/localStore'
import Header from '../components/Header'
import NotFoundPage from '../components/NotFoundPage'

import appCss from '../styles.css?url'
import type { AuthContext } from '../lib/authContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

const queryClient = new QueryClient()

export const Route = createRootRouteWithContext<AuthContext>()({
  beforeLoad: async ({ location }) => {
    // Call the server function to validate the user session securely.
    // TanStack Start handles the network request transparently if this is run on the client.
    const user = await getServerUser()
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
        await provisionDefaultCategories()
        setLocalStore(user.id, 'categoriesProvisioned', true)
      }
    }

    // Return the updated context to propagate the user down to child routes.
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
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Header />
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
