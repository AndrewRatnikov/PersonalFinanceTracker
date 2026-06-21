# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # start dev server on port 3000
npm run build      # production build
npm run preview    # preview production build locally
npm run test       # run all tests (Vitest)
npm run lint       # ESLint
npm run check      # prettier --write + eslint --fix
```

There are currently no test files in the repo.

## Architecture

**Framework:** TanStack Start (React 19 + TanStack Router file-based routing + Vite + Nitro/Vercel SSR). Routes live in `src/routes/`; the route tree is auto-generated into `src/routeTree.gen.ts` — do not edit it manually. `@/` is an alias for `src/`.

**UI:** Tailwind CSS v4 + shadcn/ui components (in `src/components/ui/`). `components.json` controls shadcn config. Charts use Recharts.

### Storage — local-first, encrypted IndexedDB

The app migrated away from Supabase for data. **Supabase is auth-only.** All data lives in IndexedDB, encrypted at rest.

The primary data module is `src/lib/localDb.ts`:
- A module-level `let _key: CryptoKey | null = null` holds the AES-GCM key in memory only — never persisted.
- `readStore` silently returns `undefined` when `_key` is null; `writeStore` throws `"LocalDb not initialized"`.
- **Expense storage is chunked by month** (`expenses_YYYY_MM`). Categories, income, and budgets are single IDB keys.
- `ENABLE_SUPABASE_SYNC = false` at the top of `localDb.ts` is a stub for a future Premium cloud-sync tier.

### Encryption flow (`src/lib/crypto.ts`)

1. A random 32-byte device salt is stored in `localStorage` under `minima_device_salt_{userId}` (created on first unlock per device).
2. The user provides a password; PBKDF2-SHA256 (200k iterations) derives a `CryptoKey`.
3. A sentinel value is encrypted and stored in `localStorage` under `minima_key_verify_{userId}` to verify the password on future logins without storing the password.
4. The derived key is passed to `unlockLocalDb(key)` which sets the module-level `_key`.

### Unlock gate (`src/routes/__root.tsx`)

`PasswordUnlockDialog` is rendered in `RootDocument` (the `shellComponent`) behind a `mounted` guard (client-only). It appears as a full-screen overlay whenever `auth.user` is present and `_key` is null. After unlock, `provisionDefaultCategories()` from `localDb` is called (seeds the six default categories into IDB if empty), then React Query caches are invalidated.

The `beforeLoad` in `__root.tsx` also calls `provisionServerCategories()` (the Supabase version) on first login — this is a legacy path planned for removal once the local-first migration is complete.

### Data flow

All routes use React Query (`useQuery` / `useMutation`) against `localDb` functions — not server functions:

| Query key | Source function |
|-----------|----------------|
| `['categories']` | `getAllCategories()` |
| `['expenses', from, to]` | `getExpensesForRange()` |
| `['income']` | `getAllIncome()` |
| `['budgets']` | `getAllBudgets()` |

Analytics are computed client-side in `src/lib/localAnalytics.ts` via `computeRangeAnalytics()`.

The `QueryClient` instance is module-level in `__root.tsx` and shared via `QueryClientProvider`.

### Legacy files (do not use for new code)

- `src/lib/offlineCache.ts` — superseded by `localDb.ts`; planned for deletion
- `src/lib/expenses.ts`, `src/lib/income.ts`, `src/lib/budgets.ts`, `src/lib/analytics.ts` — Supabase server functions; no longer called by routes

### PWA / Service Worker

`vite-plugin-pwa` generates `sw.js` + workbox files into `dist/`. A custom Vite plugin (`copySWPlugin` in `vite.config.ts`) copies them into `.vercel/output/static/` post-build since Nitro serves static assets from there. The SW is registered manually in `RootDocument`'s `useEffect` (`/sw.js`).

### Key derivation for `localDb.ts` writes

Any function that writes to IDB requires `_key` to be non-null. If you add a new write operation and tests fail with "LocalDb not initialized", the DB hasn't been unlocked yet in that code path.
