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

- A module-level `let _key: CryptoKey | null = null` holds the vault DEK (a non-extractable AES-GCM key, set by `vault.ts` via `unlockLocalDb`) in memory only — never persisted. `getLocalDbKey()` returns it; `getLocalStore()` returns the shared `minima-local`/`data` store handle that `vault.ts` also uses.
- Every record (expense, income, category, budget) carries `updatedAt` (ISO), set on create and update.
- `readStore` silently returns `undefined` when `_key` is null; `writeStore` throws `"LocalDb not initialized"`.
- **Expense storage is chunked by month** (`expenses_YYYY_MM`). Categories, income, and budgets are single IDB keys.
- **Write lock:** every mutation runs its whole read-modify-write inside `withWriteLock(keys, fn)` from `src/lib/writeLock.ts`, locking the storage key(s) it touches (e.g. `updateExpense` locks the old and new chunk, `deleteCategory` locks `budgets` + `categories`). It uses `navigator.locks` (`minima:<key>`, cross-tab) when available and an in-memory per-key FIFO queue otherwise; multiple keys are acquired in sorted order. The lock is **not re-entrant**: never call another locked mutation from inside a locked section. Imports call the mutations row by row and so inherit the lock.
- **DecryptError** (`src/lib/dataErrors.ts`, re-exported from `localDb.ts`) carries the `storageKey`. Reads (`readStore` / `readChunk`) throw it for a blob that can't be decrypted; **mutations never catch it**, so an undecryptable blob is never overwritten. The global `QueryCache` / `MutationCache` `onError` (`src/lib/queryClient.ts`) reports it to `src/lib/dataProblem.ts`, and `DataProblemGate` (plus an error boundary) in `__root.tsx` replaces the routes with the Data problem screen (Retry, or Quarantine and continue).
- **Quarantine keys:** `quarantineKey(key)` moves the raw blob unchanged to `quarantine:<key>:<ISO timestamp>`, and only then deletes the original. `quarantine:*` keys are ignored by `allExpenseChunkKeys()` and every reader; `hasLocalData()` ignores them too.
- **Multi-tab sync:** after each committed write `localDb` posts `{ type: 'changed', keys }` on `BroadcastChannel('minima')` (`src/lib/syncChannel.ts`); `__root.tsx` calls `listenForChanges(queryClient)` so other tabs invalidate the matching React Query keys. Without `BroadcastChannel` this is a no-op.
- `ENABLE_SUPABASE_SYNC = false` at the top of `localDb.ts` is a stub for a future Premium cloud-sync tier.

### Encryption flow — vault v2 (`src/lib/vault.ts`, primitives in `src/lib/crypto.ts`)

Spec: `docs/free-tier-spec.md` §4.

1. **Key hierarchy.** A random 256-bit **DEK** encrypts every record/chunk (AES-GCM). It is wrapped (AES-GCM) twice: by **KEK_pw** = PBKDF2-SHA256(password, 16-byte salt, **600,000** iterations) and by **KEK_rc** = HKDF-SHA256(recovery key, 16-byte salt, info `minima-recovery-kek-v2`). In use the DEK is imported **non-extractable**; raw DEK and recovery-key bytes are zeroed after use.
2. **Recovery key:** 160 bits, Crockford base32 in 5-char groups (`XXXXX-…-XX`, `encodeRecoveryKey` / `parseRecoveryKey` in `crypto.ts`). Input ignores case, spaces and dashes.
3. **Header:** `VaultHeaderV2` (`kdf`, `wrappedByPassword`, `recovery`, `verifier`, all base64) lives in the **same IndexedDB store as the data** under `meta:vault`, not in localStorage, and does not depend on the Supabase userId. The verifier (`AES-GCM(DEK, "minima-verify-v2")`) tells "Incorrect password" (unwrap fails) from "Vault damaged" (unwrap works, verifier fails).
4. **API:** `getVaultState()` → `'none' | 'v1' | 'v2' | 'orphaned'`; `createVault(pw)` → `{ recoveryKey }`; `unlockWithPassword(pw)` → `{ recoveryKey: string | null }` (non-null only after a v1 migration); `unlockWithRecoveryKey(key)`; `resetPasswordWithRecoveryKey(key, next)`; `changePassword(current, next)`; `regenerateRecoveryKey(pw)` → `{ recoveryKey }`; `lockVault()`; `clearLegacyKeys()`. Errors are `VaultError` with a `code` (`incorrect-password`, `incorrect-recovery-key`, `damaged`, `throttled`, `invalid-state`). Changing the password or the recovery key only re-wraps the DEK; data is never re-encrypted. Successful unlocks call `unlockLocalDb(dek)`.
5. **Brute-force delay:** `meta:settings` holds `failedUnlockAttempts` / `unlockBlockedUntil` (plaintext). Password and recovery-key checks share the counter; from the 5th failure in a row the delay is 5 s, doubling up to 5 min (`unlockDelayMs`). Success resets it.
6. **v1 → v2 migration:** a v1 store (`minima_key_verify_<userId>` + `minima_device_salt_<userId>` in localStorage, PBKDF2 200k) is migrated by `unlockWithPassword`: every data blob is decrypted in memory, gets `updatedAt` (`createdAt` for expenses/income), is re-encrypted with a new DEK, and all values plus `meta:vault` are written in **one** `setMany` transaction. A failure leaves v1 untouched. The UI then shows the new recovery key and, after the user confirms it, calls `clearLegacyKeys()` to remove `minima_device_salt_*`, `minima_key_verify_*` and `minima_offline_user`.

### Unlock gate (`src/routes/__root.tsx`)

`PasswordUnlockDialog` is rendered in `RootDocument` (the `shellComponent`) behind a `mounted` guard (client-only). It appears as a full-screen overlay whenever `auth.user` is present and the app is not unlocked. It is a container that picks a screen from `getVaultState()` (components in `src/components/vault/`): `'none'` → `CreateVaultScreen` (password, then `RecoveryKeySaveStep`: Copy / Download .txt / Print, a checkbox and typing the last group); `'v1'` / `'v2'` → `UnlockScreen` (v2 offers "Forgot password?" → `RecoverScreen`: recovery key, then a new password); after a v1 migration it shows the new recovery key before finishing. For `'orphaned'` (data keys but no `meta:vault` and no v1 verifier), or if the state check fails, it does **not** offer "Create password": it shows a recovery state whose only action, "Erase local data and start fresh", requires typing `DELETE`, clears the store, then continues to `CreateVaultScreen`. `onUnlocked({ isNewVault })` then provisions the default categories for a new vault and invalidates React Query caches. Settings → Security (`SecurityTab`, `/settings?tab=security`) has Change password and Generate new recovery key.

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
