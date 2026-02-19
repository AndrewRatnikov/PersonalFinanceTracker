import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  redirect,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import type { User } from '@supabase/supabase-js'

import { getServerUser } from '../lib/auth'
import Header from '../components/Header'

import appCss from '../styles.css?url'

interface AuthContext {
  auth: {
    user: User | null
    isLoading: boolean
  }
}

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
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Header />
        {children}
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
