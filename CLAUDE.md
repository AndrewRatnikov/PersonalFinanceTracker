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

The app migrated away from Supabase for data. **Supabase is used only for the optional account** (see Unlock gate). All data lives in IndexedDB, encrypted at rest.

The primary data module is `src/lib/localDb.ts`:

- A module-level `let _key: CryptoKey | null = null` holds the vault DEK (a non-extractable AES-GCM key, set by `vault.ts` via `unlockLocalDb`) in memory only — never persisted. `getLocalDbKey()` returns it; `getLocalStore()` returns the shared `minima-local`/`data` store handle that `vault.ts` also uses.
- Every record (expense, income, category, budget) carries `updatedAt` (ISO), set on create and update.
- `readStore` silently returns `undefined` when `_key` is null; `writeStore` throws `"LocalDb not initialized"`.
- **Expense storage is chunked by month** (`expenses_YYYY_MM`). Categories, income, and budgets are single IDB keys.
- **Write lock:** every mutation runs its whole read-modify-write inside `withWriteLock(keys, fn)` from `src/lib/writeLock.ts`, locking the storage key(s) it touches (e.g. `updateExpense` locks the old and new chunk, `deleteCategory` locks `budgets` + `categories`). It uses `navigator.locks` (`minima:<key>`, cross-tab) when available and an in-memory per-key FIFO queue otherwise; multiple keys are acquired in sorted order. The lock is **not re-entrant**: never call another locked mutation from inside a locked section. Imports call the mutations row by row and so inherit the lock.
- **DecryptError** (`src/lib/dataErrors.ts`, re-exported from `localDb.ts`) carries the `storageKey`. Reads (`readStore` / `readChunk`) throw it for a blob that can't be decrypted; **mutations never catch it**, so an undecryptable blob is never overwritten. The global `QueryCache` / `MutationCache` `onError` (`src/lib/queryClient.ts`) reports it to `src/lib/dataProblem.ts`, and `DataProblemGate` (plus an error boundary) in `__root.tsx` replaces the routes with the Data problem screen (Retry, or Quarantine and continue).
- **Quarantine keys:** `quarantineKey(key)` moves the raw blob unchanged to `quarantine:<key>:<ISO timestamp>`, and only then deletes the original. `quarantine:*` keys are ignored by `allExpenseChunkKeys()` and every reader; `hasLocalData()` ignores them too.
- **lastDataChangeAt:** after every committed mutation (all of them except `quarantineKey`) `localDb` merges `lastDataChangeAt` (ISO) into the plaintext `meta:settings` object, under the `meta:settings` write lock, before the mutation's promise resolves. A failed marker write is logged and never fails the mutation. `expenseChunkKey(date)` is exported (UTC month chunk key).
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

No account is needed (spec §2.1). The root route has no auth requirement and never calls `getServerUser`.

- **Vault session** (`src/lib/vaultSession.ts`): a module-level store read with `useVaultSession()` (`useSyncExternalStore`). State is `{ phase, createRequested }`, phase `'checking' | 'none' | 'locked' | 'unlocked'`. On mount `RootDocument` maps `getVaultState()` through `phaseForVaultState` (`'none'` → `none`; `v1` / `v2` / `orphaned` → `locked`; a failed check → `locked`). The Header, the Landing page and `/` (Landing vs Dashboard) all branch on the phase.
- **Root `beforeLoad`:** on the client, a data route (`DATA_ROUTES`: `/analytics`, `/transactions`, `/income`, `/settings` and sub-paths, `isDataRoute`) with no vault throws `redirect({ to: '/' })`. A failed state check lets it through (the gate shows recovery). Hydration doesn't re-run `beforeLoad`, so an effect in `RootDocument` also navigates home when the phase is `none` on a data route.
- **`computeGate({ mounted, phase, createRequested, pathname })`** decides the overlay: `showGate` when mounted and the phase is `locked`, or `none` after the user clicked "Start tracking" (`requestCreateVault()`, Landing hero or marketing Header). `showChildren` is false only for data routes after mount until the phase is `unlocked`, so their queries never run without a key; `/`, `/login`, `/auth/callback` and `/profile` keep rendering under the overlay.
- **`PasswordUnlockDialog`** (the gate) picks a screen from `getVaultState()` (components in `src/components/vault/`): `'none'` → `CreateVaultScreen` (password, then `RecoveryKeySaveStep`: Copy / Download .txt / Print, a checkbox and typing the last group; a "Back" button calls `onCancelCreate` → `cancelCreateVault()`); `'v1'` / `'v2'` → `UnlockScreen` (v2 offers "Forgot password?" → `RecoverScreen`: recovery key, then a new password); after a v1 migration it shows the new recovery key before finishing. For `'orphaned'` (data keys but no `meta:vault` and no v1 verifier), or if the state check fails, it shows a recovery state whose only action, "Erase local data and start fresh", requires typing `DELETE`. `onUnlocked({ isNewVault })` provisions the default categories for a new vault, sets the phase to `unlocked` and invalidates React Query caches.
- **Lock:** `lockApp(queryClient)` clears the key (`lockVault()`), calls `queryClient.clear()`, moves `unlocked` to `locked` (never `none` to `locked`) and posts `{ type: 'lock' }`. It is used by the Header `LockButton`, Settings → Security "Lock now" and auto-lock. It never deletes data.
- **Auto-lock** (`src/lib/autoLock.ts`, `startAutoLock(minutes, onLock)`): `pointerdown` / `pointermove` / `keydown` count as activity; on becoming visible the elapsed time is checked directly, so hidden-tab time counts even when timers were throttled. The timeout (`Off`, 1, 5, 15 (default), 60 min) is in Settings → Security and stored in `meta:settings`.
- **Cross-tab:** `connectOtherTabs(queryClient)` listens for `lock` (lock this tab, no re-broadcast) and `wiped` (lock, then `reloadToHome()`) on the sync channel.
- **Remove data from this device** (`RemoveDataDialog`, Settings → Data → Danger zone): confirms with the vault password (`verifyPassword`, no unlock, counts toward the brute-force delay) and offers "Download backup first". `wipeLocalData()` (`src/lib/localWipe.ts`) locks, clears the IDB store, removes every `minima_*` localStorage key, posts `wiped` and requests `indexedDB.deleteDatabase('minima-local')` (not awaited); callers then `reloadToHome()` (`location.replace('/')`). The "I've lost both" link in `RecoverScreen` opens the same dialog with typed `DELETE` and no backup.
- **Accounts (optional):** `ENABLE_ACCOUNTS` (`src/lib/featureFlags.ts`, `VITE_ENABLE_ACCOUNTS === 'true'`, default off) or an existing local Supabase session (`getAccountSession()` in `src/lib/accountSession.ts`, `auth.getSession()` in the browser) makes `useAccountsVisible()` true: Header "Sign in" and Profile link, Settings → Account (`AccountTab`: email, Sign out, Delete account). `signOutAccount()` only ends the Supabase session; local data stays. `DeleteAccountDialog` keeps local data unless "Also remove data from this device" is ticked.
- **Durability (§6.1):** `CreateVaultScreen` calls `requestPersistentStorage()` after `createVault`; an unlock of an existing vault calls `ensurePersistentStorage()` (`src/lib/storagePersistence.ts`, records `persistRequestedAt`). Settings → Data shows `StorageStatusCard` (Protected / Best-effort, usage). On iOS Safari outside the Home Screen the Dashboard shows a one-time `InstallHintCard` (`src/lib/installHint.ts`; dismissal stored in `meta:settings`).

Settings tabs: Categories · Budget · Security (Change password, Generate new recovery key, Auto-lock, Lock now) · Data (Backup (.minima): download, restore, reminder frequency · Export CSV (.zip) · Import CSV · Storage status · Danger zone) · Account (only when accounts are visible).

### Backup & restore (`src/lib/backup.ts`, spec §7)

- **Format:** `MinimaBackupV1` (`format: 'minima-backup'`, `version: 1`, `createdAt`, `appVersion`, a snapshot of the vault header without `v`/`createdAt`, `payload: { enc, iv, ct }`, optional `skipped`). The payload is `JSON(BackupPayload)` (raw records with ids and full timestamps, plus `autoLockMinutes` / `backupReminderDays`), gzipped with `CompressionStream` when available (`enc: 'gzip+aes-gcm'`, else `'aes-gcm'`) and encrypted with the DEK. Because the header is a snapshot, a backup opens with the password that was current when it was made, or the recovery key (unless regenerated since).
- **API:** `createBackup({ allowPartial })` reads the raw store directly; without `allowPartial` an unreadable key throws `DecryptError`, with it the key goes into `skipped` (partial backup, "Back up readable data" on the Data problem screen). `serializeBackup` / `parseBackupFile` (validates format, version, header and payload fields), `backupFileName()` (`minima-backup-YYYY-MM-DD.minima`), `defaultRestoreMode()` (`replace` when there are no expenses, income or budgets), `restoreBackup(file, secret, mode)` → `RestoreSummary`, `formatRestoreSummary`, `downloadBackup({ partial })`. Errors are `BackupError` with a `code` (`invalid-file`, `unsupported-version`, `wrong-secret`, `damaged`, `invalid-state`).
- **Opening a backup:** `openHeaderWithSecret(header, secret)` in `vault.ts` unwraps the DEK of any header with a password or a recovery key (`null` for a wrong secret, `VaultError('damaged')` when the verifier fails). It never touches the local brute-force counter. `getVaultHeader()` returns the local header.
- **Restore:** nothing is written until the payload has decrypted and validated. Records are re-encrypted with the local DEK and everything (data keys, `meta:settings`, plus `meta:vault` on a fresh device) is written in **one** `setMany` transaction. **Replace:** the data becomes exactly the backup; local keys the backup doesn't cover become an encrypted `[]`; an undecryptable local blob is first copied to `quarantine:<key>:<ISO>` in the same transaction; `autoLockMinutes` / `backupReminderDays` are restored. **Merge:** upsert by `id`, the backup wins only when its `updatedAt` is strictly newer (equal timestamp, different content = a conflict, local kept), local-only records stay, expenses are regrouped into month chunks; a merge that adds and updates nothing writes nothing. **Fresh device** (`getVaultState() === 'none'`): the backup's header becomes `meta:vault`, mode is forced to replace and `unlockLocalDb(backupDek)` runs after the commit. Locked, v1 and orphaned devices are rejected. `lastBackupAt` is never taken from the file.
- **Saving files:** `saveFile(blob, filename, { share })` (`src/lib/fileDownload.ts`) uses `navigator.share({ files })` when asked and supported (`'cancelled'` on `AbortError`), otherwise one anchor download, revoking the object URL after `OBJECT_URL_REVOKE_DELAY_MS` (10 s). `downloadBackup` shares; `lastBackupAt` is recorded only after `saveFile` resolves `'saved'`.
- **UI:** Settings → Data backup card (`backup-download-btn`, `backup-restore-btn` → `RestoreBackupDialog`, `backup-reminder-select`), the landing page "Restore from backup" (`RestoreBackupDialog freshDevice`, then the phase becomes `unlocked`), RemoveDataDialog "Download backup first", and DataProblemScreen "Back up readable data" (`DataProblemGate` → `downloadBackup({ partial: true })`).

### Backup reminders (`src/lib/backupReminder.ts`, spec §6.2)

`meta:settings` also holds `backupReminderDays` (7 / 14 (default) / 30 / 0 = off), `lastBackupAt`, `lastDataChangeAt` and `backupReminderSnoozedUntil`; `getBackupSettings()` never throws and `updateBackupSettings` merges. The Dashboard `BackupReminderBanner` (query key `['backup-reminder']`, `getBackupReminderStatus()`) shows when reminders are on, data changed after the last backup (or there is none), the frequency has elapsed, the vault has ≥ 10 records and no snooze is active. "Later" snoozes for 3 days.

### CSV (`src/lib/localImport.ts`, `src/lib/localExport.ts`, spec §8)

CSV is for spreadsheets, not a backup ("Readable by spreadsheets · not encrypted · not a full backup"). Export is one `minima-csv-YYYY-MM-DD.zip` built with `fflate` (`buildCsvFiles`, `buildCsvZip`, `exportAllLocalData`). Import uses a quote-aware state-machine `parseCSV` (quoted commas, newlines and `""`, CRLF, BOM) with `,` / `;` detection (`detectDelimiter`) and `parseAmount` (decimal comma, space/NBSP thousands). Expenses and income skip rows whose fingerprint (`local date|amount|currency|category-or-source|description`) matches an existing record and report them as `duplicates` / `duplicateRows`; "Import them anyway" re-imports just those rows with `{ allowDuplicates: true, rows }`. Rows inside one file are not checked against each other.

### Data flow

All routes use React Query (`useQuery` / `useMutation`) against `localDb` functions — not server functions:

| Query key                | Source function         |
| ------------------------ | ----------------------- |
| `['categories']`         | `getAllCategories()`    |
| `['expenses', from, to]` | `getExpensesForRange()` |
| `['income']`             | `getAllIncome()`        |
| `['budgets']`            | `getAllBudgets()`       |
| `['settings']`           | `getAppSettings()`      |
| `['account-session']`    | `getAccountSession()`   |
| `['backup-reminder']`    | `getBackupReminderStatus()` |
| `['backup-settings']`    | `getBackupSettings()`   |

Analytics are computed client-side in `src/lib/localAnalytics.ts` via `computeRangeAnalytics()`.

The `QueryClient` instance is module-level in `__root.tsx` (built by `createAppQueryClient()`, which never retries a DecryptError) and shared via `QueryClientProvider`. `lockApp` empties it with `queryClient.clear()`, so nothing decrypted stays in memory after a lock. Every page renders `QueryErrorState` (`data-testid="query-error"` with a Retry button) instead of default empty values when one of its queries fails.

`['settings']` reads the plaintext app settings in `meta:settings` (`src/lib/appSettings.ts`: `autoLockMinutes`, `installHintDismissed`, `persistRequestedAt`); `updateAppSettings` merges into the stored object and keeps the brute-force counter fields.

### PWA / Service Worker

`vite-plugin-pwa` generates `sw.js` + workbox files into `dist/`. A custom Vite plugin (`copySWPlugin` in `vite.config.ts`) copies them into `.vercel/output/static/` post-build since Nitro serves static assets from there. The SW is registered manually in `RootDocument`'s `useEffect` (`/sw.js`).

### Key derivation for `localDb.ts` writes

Any function that writes to IDB requires `_key` to be non-null. If you add a new write operation and tests fail with "LocalDb not initialized", the DB hasn't been unlocked yet in that code path.
