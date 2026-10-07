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

Tests use Vitest + jsdom (`vitest.config.ts`, separate from `vite.config.ts`) and live next to the module they test; route tests live in `src/test/routes/`. See `.claude/rules/testing.md`.

## Architecture

**Framework:** TanStack Start (React 19 + TanStack Router file-based routing + Vite + Nitro/Vercel SSR). Routes live in `src/routes/`; the route tree is auto-generated into `src/routeTree.gen.ts` — do not edit it manually. `@/` is an alias for `src/`.

**UI:** Tailwind CSS v4 + shadcn/ui components (in `src/components/ui/`). `components.json` controls shadcn config. Charts use Recharts.

### Storage — local-first, encrypted IndexedDB

The app migrated away from Supabase for data. **Supabase is auth-only.** All data lives in IndexedDB, encrypted at rest.

The primary data module is `src/lib/localDb.ts`:

- A module-level `let _key: CryptoKey | null = null` holds the AES-GCM key in memory only — never persisted.
- `readStore` silently returns `undefined` when `_key` is null; `writeStore` throws `"LocalDb not initialized"`.
- **Expense storage is chunked by month** (`expenses_YYYY_MM`). Categories, income, and budgets are single IDB keys.
- **Write lock:** every mutation runs its whole read-modify-write inside `withWriteLock(keys, fn)` from `src/lib/writeLock.ts`, locking the storage key(s) it touches (e.g. `updateExpense` locks the old and new chunk, `deleteCategory` locks `budgets` + `categories`). It uses `navigator.locks` (`minima:<key>`, cross-tab) when available and an in-memory per-key FIFO queue otherwise; multiple keys are acquired in sorted order. The lock is **not re-entrant**: never call another locked mutation from inside a locked section. Imports call the mutations row by row and so inherit the lock.
- **DecryptError** (`src/lib/dataErrors.ts`, re-exported from `localDb.ts`) carries the `storageKey`. Reads (`readStore` / `readChunk`) throw it for a blob that can't be decrypted; **mutations never catch it**, so an undecryptable blob is never overwritten. The global `QueryCache` / `MutationCache` `onError` (`src/lib/queryClient.ts`) reports it to `src/lib/dataProblem.ts`, and `DataProblemGate` (plus an error boundary) in `__root.tsx` replaces the routes with the Data problem screen (Retry, or Quarantine and continue).
- **Quarantine keys:** `quarantineKey(key)` moves the raw blob unchanged to `quarantine:<key>:<ISO timestamp>`, and only then deletes the original. `quarantine:*` keys are ignored by `allExpenseChunkKeys()` and every reader; `hasLocalData()` ignores them too.
- **Multi-tab sync:** after each committed write `localDb` posts `{ type: 'changed', keys }` on `BroadcastChannel('minima')` (`src/lib/syncChannel.ts`); `__root.tsx` calls `listenForChanges(queryClient)` so other tabs invalidate the matching React Query keys. Without `BroadcastChannel` this is a no-op.
- `ENABLE_SUPABASE_SYNC = false` at the top of `localDb.ts` is a stub for a future Premium cloud-sync tier.

### Encryption flow (`src/lib/crypto.ts`)

1. A random 32-byte device salt is stored in `localStorage` under `minima_device_salt_{userId}` (created on first unlock per device).
2. The user provides a password; PBKDF2-SHA256 (200k iterations) derives a `CryptoKey`.
3. A sentinel value is encrypted and stored in `localStorage` under `minima_key_verify_{userId}` to verify the password on future logins without storing the password.
4. The derived key is passed to `unlockLocalDb(key)` which sets the module-level `_key`.

### Unlock gate (`src/routes/__root.tsx`)

`PasswordUnlockDialog` is rendered in `RootDocument` (the `shellComponent`) behind a `mounted` guard (client-only). It appears as a full-screen overlay whenever `auth.user` is present and `_key` is null. If there is no `minima_key_verify_{userId}` but IndexedDB still holds data keys (`hasLocalData()`), it does **not** offer "Create password": it shows a recovery state whose only action, "Erase local data and start fresh", requires typing `DELETE`, clears the store, then continues to the create-password flow. After unlock, `provisionDefaultCategories()` from `localDb` is called (seeds the six default categories into IDB if empty), then React Query caches are invalidated.

The `beforeLoad` in `__root.tsx` also calls `provisionServerCategories()` (the Supabase version) on first login — this is a legacy path planned for removal once the local-first migration is complete.

### Data flow

All routes use React Query (`useQuery` / `useMutation`) against `localDb` functions — not server functions:

| Query key                | Source function         |
| ------------------------ | ----------------------- |
| `['categories']`         | `getAllCategories()`    |
| `['expenses', from, to]` | `getExpensesForRange()` |
| `['income']`             | `getAllIncome()`        |
| `['budgets']`            | `getAllBudgets()`       |

Analytics are computed client-side in `src/lib/localAnalytics.ts` via `computeRangeAnalytics()`.

The `QueryClient` instance is module-level in `__root.tsx` (built by `createAppQueryClient()`, which never retries a DecryptError) and shared via `QueryClientProvider`. Every page renders `QueryErrorState` (`data-testid="query-error"` with a Retry button) instead of default empty values when one of its queries fails.

### PWA / Service Worker

`vite-plugin-pwa` generates `sw.js` + workbox files into `dist/`. A custom Vite plugin (`copySWPlugin` in `vite.config.ts`) copies them into `.vercel/output/static/` post-build since Nitro serves static assets from there. The SW is registered manually in `RootDocument`'s `useEffect` (`/sw.js`).

### Key derivation for `localDb.ts` writes

Any function that writes to IDB requires `_key` to be non-null. If you add a new write operation and tests fail with "LocalDb not initialized", the DB hasn't been unlocked yet in that code path.
