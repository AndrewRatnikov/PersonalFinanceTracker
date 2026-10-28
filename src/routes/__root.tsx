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

import { getLang, translate } from '../i18n/core'
import { I18nProvider, LangHtml, useT } from '../i18n/react'
import { getRequestLang } from '../i18n/server'
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
import { SpaceProvider } from '../lib/spaces/react'
import { ensurePersistentStorage } from '../lib/storagePersistence'
import { requestSyncRestoreFromUrl } from '../lib/sync/restoreRequest'
import { listenForChanges } from '../lib/syncChannel'
import { getVaultState } from '../lib/vault'
import {
  cancelCreateVault,
  computeGate,
  connectOtherTabs,
  isDataRoute,
  phaseForVaultState,
  requestCreateVault,
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
import { ConversionRunner } from '../components/ConversionRunner'
import { SyncRunner } from '../components/SyncRunner'

import appCss from '../styles.css?url'
import type { Lang } from '../i18n/lang'
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
  // The language of this request (cookie, then Accept-Language), so the server
  // renders it with no flash; null for the prerendered offline shell, which
  // resolves it on the client before first paint. Loader data is dehydrated,
  // so hydration uses exactly the server's language.
  loader: async (): Promise<{ lang: Lang | null }> => ({ lang: await getRequestLang() }),
  head: ({ loaderData }) => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: translate(loaderData?.lang ?? 'en', 'landing.metaTitle'),
      },
      {
        name: 'description',
        content: translate(loaderData?.lang ?? 'en', 'landing.metaDescription'),
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

// The <body>, hidden only while the offline shell resolves its language (the
// server shell and the client's first render agree; a layout effect reveals it
// in the right language before paint).
function AppBody({ children }: { children: React.ReactNode }) {
  const { pending } = useT()
  return <body style={pending ? { visibility: 'hidden' } : undefined}>{children}</body>
}

function RootDocument({ children }: { children: React.ReactNode }) {
  // Undefined only before the root loader has run.
  const loaderData: { lang: Lang | null } | undefined = Route.useLoaderData()
  const initialLang = loaderData?.lang ?? null
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

  // Back from "Sign in to restore your data" (/?restore=sync) on a device
  // without a vault: open the gate on the sync restore screen. Only with
  // ENABLE_SYNC (requestSyncRestoreFromUrl checks it).
  useEffect(() => {
    if (phase === 'none' && requestSyncRestoreFromUrl(window.location.search)) {
      requestCreateVault()
    }
  }, [phase])

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
      // A new vault gets its default categories in the current UI language.
      const { recurringCreated } = await prepareUnlockedVault({
        isNewVault,
        lang: getLang(),
      })
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
    <I18nProvider initialLang={initialLang}>
      <LangHtml className="scroll-smooth">
      <head>
        <HeadContent />
      </head>
      <AppBody>
        <QueryClientProvider client={queryClient}>
          {/* The active space: always personal until a switcher exists. */}
          <SpaceProvider>
            <Header />
            <OfflineBanner />
            <AutoLock unlocked={phase === 'unlocked'} />
            <RecurringScheduler unlocked={phase === 'unlocked'} />
            <ConversionRunner />
            <SyncRunner unlocked={phase === 'unlocked'} />
            {showGate && (
              <PasswordUnlockDialog
                onUnlocked={(result) => void handleUnlocked(result)}
                onCancelCreate={phase === 'none' ? cancelCreateVault : undefined}
              />
            )}
            <DataProblemGate>{showChildren && children}</DataProblemGate>
            <Toaster richColors position="bottom-center" />
          </SpaceProvider>
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
      </AppBody>
      </LangHtml>
    </I18nProvider>
  )
}
