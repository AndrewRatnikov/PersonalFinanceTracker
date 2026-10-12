# Offline navigations fall back to a precached SPA shell; nothing in the service worker expires

- **Status:** Accepted
- **Date:** 2026-10-08
- **Source:** orchestrator run `run_20261008_204753` (Phase 5, offline hardening, GAP-1 to GAP-7)
- **Code:** `vite.config.ts` (`VitePWA` block, `tanstackStart({ spa })`), `scripts/precacheCheck.ts`, `scripts/precacheCheck.test.ts`, `npm run test:precache`
- **Spec:** `docs/free-tier-spec.md` §6.3

## Context

The app stopped loading offline 24 hours after the last online visit, because the `navigation` cache had a 24-hour `maxAgeSeconds`. Routes never visited online didn't work offline at all. The app is SSR (TanStack Start on Vercel), so there is no static `index.html` to fall back to.

## Decision

- **Precache the whole client build:** every JS, CSS and font file, the icons and `manifest.json` from `.vercel/output/static`. The CacheFirst `assets` runtime rule, with its 30-day expiry, is removed because everything is precached.
- **App shell:** TanStack Start's own SPA shell, `/_shell.html` (root route only), prerendered at build time (`spa.enabled` only when `command === 'build'`). It is added to the precache with `additionalManifestEntries` and a per-build revision.
- **Navigations:** `NetworkOnly` with `precacheFallback` to the shell. Online pages stay SSR, and an offline navigation to any data route boots from the shell. There is **no navigation runtime cache and no expiry** anywhere.
- A build check (`npm run test:precache`, gated by `PRECACHE_BUILD_CHECK=1` so plain `npm test` skips it) asserts that every asset, the shell and the icons are precached and that `sw.js` contains no expiry.

## Alternatives considered

- **Precache the SSR'd `/` page as the shell.** Rejected: it dehydrates the index route's match, so deep routes get hydration mismatches.
- **A hand-written HTML shell.** Rejected: it duplicates the asset list and has no router bootstrap.
- **Keep cached SSR HTML, with or without expiry.** Rejected: after a deploy, cached HTML points at chunks the new precache has removed, so offline loads break.
- **A 3-second network timeout before falling back.** Rejected. On a flaky connection the browser waits for its own network error instead.

## Consequences

- After one successful load, every data route works offline indefinitely. `/profile`, `/login` and `/auth/callback` still need the network.
- Each deploy re-downloads the shell (about 7 KB) at service worker install.
- Old `navigation` and `assets` caches stay in existing users' browsers, unused and harmless.
- Never pass `prerender: { enabled: true }`: static `index.html` files would shadow SSR.
