// The language of the current request, for the root route loader.
// Server: the minima_lang cookie, then Accept-Language; null for the
// prerendered offline shell (/_shell.html), which resolves on the client.
// Client: the current language.

import { createIsomorphicFn } from '@tanstack/react-start'

import { getLang } from './core'
import { resolveServerLang } from './resolve'
import type { Lang } from './lang'

export const getRequestLang: () => Promise<Lang | null> = createIsomorphicFn()
  .server(async (): Promise<Lang | null> => {
    // Dynamic so that importing this module (e.g. through __root.tsx in a jsdom
    // test) never loads server code.
    const { getRequestHeader } = await import('@tanstack/react-start/server')
    const header = (name: string) =>
      getRequestHeader(name as Parameters<typeof getRequestHeader>[0]) ?? null
    if (process.env.TSS_PRERENDERING === 'true' || header('x-tss_shell') === 'true') {
      return null
    }
    return resolveServerLang({
      cookie: header('cookie'),
      acceptLanguage: header('accept-language'),
    })
  })
  .client((): Promise<Lang | null> => Promise.resolve(getLang()))
