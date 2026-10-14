import { useEffect, useState } from 'react'
import { Toaster, toast } from 'sonner'
import {
  HeadContent,
  Scripts,
  createRootRoute,
  redirect,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'

import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_AUTO_LOCK_MINUTES,
  getAppSettings,
} from '../lib/appSettings'
import { isDecryptError } from '../lib/dataErrors'
import { reportDataProblem } from '../lib/dataProblem'
import { prepareUnlockedVault } from '../lib/localDb'
import { createAppQueryClient } from '../lib/queryClient'
import { recurringCreatedMessage } from '../lib/recurrence'
import { ensurePersistentStorage } from '../lib/storagePersistence'
import { listenForChanges } from '../lib/syncChannel'
import { getVaultState } from '../lib/vault'
import {
  cancelCreateVault,
  computeGate,
  connectOtherTabs,
  isDataRoute,
  phaseForVaultState,
  setVaultPhase,
  startTabAutoLock,
  useVaultSession,
} from '../lib/vaultSession'
import Header from '../components/Header'
import { OfflineBanner } from '../components/OfflineBanner'
import { PasswordUnlockDialog } from '../components/PasswordUnlockDialog'
import NotFoundPage from '../components/NotFoundPage'
import { DataProblemGate } from '../components/DataProblemGate'
import { RecurringScheduler } from '../components/RecurringScheduler'

import appCss from '../styles.css?url'
import type { VaultState } from '../lib/vault'

// DecryptErrors from any query or mutation switch the app to the Data problem
// screen (see lib/queryClient.ts and components/DataProblemGate.tsx).
const queryClient = createAppQueryClient()

export const Route = createRootRoute({
  // No account is needed (spec §2.1). Data routes need a vault on this
  // device; without one they go back to the landing page.
  beforeLoad: async ({ location }) => {
    if (typeof window === 'undefined' || !isDataRoute(location.pathname)) {
      return
    }
    let state: VaultState
    try {
      state = await getVaultState()
    } catch {
      // The gate shows the recovery screen.
      return
    }
    if (state === 'none') throw redirect({ to: '/' })
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

// Locks this tab after the configured inactivity time while it is unlocked.
// Auto-lock is per tab: it never locks other tabs (spec §2.4).
function AutoLock({ unlocked }: { unlocked: boolean }) {
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: getAppSettings,
    enabled: unlocked,
  })
  const minutes = data?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES

  useEffect(
    () => (unlocked ? startTabAutoLock(minutes, queryClient) : undefined),
    [unlocked, minutes],
  )

  return null
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const { phase, createRequested } = useVaultSession()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
    }
    setMounted(true)
  }, [])

  // Find out whether this device has a vault.
  useEffect(() => {
    let cancelled = false
    getVaultState().then(
      (state) => {
        if (!cancelled) setVaultPhase(phaseForVaultState(state))
      },
      () => {
        // The gate shows the recovery screen.
        if (!cancelled) setVaultPhase('locked')
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Hydration does not re-run beforeLoad, so a hard load of a data route
  // without a vault is sent home here.
  useEffect(() => {
    if (phase === 'none' && isDataRoute(pathname)) {
      void router.navigate({ to: '/', replace: true })
    }
  }, [phase, pathname, router])

  // Other tabs announce committed writes; refresh the affected queries.
  useEffect(() => listenForChanges(queryClient), [])

  // Another tab locked the vault or removed all data.
  useEffect(() => connectOtherTabs(queryClient), [])

  // vault.ts has already unlocked localDb with the vault DEK. After every
  // unlock (new vault, password, recovery key, v1 migration): default expense
  // categories for a new vault, then the income categories (defaults and the
  // conversion of legacy income sources), then the due recurring
  // occurrences (one toast when any were created). A DecryptError goes to the
  // Data problem screen; unreadable data is never overwritten.
  const handleUnlocked = async ({ isNewVault }: { isNewVault: boolean }) => {
    try {
      const { recurringCreated } = await prepareUnlockedVault({ isNewVault })
      if (recurringCreated > 0) {
        toast.success(recurringCreatedMessage(recurringCreated))
      }
    } catch (err) {
      if (isDecryptError(err)) reportDataProblem(err)
      else console.error('Could not prepare local data after unlock:', err)
    }
    setVaultPhase('unlocked')
    void queryClient.invalidateQueries()
    // A new vault already asked in CreateVaultScreen.
    if (!isNewVault) void ensurePersistentStorage()
  }

  // Before `mounted` is true (SSR + first paint) children render normally so
  // hydration matches the server output. After mount, data routes stay hidden
  // until the vault is unlocked so their queries never run with no key.
  const { showGate, showChildren } = computeGate({
    mounted,
    phase,
    createRequested,
    pathname,
  })

  return (
    <html lang="en" className="scroll-smooth">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Header />
          <OfflineBanner />
          <AutoLock unlocked={phase === 'unlocked'} />
          <RecurringScheduler unlocked={phase === 'unlocked'} />
          {showGate && (
            <PasswordUnlockDialog
              onUnlocked={(result) => void handleUnlocked(result)}
              onCancelCreate={phase === 'none' ? cancelCreateVault : undefined}
            />
          )}
          <DataProblemGate>{showChildren && children}</DataProblemGate>
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
