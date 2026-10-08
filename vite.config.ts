import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { URL, fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

import tailwindcss from '@tailwindcss/vite'

import { APP_SHELL_URL, STATIC_OUTPUT_DIR } from './scripts/precacheCheck.ts'

// Copies sw.js + workbox-*.js from dist/ into Nitro's static output dir after build.
// vite-plugin-pwa writes to Vite's outDir (dist/) but Nitro/Vercel serves static
// files from .vercel/output/static/ — this bridge closes that gap.
const copySWPlugin = {
  name: 'copy-sw-to-nitro-static',
  apply: 'build' as const,
  enforce: 'post' as const,
  closeBundle() {
    const staticDir = STATIC_OUTPUT_DIR
    if (!existsSync(staticDir)) return
    const swFiles = readdirSync('dist').filter(
      (f) => f === 'sw.js' || f.startsWith('workbox-'),
    )
    for (const f of swFiles) copyFileSync(`dist/${f}`, `${staticDir}/${f}`)
  },
}

// Per-build revision for the app shell. The shell is prerendered after generateSW
// has run, so workbox can't hash it; a new value per build makes the SW refetch it.
const SHELL_REVISION = Date.now().toString(36)

const config = defineConfig(({ command }) => ({
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: false,
      workbox: {
        // Claim all existing clients immediately so the SW intercepts requests on the
        // very first page load, not only after the user navigates away and back.
        // Without this, the first offline reload would bypass the SW.
        clientsClaim: true,
        skipWaiting: true,
        // Precache the whole client build (every JS chunk incl. route chunks, CSS,
        // fonts) plus the public files, as served from Nitro's static output dir.
        // The SW files themselves and the shell (added below) are excluded.
        globDirectory: STATIC_OUTPUT_DIR,
        globPatterns: ['**/*.{js,css,woff,woff2,html,ico,png,svg,json}'],
        globIgnores: ['sw.js', 'workbox-*.js', '_shell.html'],
        // Don't silently drop a chunk that grows past workbox's 2 MiB default.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // App shell (TanStack Start SPA shell, root route only). It's written by the
        // post-build prerender, after generateSW, so it can't be globbed.
        additionalManifestEntries: [
          { url: APP_SHELL_URL, revision: SHELL_REVISION },
        ],
        // Keep: a NavigationRoute would replace SSR while online.
        navigateFallback: null,
        runtimeCaching: [
          {
            // Navigations always go to the network (SSR online). When the network
            // fails, the precached shell boots the client for any route. No HTML
            // runtime cache and no expiry: cached SSR pages would outlive a deploy
            // and point at chunks the new precache has removed. The old CacheFirst
            // rule for /assets/ is gone because every asset is precached.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkOnly',
            options: { precacheFallback: { fallbackURL: APP_SHELL_URL } },
          },
        ],
      },
    }),
    devtools(),
    tailwindcss(),
    // On build, prerender /_shell.html (root route only) for the offline fallback.
    // Runtime SSR is unchanged. Disabled in dev, where it would shell every request.
    tanstackStart({ spa: { enabled: command === 'build' } }),
    viteReact(),
    nitro({ preset: 'vercel' }),
    copySWPlugin,
  ],
}))

export default config
