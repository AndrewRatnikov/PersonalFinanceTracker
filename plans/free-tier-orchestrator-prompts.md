# Orchestrator prompts: Free tier

One orchestrator run per phase, in order. Each prompt depends on the previous phase being merged.
Source of truth for all of them: `docs/free-tier-spec.md` (it must be committed to `main` before the first run).

---

## Run 1: Phase 1 · Safety net

```text
Implement Phase 1 ("Safety net") of docs/free-tier-spec.md: §5.1 write serialization, §5.2 never overwrite undecryptable data, §5.3 error states in every view, §5.4 multi-tab consistency, and bug B1 (budget vs. actual over arbitrary ranges). The spec is the source of truth. Where it is silent, choose the simplest behaviour and record it as a CONTRACT_GAP.

CONTEXT
- Data layer: src/lib/localDb.ts (encrypted idb-keyval store "minima-local"/"data"; expenses chunked as expenses_YYYY_MM; categories/income/budgets as single keys). Every mutation is read-modify-write with no locking.
- Reproduced on 2026-10-07 against current main:
  - 5 concurrent addIncome() calls store 1 entry (expected 5).
  - 2 concurrent upsertBudget() calls for different categories store 1 budget (expected 2).
  - computeRangeAnalytics over 90 days with 800/month spend against a 1000/month UAH budget returns overBudget: true with actual 2400 vs budget 1000.
  - provisionDefaultCategories() with a different key over existing data throws DecryptError, but nothing in the UI handles it: the dashboard shows zeros and Analytics spins forever (analytics.tsx checks `isLoading || !analytics`, never isError).
  - PasswordUnlockDialog decides "new user" only by the absence of localStorage minima_key_verify_<userId>, so it offers "Create password" even when IndexedDB still holds data.

SCOPE

1. Write lock (§5.1)
   - New module src/lib/writeLock.ts exporting withWriteLock<T>(keys: string | string[], fn: () => Promise<T>): Promise<T>.
   - Use navigator.locks.request('minima:' + key, ...) when available. Otherwise fall back to an in-memory promise queue per key.
   - Multiple keys are acquired in sorted order (to avoid deadlock).
   - Wrap every mutating function in localDb.ts so that the whole read-modify-write runs under the lock for the storage key(s) it touches:
     addExpense, updateExpense (old and new chunk keys), deleteExpense, addCategory, updateCategory, deleteCategory (categories + budgets), provisionDefaultCategories, addIncome, deleteIncome, upsertBudget, deleteBudget.
   - Imports call these functions row by row, so they inherit the lock. Do not hold one lock across a whole import.

2. Never overwrite undecryptable data (§5.2)
   - readStore/readChunk keep throwing DecryptError. No mutation may catch it.
   - Add a DataProblemScreen shown when any query throws DecryptError. Wire it through a React Query QueryCache onError plus an error boundary in __root.tsx. The screen:
     - names the affected key (e.g. "Expenses · 2026-03" for expenses_2026_03, or "Categories")
     - has a "Retry" action
     - has a "Quarantine and continue" action: move the raw blob unchanged to quarantine:<key>:<ISO timestamp> and delete the original key, then invalidate queries. Never delete a blob without moving it first.
   - Orphaned data in the current v1 format: if no minima_key_verify_<userId> exists but the store contains any expenses_*, categories, income or budgets key, PasswordUnlockDialog must NOT offer "Create password". Instead show a recovery state with a single destructive action, "Erase local data and start fresh", which requires typing DELETE, then clears the store and continues to the create-password flow.
   - quarantine:* keys are ignored by allExpenseChunkKeys() and every reader.

3. Error states (§5.3)
   - Dashboard (routes/index.tsx), Analytics, Transactions, Income and Settings (categories + budgets) must not render default empty values when a query is in error.
   - Each shows an inline error block with data-testid="query-error" and a retry button data-testid="query-error-retry" that calls refetch. A DecryptError still goes to the DataProblemScreen.
   - Analytics must not spin forever on error.

4. Multi-tab (§5.4)
   - New module src/lib/syncChannel.ts using BroadcastChannel('minima'). If BroadcastChannel is unavailable it does nothing.
   - After each committed write, localDb posts { type: 'changed', keys: [...] }.
   - Receiving tabs invalidate the affected React Query keys: expenses_* → ['expenses'] and ['analytics']; categories → ['categories'], ['expenses'] and ['budgets']; income → ['income'] and ['analytics']; budgets → ['budgets'] and ['analytics'].
   - Keep the module small and injectable for tests.

5. B1 budget fix
   - In computeRangeAnalytics, compare actual spend with a range-scaled limit:
     limitForRange = Σ over each calendar month touched by [from, to] of monthlyLimit × (days of the range inside that month / days in that month), using local dates.
   - BudgetVarianceItem.budget becomes that scaled limit.
   - A range exactly covering one calendar month gives the plain monthlyLimit.
   - BudgetSummaryCard / dashboardSummary (current-month logic) stays unchanged.

CONSTRAINTS
- Do not change the encryption, key derivation, localStorage keys or IndexedDB value format. Vault v2 is Phase 2. No data migration in this run.
- No new runtime dependencies.
- Follow .claude/rules/testing.md: separate vitest.config.ts, no jest-dom, fireEvent only, locale-safe number assertions, type-aware lint on tests.
- jsdom has no navigator.locks: test the fallback queue, and test the navigator.locks path with a fake.
- tsc --noEmit, npm run lint and npm test must all pass.
- Update CLAUDE.md where it describes localDb (write lock, DecryptError handling, quarantine keys). Also remove its stale lines: "There are currently no test files in the repo" and the "Legacy files" list of already-deleted modules.
- In docs/free-tier-spec.md §11, mark Phase 1 as done with the run id.

ACCEPTANCE (each must be a test)
- 5 concurrent addIncome() store 5 entries. 2 concurrent upsertBudget() for different categories store 2. 10 concurrent addExpense() into the same month store 10.
- updateExpense moving a record to another month while a concurrent addExpense targets the destination month loses nothing.
- Corrupt an expenses chunk (bytes that fail decryption), then addExpense into that month: it rejects with DecryptError and the stored blob is byte-identical afterwards.
- "Quarantine and continue" moves the blob unchanged to quarantine:<key>:<ts>, the original key is gone, and getAllExpenses() no longer throws.
- Unlock dialog: no verifier plus existing data keys shows the recovery state and never "Create password". Erase requires typing DELETE.
- Analytics with a failing query renders data-testid="query-error", not a spinner. Same for the Dashboard, Transactions and Income pages.
- 90-day range, 800 UAH spent per month, 1000 UAH monthly budget: overBudget is false. A range covering exactly one calendar month with 1200 spent: overBudget is true and budget equals 1000.
- A 'changed' message for income invalidates ['income'] and ['analytics'] (tested with an injected fake channel).

OUT OF SCOPE
Vault v2 / recovery key / password change (Phase 2), removing the auth gate and lock or auto-lock (Phase 3), .minima backup, CSV zip or dedupe (Phase 4), service worker changes (Phase 5).
```

---

## Run 2: Phase 2 · Vault v2

```text
Implement Phase 2 ("Vault v2") of docs/free-tier-spec.md: §4.1–4.5 and the forgot-password flow in §2.3, plus "Change password" and "Generate new recovery key" from §3. The spec is the source of truth. Where it is silent, choose the simplest behaviour and record a CONTRACT_GAP.

SCOPE
- New module src/lib/vault.ts:
  - createVault(password) → { recoveryKey }
  - unlockWithPassword(password)
  - unlockWithRecoveryKey(key)
  - changePassword(current, next)
  - resetPasswordWithRecoveryKey(key, next)
  - regenerateRecoveryKey(password) → { recoveryKey }
  - getVaultState() → 'none' | 'v1' | 'v2' | 'orphaned'
- Key hierarchy exactly as in §4.1:
  - random 256-bit DEK, imported non-extractable for use
  - PBKDF2-SHA256 with 600k iterations and a 16-byte salt for the password KEK
  - HKDF-SHA256 for the recovery-key KEK
  - AES-GCM wrapping
  - recovery key: 160-bit Crockford base32 in 5-char groups; input ignores case, spaces and dashes
- VaultHeaderV2 stored in IndexedDB under meta:vault (§4.2), not in localStorage. meta:settings holds the §4.3 fields that this phase uses.
- localDb encrypts and decrypts with the DEK from the vault. The withWriteLock from Phase 1 stays.
- Brute-force delay (§4.4): stored in meta:settings, reset on success.
- v1 → v2 migration (§4.5):
  - decrypt everything in memory
  - re-encrypt with the DEK
  - write all values plus meta:vault in ONE idb transaction (setMany)
  - remove the v1 localStorage keys only after success
  - show the recovery key afterwards
  - add updatedAt = createdAt to every record (§5.5)
- UI: split PasswordUnlockDialog into CreateVaultScreen (password, then the save-recovery-key step with Copy / Download .txt / Print, a checkbox and typing the last group), UnlockScreen (with "Forgot password?") and RecoverScreen (recovery key, then new password). Add a Settings → Security tab with Change password and Generate new recovery key.
- All records gain updatedAt, set on create and update (§5.5).

CONSTRAINTS
- Auth gate and sign-out behaviour stay as they are (Phase 3). The vault may still be keyed by Supabase userId for now, but meta:vault must not depend on it.
- No new runtime dependencies (WebCrypto only).
- Follow .claude/rules/testing.md. tsc, lint and tests must be green. Update CLAUDE.md "Encryption flow". Mark Phase 2 done in spec §11.

ACCEPTANCE (tests)
- createVault, reload, unlockWithPassword works. A wrong password is rejected and the delay increases after 5 failures.
- Recovery key unlock works and sets a new password. The old password then fails.
- After changePassword, the old password fails, the new one works and the recovery key still works. Data blobs are unchanged (no re-encryption).
- After regenerateRecoveryKey, the old key fails and the new one works.
- A v1 fixture store (PBKDF2 200k with the device salt from localStorage) migrates with all records equal and updatedAt added. A failure injected before the transaction commits leaves the v1 data and v1 localStorage keys intact.
- getVaultState returns 'orphaned' when data keys exist without meta:vault and without a v1 verifier. The UI then shows the recovery state from Phase 1, never create-vault.
```

---

## Run 3: Phase 3 · No-account mode

```text
Implement Phase 3 ("No-account mode") of docs/free-tier-spec.md: §2.1, §2.2, §2.4, §2.5, §2.6, §3 (Security and Data tab structure) and §6.1. The spec is the source of truth. Where it is silent, choose the simplest behaviour and record a CONTRACT_GAP.

SCOPE
- __root.tsx:
  - Remove the auth requirement and the getServerUser() call from beforeLoad on every navigation.
  - Data routes show the unlock gate when locked and redirect to / when getVaultState() === 'none'. They never redirect to /login.
- Landing page CTA "Start tracking" goes to the create-vault flow. Add "Restore from backup" as a disabled placeholder (Phase 4).
- Lock:
  - header lock button and Settings → Security → Lock now
  - clears the in-memory DEK, calls queryClient.clear() and broadcasts { type: 'lock' } via syncChannel
- Auto-lock: Off / 1 / 5 / 15 (default) / 60 minutes of inactivity. Hidden-tab time counts as inactive. The setting lives in meta:settings.
- RemoveDataDialog (Settings → Data → Danger zone):
  - "Download backup first" is a placeholder that calls the existing CSV export until Phase 4
  - confirm with the password, or by typing DELETE when reached from the "lost both" path
  - deletes the minima-local database and all minima_* localStorage keys, broadcasts { type: 'wiped' } and navigates to /
- Accounts behind ENABLE_ACCOUNTS (default false):
  - Settings → Account appears only when the flag is on or a Supabase session exists
  - Sign out ends the session only and leaves local data untouched
  - Delete account adds an unticked "Also remove data from this device" checkbox
  - Profile route and Header user menu follow the same rule
- SignOutDialog is deleted.
- §6.1:
  - call navigator.storage.persist() after vault creation, and on unlock while persisted() is false
  - Storage status in Settings → Data (Protected / Best-effort plus estimate())
  - one-time iOS Safari "Add to Home Screen" hint when not standalone

CONSTRAINTS
- Keep the /login and /auth/callback routes working for existing accounts, and keep account.ts.
- No new runtime dependencies. Follow .claude/rules/testing.md. tsc, lint and tests must be green. Update CLAUDE.md "Unlock gate" and "Data flow". Mark Phase 3 done in spec §11.

ACCEPTANCE (tests)
- With no Supabase session and no vault, / shows the landing page and /transactions redirects to /. After creating a vault, all data routes work without any auth call (assert getServerUser is not called).
- Lock leaves the key null and the query cache empty, and the unlock screen shows. Auto-lock fires after the timeout (fake timers). A lock message received from another tab locks this tab.
- Remove data deletes the store and the minima_* keys, and a 'wiped' message sends other tabs to /.
- With ENABLE_ACCOUNTS false and no session, no Account/Profile UI renders. With a session, Sign out leaves IndexedDB data intact.
- persist() is called after createVault.
```

---

## Run 4: Phase 4 · Backup

```text
Implement Phase 4 ("Backup") of docs/free-tier-spec.md: §7 (.minima backup and restore), §6.2 (backup reminders) and §8 (CSV zip export, robust parser, duplicate protection). Also replace the Phase 3 placeholders ("Download backup first", landing "Restore from backup") and add "Back up readable data" to the DataProblemScreen (§5.2). The spec is the source of truth. Where it is silent, choose the simplest behaviour and record a CONTRACT_GAP.

SCOPE
- New module src/lib/backup.ts:
  - createBackup(): MinimaBackupV1 using the exact format in §7.1, with the payload encrypted by the DEK and gzip via CompressionStream when available, recorded in payload.enc
  - restoreBackup(file, secret, mode: 'replace' | 'merge'): merge upserts by id and the newer updatedAt wins; the write is one transaction; returns a summary
  - restoring on a device with no vault adopts the backup's vault header
  - partial backup that records undecryptable keys in `skipped`
- Download uses navigator.share({ files }) when supported, otherwise a single blob download, and revokes the object URL after a delay. Set lastBackupAt only after success.
- Reminders (§6.2): track lastDataChangeAt in the localDb commit path. Dashboard banner rule exactly as in the spec, with the "Later" snooze and a frequency setting in Settings → Data.
- CSV (§8):
  - export as one zip using fflate (the only new dependency allowed)
  - replace parseCSV with a quote-aware state machine that handles embedded newlines, commas and "" escapes, plus ',' / ';' delimiter detection
  - expenses and income dedupe by fingerprint date|amount|currency|category-or-source|description, with an "Import them anyway" override
  - UI labels CSV as "not encrypted · not a full backup"

CONSTRAINTS
- Follow .claude/rules/testing.md. tsc, lint and tests must be green. Mark Phase 4 done in spec §11.

ACCEPTANCE (tests)
- Backup, remove data, restore on an empty device gives identical records (ids, createdAt including time, updatedAt).
- Merge-restoring the same file twice adds nothing. A newer local record is kept and an older one is overwritten.
- A backup made before a password change opens with the old password and with the recovery key, and not with the new password.
- A corrupted chunk gives "Back up readable data" with the key listed in `skipped`, and every other record restorable.
- CSV: the same expenses file imported twice gives 0 inserted on the second run with N reported as duplicates. "Import them anyway" inserts them. A quoted multi-line description round-trips export → import. A ';'-delimited file imports.
- The banner shows when the spec's conditions hold, hides after a backup and respects the snooze.
```

---

## Run 5: Phase 5 · Offline hardening

```text
Implement Phase 5 ("Offline hardening") of docs/free-tier-spec.md §6.3. The spec is the source of truth. Where it is silent, choose the simplest behaviour and record a CONTRACT_GAP.

SCOPE
- vite.config.ts / VitePWA:
  - precache the full client build output (every JS chunk including all route chunks, CSS and fonts), not only public/
  - keep the copySWPlugin bridge to .vercel/output/static working, or replace it with an equivalent
- Navigation:
  - serve a precached app shell when the network fails
  - remove the 24h maxAgeSeconds expiry that makes offline loads fail a day after the last online visit
  - SSR stays the online path
- Remove the leftover TanStack template assets from public/ (tanstack-circle-logo.png, tanstack-word-logo-white.svg) if unused.
- Fix manifest icons: split "any maskable" into separate entries (needs a padded maskable icon).

CONSTRAINTS
- npm run build must succeed and produce sw.js in .vercel/output/static. Add a build-output test or script that asserts the precache manifest contains every file under .vercel/output/static/assets/*.js.
- tsc, lint and tests must be green. Mark Phase 5 done in spec §11. Update CLAUDE.md "PWA / Service Worker".

ACCEPTANCE
- The precache manifest includes all route chunks (asserted by the test).
- No runtime-cache entry for navigations has maxAgeSeconds ≤ 7 days.
- Manual check documented in the PR: load once, go offline, set the clock forward 2 days, reload. The app loads, unlocks, and every route opens.
```

---

## Run 6: Validation fixes (after Phases 1–5)

Findings from the 2026-10-10 validation of merged main (e116825). Issue 1 was reproduced in a real browser; issues 2–4 were confirmed by reading the code.

```text
Fix the four issues found when validating the free tier (docs/free-tier-spec.md, Phases 1–5 merged at e116825). The spec is the source of truth, and this run also corrects the spec where it caused the bug. Where it is silent, choose the simplest behaviour and record a CONTRACT_GAP.

CONTEXT
Verified on 2026-10-10. Typecheck, lint and all 1,177 tests pass, and the core flows work in a production build in headless Chromium. The remaining issues:

1. An idle tab locks the active tab (reproduced in the browser).
   With auto-lock set to 1 minute, tab A was used continuously (pointer and key events every 4 s) while tab B sat idle. After about 60 s both tabs were locked. A single active tab stayed unlocked (control run).
   Cause: src/routes/__root.tsx:110 calls `lockApp(queryClient)` on auto-lock, which broadcasts { type: 'lock' } by default (src/lib/vaultSession.ts lockApp), and every tab obeys it (connectOtherTabs).
   Root cause in the spec: §2.4 says locking broadcasts to other tabs, without separating manual lock from auto-lock.

2. "Restore from backup" is missing on the recovery screens.
   - The orphaned-data recovery state in src/components/PasswordUnlockDialog.tsx (mode 'recovery') only offers "Erase local data and start fresh".
   - src/components/DataProblemScreen.tsx offers Retry, Back up readable data, and Quarantine.
   - Spec §5.2 requires "Restore from backup" on both.
   - restoreBackup (src/lib/backup.ts ~line 659) also refuses getVaultState() === 'orphaned', so the dialog could not be wired up anyway.
   - From the Data problem screen, merge mode throws DecryptError (readLocal), so only replace can work there.

3. A recovery key can end up never saved.
   createVault and the v1 → v2 migration commit the vault and unlock it before the user ticks "I've saved my recovery key" and confirms. Closing the tab at the RecoveryKeySaveStep leaves a vault whose recovery key was never seen, and nothing ever prompts the user again. The key must never be stored, so it cannot be shown again either.

4. The recovery-key confirmation is too weak.
   RecoveryKeySaveStep checks the LAST group, which is only 2 characters in the 5-5-5-5-5-5-2 format. Spec §2.1 step 3 caused this.

SCOPE

1. Auto-lock is per tab
   - Auto-lock locks only its own tab: in __root.tsx call lockApp(queryClient, { broadcast: false }) from the auto-lock callback.
   - Manual lock (LockButton, Settings → Security "Lock now") still broadcasts.
   - A 'wiped' message still affects every tab.
   - Update spec §2.4: manual Lock locks all tabs; auto-lock locks only the idle tab.

2. Restore from backup when data can't be opened
   - backup.ts restoreBackup accepts state 'orphaned' as a target:
     - It behaves like a fresh-device restore: adopt the backup's vault header, force mode 'replace', and unlock with the backup's DEK.
     - First move every existing data blob, unchanged, to quarantine:<key>:<ISO timestamp>, inside the SAME setMany as the restored data and the header. Never delete an orphaned blob.
   - PasswordUnlockDialog 'recovery' mode:
     - add a "Restore from backup" button (data-testid="unlock-recovery-restore") that opens RestoreBackupDialog
     - on success, call onUnlocked({ isNewVault: false })
     - erase stays as the alternative
   - DataProblemScreen:
     - add "Restore from backup" (data-testid="data-problem-restore") that opens RestoreBackupDialog with mode fixed to 'replace' and no mode select
     - the copy explains that current data is replaced and the unreadable data is kept in quarantine
     - on success, reset queries and clear the data problem
   - RestoreBackupDialog gets a prop to force replace mode (used by both entry points above).

3. Unconfirmed recovery key
   - Add recoveryKeyConfirmed: boolean to meta:settings, merged like the other fields and not encrypted.
     - Set it to false atomically with every operation that produces a new recovery key: createVault, the v1 migration, and regenerateRecoveryKey. For createVault and regenerate, a separate locked write straight after the header write is acceptable. For the migration, include it in the existing setMany.
     - Set it to true only when RecoveryKeySaveStep is confirmed.
     - A missing field means confirmed, so vaults created before this change don't nag.
   - When unlocked and recoveryKeyConfirmed === false:
     - Dashboard: a persistent banner (data-testid="recovery-key-unconfirmed-banner") reading "You haven't saved a recovery key for this device", with the action "Create a new recovery key" that goes to /settings?tab=security.
     - Settings → Security: a warning on the "Generate new recovery key" card.
   - Generating a new key through the normal Security flow, with its confirmation step, clears the flag.
   - Never store the recovery key, or anything that reveals it.

4. A stronger confirmation step
   - RecoveryKeySaveStep asks for one full 5-character group, picked at random from groups 1–6 when the step mounts: "Type group N of your key". Never the 2-character tail.
   - Input ignores case and surrounding spaces.
   - Update spec §2.1 step 3.

5. Housekeeping
   - Fix the 8 ESLint warnings (no-shadow and require-await in test files).

CONSTRAINTS
- Do not change the meta:vault header format, the encryption, or the backup file format.
- No new runtime dependencies.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass.
- Update docs/free-tier-spec.md §2.1, §2.4, §5.2 and §11: add a row "6. Validation fixes ✅ Done (<run id>)". Update CLAUDE.md where it describes lock, restore and the recovery key.

ACCEPTANCE (each must be a test)
- With an injected fake sync channel, the auto-lock callback locks this tab and posts NO 'lock' message, while LockButton and "Lock now" each post { type: 'lock' }.
- Two simulated tabs sharing one channel, auto-lock 1 minute (fake timers): tab A has activity every 10 s and tab B none. After 61 s, B is locked and A is still unlocked.
- restoreBackup on an orphaned store:
  - restores every record from the backup
  - adopts the backup header and unlocks
  - moves every pre-existing data blob byte-identical to quarantine:*
  - a failure injected in setMany leaves the store byte-identical
- The PasswordUnlockDialog recovery state shows unlock-recovery-restore. A successful restore calls onUnlocked({ isNewVault: false }).
- DataProblemScreen shows data-problem-restore. The restore runs in replace mode and the unreadable blob ends up in quarantine unchanged.
- After createVault, meta:settings.recoveryKeyConfirmed === false. After the key step is confirmed it is true. The same holds for the v1 migration and regenerateRecoveryKey.
- With recoveryKeyConfirmed === false the dashboard shows recovery-key-unconfirmed-banner. With true or a missing field it does not.
- RecoveryKeySaveStep never asks for the 2-character tail. The requested group is 5 characters long. Typing the 2-character tail does not enable Continue, and typing the requested group in lower case does.

OUT OF SCOPE
Paid sync, account features, any change to backup/CSV formats or the service worker.
```
