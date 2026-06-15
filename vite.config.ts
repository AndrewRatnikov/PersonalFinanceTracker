import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { URL, fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

import tailwindcss from '@tailwindcss/vite'

// Copies sw.js + workbox-*.js from dist/ into Nitro's static output dir after build.
// vite-plugin-pwa writes to Vite's outDir (dist/) but Nitro/Vercel serves static
// files from .vercel/output/static/ — this bridge closes that gap.
const copySWPlugin = {
  name: 'copy-sw-to-nitro-static',
  apply: 'build' as const,
  enforce: 'post' as const,
  closeBundle() {
    const staticDir = '.vercel/output/static'
    if (!existsSync(staticDir)) return
    const swFiles = readdirSync('dist').filter(
      (f) => f === 'sw.js' || f.startsWith('workbox-'),
    )
    for (const f of swFiles) copyFileSync(`dist/${f}`, `${staticDir}/${f}`)
  },
}

const config = defineConfig({
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
        // Precache only the stable public-dir files (always present, no build-dir dependency)
        globDirectory: 'public',
        globPatterns: ['*.{ico,png,svg,json}'],
        // SSR handles all navigation; disable the SPA index.html fallback
        navigateFallback: null,
        runtimeCaching: [
          {
            // Cache JS/CSS/fonts at runtime as they're requested
            urlPattern: /\/assets\/.*\.(?:js|css|woff2)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'assets',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    nitro({ preset: 'vercel' }),
    copySWPlugin,
  ],
})

export default config
