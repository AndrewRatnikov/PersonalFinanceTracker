# Spec: MinimaSpend Free Tier

**Status:** Draft v1 · 2026-10-07
**Scope:** Everything a free user gets. Paid cloud sync is out of scope, but the decisions marked **[sync-ready]** are made so that sync can be added later without migrating user data again.

Supersedes the parts of `docs/prd.md` §4.1, §4.9 and `plans/backlog.md` §7–8 that describe auth, key derivation and sign-out.

---

## 1. Principles

1. **Local-only, no account.** The free tier runs with no account and makes no server calls for data. Sign-in exists only as the path to the paid tier.
2. **Data is never silently lost.** Every action that destroys data is explicit, named as destructive and offers a backup first. Unreadable data is never overwritten.
3. **Encrypted at rest, always.** Everything in IndexedDB and every backup file is encrypted. Plaintext leaves the device only in a CSV export the user explicitly asks for.
4. **A forgotten password is recoverable.** It's recoverable with the recovery key and only with the recovery key. There is no server-side reset.
5. **Works offline indefinitely** after the first successful load.

### Decisions taken (2026-10-07)

| Question | Decision |
|---|---|
| Must free users sign in? | **No.** Sign-in is optional and appears only for the paid tier. |
| What does sign-out / lock do to data? | **Lock keeps data.** A separate "Remove data from this device" action wipes it. |
| Forgotten password? | **Recovery key**, shown once at setup. |
| Full backup format? | **Encrypted `.minima` file.** CSV stays for spreadsheets only. |

---

## 2. User flows

### 2.1 First run (no vault on this device)

1. `/` shows the landing page. The primary CTA is **"Start tracking"**, and it requires no sign-in.
2. **Create password** screen: password + confirmation, minimum 8 characters, with a strength hint. The copy explains that the password encrypts data on this device and that MinimaSpend can't reset it.
3. **Save your recovery key** screen:
   - The key is shown as `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX` (Crockford base32, 160 bits).
   - Actions: **Copy**, **Download .txt**, **Print**.
   - The user must tick "I've saved my recovery key" before continuing.
   - Then they confirm by typing **one full 5-character group** of the key, picked at random from groups 1–6 when the screen opens ("Type group N of your key"). It is never the 2-character tail. Case and surrounding spaces are ignored. This catches keys that were never actually saved.
   - Until this step is confirmed, `meta:settings.recoveryKeyConfirmed` is `false` (§4.3). If the tab is closed at this step, the key is gone (it is never stored), so the Dashboard shows a persistent banner, "You haven't saved a recovery key for this device", with **"Create a new recovery key"** (Settings → Security), and the "Generate new recovery key" card shows a warning. Confirming a newly generated key clears both.
4. The vault is created and default categories are provisioned. The app calls `navigator.storage.persist()` (§6.1) and shows the dashboard.
5. **Install hint** (iOS Safari only, when not running standalone): a one-time card says "Add to Home Screen to keep your data safe". The reason is that Safari can clear site data for sites that aren't installed.

### 2.2 Returning user

| Device state | Screen |
|---|---|
| Vault exists and is locked | **Unlock**: a password field, plus **"Forgot password?"** |
| Vault exists and is unlocked (same tab, before auto-lock) | The app |
| v1 data exists (current production format) | **Unlock (legacy)**, then a one-time migration (§4.5) |
| Encrypted data exists but its key metadata is missing | **Recovery screen** (§5.2) |

The routes `/analytics`, `/transactions`, `/income` and `/settings` show the unlock gate when the app is locked. When no vault exists they redirect to `/`. They never redirect to `/login`.

### 2.3 Forgot password

1. On the unlock screen, tap **"Forgot password?"**, then enter the recovery key. Input ignores case, spaces and dashes.
2. If the key is valid, the user sets a **new password** and confirms it. The data encryption key (DEK) is re-wrapped. No data is re-encrypted.
3. The recovery key stays the same. A notice offers **"Generate a new recovery key"** in Settings if the user thinks the old one has been exposed.
4. If the recovery key is wrong: show "This recovery key doesn't match" and apply rate limiting UX (§4.4).
5. **Last resort**: a link at the bottom says *"I've lost both, erase this device and start over"*. It leads to the Remove flow (§2.5) and clearly states that all data will be lost.

### 2.4 Lock

- A **lock icon** in the header, plus Settings → Security → **"Lock now"**.
- Locking:
  1. Clears the in-memory key.
  2. Calls `queryClient.clear()` so no decrypted data stays in memory.
  3. A **manual** lock (header icon, "Lock now") broadcasts `lock`, so it locks **all tabs** (§5.4).
  4. Shows the unlock screen.
- **Auto-lock**:
  - Options: *Off / 1 / 5 / 15 (default) / 60 minutes*.
  - The timer counts inactivity: no pointer, key or visibility events.
  - When the tab is hidden, the time spent hidden counts as inactive time.
  - Auto-lock is **per tab**: it locks only the idle tab and broadcasts nothing, so an idle tab never locks a tab that is still in use.
- A `wiped` message (§2.5) still affects every tab.
- **Data is kept.** Locking never deletes anything.

### 2.5 Remove data from this device

- Location: Settings → Data → **Danger zone**.
- Steps:
  1. A dialog explains what will be deleted. The primary button is **"Download backup first"** (§7). The destructive button is **"Remove all data"**.
  2. To confirm, the user enters their password, or types `DELETE` if they came from the "lost both" path.
  3. The app deletes the IndexedDB database `minima-local` and every `minima_*` key in localStorage, broadcasts `wiped` to other tabs and returns to `/`.
- This is the **only** place that deletes everything locally.

### 2.6 Account (only shown for the paid tier, or for existing accounts)

- Behind the feature flag `ENABLE_ACCOUNTS`, which is off until paid sync ships.
- Existing production users who are already signed in still see Settings → **Account**:
  - **Sign out**: ends the Supabase session only. **Local data is untouched.**
  - **Delete account**: deletes the server account (the existing `delete_own_account` RPC). A separate, unticked-by-default checkbox reads "Also remove data from this device".
- No free-tier screen depends on `auth.user`.

---

## 3. Settings: final structure

| Tab | Contents |
|---|---|
| Categories | Unchanged |
| Budget | Unchanged |
| Security *(new)* | Change password · Generate new recovery key · Auto-lock timeout · Lock now |
| Data | Download backup (.minima) · Restore backup · Export CSV (.zip) · Import CSV · Storage status (§6.1) · Backup reminder frequency · Danger zone: Remove data from this device |
| Account | Only shown when `ENABLE_ACCOUNTS` is on or the user is signed in (§2.6) |

**Change password**: requires the current password, then the new password twice. It re-wraps the DEK under a new salt.

**Generate new recovery key**: requires the password. It shows the new key with the same save-and-confirm steps as §2.1. The old wrapped key is replaced, so the old recovery key stops working.

---

## 4. Encryption & key management (vault v2)

### 4.1 Key hierarchy [sync-ready]

```
password ──PBKDF2-SHA256 (600k, salt)──► KEK_pw ─┐
                                                 ├─ AES-GCM wrap ─► DEK (random 256-bit)
recovery key ──HKDF-SHA256 (salt)─────► KEK_rc ──┘                    │
                                                                      ▼
                                                  encrypts every record/chunk (AES-GCM, random 96-bit IV)
```

- The **DEK** is generated once per vault (`crypto.getRandomValues(32)`) and imported as a **non-extractable** `CryptoKey` for use. The raw bytes exist only during creation, wrapping and rewrapping, and are zeroed afterwards.
- Changing the password or recovery key **re-wraps the DEK only**. Data is never re-encrypted for a password change.
- The recovery key has 160 bits of entropy, so HKDF is enough (no stretching). The password gets PBKDF2 with **600,000** iterations (OWASP 2023), up from 200,000.
- [sync-ready] For paid sync, the same vault header uploads unchanged, and the same DEK opens the data on every device.

### 4.2 Vault header

Stored **in the same IndexedDB store as the data**, under the key `meta:vault`. It's no longer kept in localStorage, so header and data are always evicted or cleared together.

```ts
interface VaultHeaderV2 {
  v: 2
  vaultId: string              // random UUID, [sync-ready] identifies the vault across devices
  createdAt: string            // ISO
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string /* b64, 16 bytes */ }
  wrappedByPassword: { iv: string; ct: string }   // AES-GCM(KEK_pw, DEK)
  recovery: { salt: string; iv: string; ct: string } // AES-GCM(KEK_rc, DEK)
  verifier: { iv: string; ct: string }            // AES-GCM(DEK, "minima-verify-v2") — confirms the unwrap
}
```

- `iterations` is stored, not hardcoded, so it can be raised later by re-wrapping on unlock.
- A failed password unwrap gives "Incorrect password". A successful unwrap whose verifier fails decryption gives a "Vault damaged" error, which goes to §5.2.

### 4.3 Non-sensitive metadata

`meta:settings` holds plaintext, non-sensitive settings: `autoLockMinutes`, `backupReminderDays`, `lastBackupAt`, `lastDataChangeAt`, `installHintDismissed`, `persistRequestedAt`, `recoveryKeyConfirmed`.

- `recoveryKeyConfirmed` is set to `false` in the same transaction as every operation that produces a new recovery key (create vault, v1 migration, regenerate), and to `true` only when the save step (§2.1 step 3) is confirmed. A missing field means confirmed. Only this boolean is stored, never the key or anything derived from it. A restore that adopts a backup's vault (fresh or orphaned device) removes the field.

### 4.4 Brute-force UX

There's no server, so these limits are local and best-effort. They only slow down casual guessing; PBKDF2 is the real defence.

- After 5 failed attempts in a row, add a delay that doubles each time (5 s, 10 s, 20 s, … capped at 5 min). The counter is stored in `meta:settings` and resets on success.

### 4.5 Migration from v1 (current production format)

Detection: `localStorage['minima_key_verify_<userId>']` exists and there is no `meta:vault`.

1. The user enters their old password. The app derives the v1 key (PBKDF2 200k, the device salt from localStorage) and checks the v1 verifier.
2. Generate the DEK and the recovery key. Decrypt every v1 value in memory and re-encrypt it with the DEK.
3. Write all re-encrypted values **plus** `meta:vault` (and `recoveryKeyConfirmed: false` in `meta:settings`) in **one IndexedDB transaction** (`setMany`). If anything fails, the v1 data stays untouched and the user can retry.
4. Show the recovery key screen (§2.1 step 3).
5. Only then remove the v1 localStorage keys (`minima_device_salt_*`, `minima_key_verify_*`, `minima_offline_user`).

---

## 5. Data integrity

### 5.1 Write serialization (fixes lost updates)

- Every mutation in `localDb.ts` runs inside `withWriteLock(storageKey, fn)`:
  - It uses `navigator.locks.request('minima:' + storageKey, fn)` when available, which works across tabs.
  - Otherwise it falls back to an in-memory promise queue per key.
- Read-modify-write sequences (`addExpense`, `updateExpense`, `upsertBudget`, imports, …) hold the lock for the entire sequence.
- `updateExpense` moves records between month chunks, so it takes both chunk locks in sorted key order to avoid deadlock.
- **Acceptance:** 5 concurrent `addIncome` calls store 5 entries, and 2 concurrent `upsertBudget` calls for different categories store 2. Both currently fail (verified 2026-10-07: 1 and 1).

### 5.2 Undecryptable data is never overwritten

- `readStore` and `readChunk` throw `DecryptError` (already the case). Mutations must **not** catch it.
- **Global handling:** a React error boundary plus a React Query global `onError` turn `DecryptError` into a **Data problem** screen. That screen:
  - Names the affected collection or month, e.g. "Expenses · March 2026".
  - Offers **"Back up readable data"**: a `.minima` backup containing everything that still decrypts, with the unreadable keys listed in the file's `skipped` field.
  - Offers **"Quarantine and continue"**: moves the raw blob to `quarantine:<key>:<timestamp>` (never deletes it) so the rest of the app works.
  - Offers **"Restore from backup"**, in **replace** mode only (no mode choice; merge would need to read the unreadable data). The copy explains that the data on this device is replaced by the backup and the unreadable data is kept aside in quarantine, unchanged. Every unreadable blob is copied to `quarantine:<key>:<ISO timestamp>` in the same transaction as the restored data.
- **Orphaned data** (data keys exist, but neither `meta:vault` nor a v1 verifier does): show the recovery screen with **Restore from backup** or **"Erase local data and start fresh"** (typed `DELETE`). Never show "Create password" over existing data.
  - **Restore from backup** adopts the backup's vault, as on a fresh device (§7.3): the backup's header becomes `meta:vault`, the mode is forced to replace, and the app unlocks with the backup's key. Every existing data blob is first moved, unchanged, to `quarantine:<key>:<ISO timestamp>` in the **same transaction** as the restored data and the header. Orphaned blobs are never deleted. If the transaction fails, nothing changes.

### 5.3 Every view handles errors

- No query may render defaults (`= []`, zero totals) when it is in an error state.
- Dashboard, Analytics, Transactions, Income and Settings each show an inline error with **Retry**.
- Analytics must not spin forever. Today it checks `isLoading || !analytics` and never checks `isError`.

### 5.4 Multi-tab consistency

- A `BroadcastChannel('minima')` carries these events:
  - `changed:{keys}` after each committed write. Other tabs run `invalidateQueries` for the affected query keys.
  - `lock`: all tabs lock. Only a manual lock sends it; auto-lock is per tab and sends nothing (§2.4).
  - `wiped`: all tabs go to `/`.

### 5.5 Record metadata [sync-ready, cheap now]

- Every record (expense, income, category, budget) gains `updatedAt` (ISO), set on create and update.
- Deletes stay hard deletes in the free tier. The field is only added so that the later sync merge has the data it needs.
- Existing records get `updatedAt = createdAt` during migration (§4.5) or lazily when read.

---

## 6. Durability

### 6.1 Persistent storage

- Call `navigator.storage.persist()` after vault creation and again on unlock if `navigator.storage.persisted()` returns false. Record `persistRequestedAt`.
- Settings → Data → **Storage status** shows:
  - *Protected*: `persisted() === true`.
  - *Best-effort*: may be cleared by the browser under storage pressure. Show a hint ("Install the app" or "Bookmark it", depending on the browser).
  - Usage from `navigator.storage.estimate()`.

### 6.2 Backup reminders

- `lastDataChangeAt` is updated on every committed write. `lastBackupAt` is updated when a `.minima` download completes.
- **Dashboard banner** when all of these are true:
  - `lastDataChangeAt > lastBackupAt`
  - `now − lastBackupAt ≥ backupReminderDays` (default **14**; options 7 / 14 / 30 / off)
  - the vault has at least 10 records
- Banner text: *"Last backup: 23 days ago. [Back up now] [Later]"*. **Later** snoozes the banner for 3 days.
- The Remove flow (§2.5) and the Delete account flow always offer a backup first.

### 6.3 Offline

- **Precache the client build**: all JS, CSS and fonts from the build output, including every route chunk. After the first successful load, every route works offline, including routes never visited.
- **Navigation**: when offline, serve a precached app shell. Remove the 24-hour `maxAgeSeconds` on the `navigation` cache. Today the app stops loading offline 24 hours after its last online visit.
- With no auth gate (§2.2), the root route no longer calls `getServerUser()` on every navigation. That removes one network round trip per page change.

---

## 7. Backup & restore (`.minima`)

### 7.1 File format

```ts
interface MinimaBackupV1 {
  format: 'minima-backup'
  version: 1
  createdAt: string
  appVersion: string
  vault: Pick<VaultHeaderV2, 'vaultId' | 'kdf' | 'wrappedByPassword' | 'recovery' | 'verifier'>
  payload: { iv: string; ct: string }   // AES-GCM(DEK, gzip(JSON(BackupPayload)))
  skipped?: Array<string>               // storage keys that could not be decrypted (§5.2)
}

interface BackupPayload {
  schemaVersion: 1
  categories: Array<Category>
  expenses: Array<Expense>      // full records: id, ISO createdAt with time, updatedAt
  income: Array<IncomeEntry>
  budgets: Array<BudgetEntry>
  settings: { autoLockMinutes: number; backupReminderDays: number }
}
```

- The file is a single JSON file named `minima-backup-YYYY-MM-DD.minima`.
- **Unlock rule:** a backup opens with **the password that was current when it was made, or the recovery key**, unless the recovery key has since been regenerated. The restore UI states this.
- The backup is lossless: it keeps IDs, timestamps and time of day. CSV doesn't.
- Gzip via `CompressionStream` where available. The format records whether the payload is compressed (`payload.enc: 'gzip+aes-gcm' | 'aes-gcm'`).

### 7.2 Download

- On mobile, use `navigator.share({ files })` when supported, so the user can save straight to Files, iCloud or Drive. Otherwise use a single blob download. Revoke the object URL after a delay, not synchronously.
- `lastBackupAt` is set after the share or download call resolves.

### 7.3 Restore

1. Pick the file and validate `format` and `version`.
2. Ask for the password or recovery key **of the backup**, then unwrap its DEK and decrypt the payload.
3. Choose a mode:
   - **Replace**: the default when the local vault is empty. Local data is replaced by the backup.
   - **Merge**: upsert by `id`. The record with the newer `updatedAt` wins, and records only present locally are kept. Restoring the same file twice changes nothing.
4. Records are re-encrypted with the **local** DEK. Everything is written in **one transaction**.
5. Show a summary, e.g. "212 expenses, 14 income, 9 categories, 6 budgets restored (37 updated, 0 conflicts)".
- **Restore on a fresh device with no vault:** the landing page offers "Restore from backup". The backup's vault header becomes the local vault, and the user unlocks with the backup's password. They keep the same recovery key.
- **Restore on an orphaned device** (data but no vault header, §5.2): the recovery screen offers "Restore from backup". It works like a fresh-device restore (the backup's header is adopted, replace only), and every existing blob is moved unchanged to `quarantine:<key>:<ISO timestamp>` in the same transaction.
- **Restore from the Data problem screen** (§5.2): replace only; unreadable blobs move to quarantine in the same transaction.

---

## 8. CSV (spreadsheets, not backups)

- **Export:** a single `minima-csv-YYYY-MM-DD.zip` containing the four CSVs (use `fflate`, about 8 kB). This replaces four separate downloads. The UI labels CSV as *"Readable by spreadsheets · not encrypted · not a full backup"*.
- **Import:**
  - Quoted fields may contain newlines and commas. Parse with a proper state machine; don't split on `\n`.
  - Optionally detect the delimiter (`,` or `;`), because Excel in the uk-UA locale saves with `;`.
  - **Duplicate protection** for expenses and income: a row's fingerprint is `date|amount|currency|category-or-source|description`. If an existing record has the same fingerprint, skip the row and report "N rows looked like duplicates and were skipped". Offer **"Import them anyway"**.
  - The existing behaviour stays: categories import first, invalid rows are reported per row, and nothing defaults to "now".

---

## 9. Bugs to fix as part of this spec

| # | Issue | Fix |
|---|---|---|
| B1 | Budget vs. Actual compares a monthly limit with spend over any range (`localAnalytics.ts:102-115`) | `limitForRange = Σ over months touched (monthlyLimit × daysOfRangeInMonth / daysInMonth)` |
| B2 | Lost updates on concurrent writes | §5.1 |
| B3 | New password over existing data, then a stuck user | §2.2, §4.5, §5.2 |
| B4 | Re-importing a CSV duplicates rows | §8 |
| B5 | Errors render as zeros or an endless spinner | §5.3 |
| B6 | Offline breaks after 24 hours; unvisited routes don't work offline | §6.3 |

---

## 10. Out of scope (free tier)

- Cloud sync, multi-device sync, sharing, any server-side storage of user data (paid tier).
- Server-side password reset (impossible by design).
- Biometric unlock (WebAuthn PRF). Possible later and compatible with §4.1 as a third wrapping of the DEK.
- Analytics or telemetry on user data.

---

## 11. Implementation phases

Each phase can ship on its own.

| Phase | Contents | Mainly touches |
|---|---|---|
| **1. Safety net** ✅ Done (run_20261007_212533) | §5.1 write lock · §5.2 never-overwrite + Data problem screen · §5.3 error states · §5.4 multi-tab · B1 budget fix | `localDb.ts`, `localAnalytics.ts`, `__root.tsx`, routes |
| **2. Vault v2** ✅ Done (run_20261007_220444) | §4 key hierarchy · recovery key · change password · regenerate key · v1 migration · forgot-password flow · brute-force delay | `crypto.ts`, new `vault.ts`, `PasswordUnlockDialog` split into Create / Unlock / Recover screens |
| **3. No-account mode** ✅ Done (run_20261008_064656) | Remove the auth gate from `__root.tsx` · new first-run flow · Lock / Auto-lock · Remove data · Account section behind `ENABLE_ACCOUNTS` · §6.1 persist + install hint | `__root.tsx`, `Header`, `LandingPage`, `settings`, `SignOutDialog` → `LockButton` + `RemoveDataDialog` |
| **4. Backup** ✅ Done (run_20261008_080410) | §7 `.minima` backup and restore (replace and merge) · §6.2 reminders · §8 CSV zip, dedupe, parser | new `backup.ts`, `localImport.ts`, `localExport.ts`, `DataToolsTab` |
| **5. Offline hardening** ✅ Done (run_20261008_204753) | §6.3 precache all client assets, app-shell fallback | `vite.config.ts` |
| **6. Validation fixes** ✅ Done (run_20261010_092310) | per-tab auto-lock · restore on recovery screens · unconfirmed recovery key · group confirmation | `vaultSession.ts`, `backup.ts`, `vault.ts`, recovery screens |

## 12. Acceptance tests (minimum)

- **Concurrency:** 5 parallel `addIncome` store 5 entries. Two tabs adding expenses to the same month keep both.
- **Vault:**
  - Create → reload → unlock with the password works.
  - Unlock with the recovery key works and sets a new password.
  - After a password change, the old password fails, the new one works and the recovery key still works.
  - After regenerating the recovery key, the old key fails.
- **Migration:** a fixture v1 store (200k key, device salt) migrates and all records stay equal. A failure injected mid-migration leaves v1 intact.
- **Never overwrite:** a corrupted chunk followed by `addExpense` to that month throws, and the raw blob stays byte-identical. Quarantine moves it without changing it.
- **Orphaned data:** data keys with no header show the recovery screen and never the create-password screen.
- **Lock:** after locking, `queryClient` is empty and the key is null. Auto-lock fires after the timeout and locks only its own tab. A manual lock propagates to a second tab.
- **Remove:** the IndexedDB database and `minima_*` localStorage keys are gone, and a second tab returns to `/`.
- **Backup:**
  - Backup → remove → restore on an empty device gives identical records (ids, timestamps).
  - Merge-restoring the same file twice adds nothing.
  - A backup made before a password change opens with the old password and with the recovery key.
- **CSV:** importing the same file twice gives 0 inserted with N duplicates on the second run. A quoted multiline description round-trips.
- **Budget:** a 90-day range with 800/month spend against a 1,000/month limit is not over budget.
- **Offline:** load once, go offline, wait more than 24 hours (fake clock) and reload: the app loads and unlocks, and every route works.

## 13. Income categories

Income is grouped by its own category list, managed the way expense categories are. The two lists are separate: a name may exist in both.

- **Data model.** A new encrypted single key `incomeCategories` holds `Array<Category>` (`{ id, name, icon, updatedAt }`). It is a data key with the label "Income categories", so `hasLocalData`, migration, quarantine, backup and wipe cover it. `IncomeEntry` gains `categoryId`; the free-text `source` becomes optional and is only read, to convert legacy records and as a display fallback. New and updated records never write `source`.
- **Managing.** Settings → Categories has two sections, "Expense categories" and "Income categories", each with add / rename / icon / delete. Names are trimmed and unique ignoring case. Deleting an income category that income entries still use is refused ("N income entries use this category"). Every write runs under the write lock and is announced on the sync channel (`incomeCategories` → `['incomeCategories']`, `['income']`, `['analytics']`).
- **Defaults.** Salary 💼, Freelance 💻, Gifts 🎁, Investments 📈, Refunds ↩️, Other 🪙.
- **Conversion.** After every unlock, `ensureIncomeCategories()` runs once per vault: if `incomeCategories` already exists (even unreadable) it does nothing. Otherwise every distinct trimmed `source` of existing income becomes a category (ignoring case; the first spelling wins; no icon), the missing defaults are added, each entry without a `categoryId` gets the id of its source's category (an empty or missing source maps to "Other") and a new `updatedAt`. Entries that already have a category are untouched. Both keys are written in one IndexedDB transaction, so a failure writes nothing. A DecryptError on `income` goes to the Data problem screen and nothing is overwritten.
- **Backup.** The payload carries `incomeCategories` (additive; `schemaVersion` and the backup `version` stay 1). A backup made before this change (no `incomeCategories`, or income with only `source`) is converted on restore, keeping the backup records' `updatedAt`. Replace writes the list (adding the defaults for a payload without `incomeCategories`); merge upserts by id, the newer `updatedAt` wins, and reuses local income categories by name.
- **CSV.** `income.csv` keeps the header `date,source,amount,currency,description`; the `source` column holds the income category name. Import matches names ignoring case and creates unknown ones ("N new income categories created"). The duplicate fingerprint still uses the name. `categories.csv` stays expense-only.
- **Income page.** The add form selects a category (the first one by default; a link to Settings → Categories when there are none). The table and the dashboard's recent activity show the category icon and name, falling back to the legacy source, then "Uncategorized".
- **Analytics.** "Where your money comes from": a donut of income in the selected range and currency, grouped by income category and sorted by total, directly after the "By Category" spending donut. Income in other currencies is listed under "Not included". A range with income but no expenses shows the income donut instead of "No data found for this period". Budgets stay expense-only.

## 14. Recurring transactions

Subscriptions, rent, salary: a recurring item creates its expense or income when it is due, or asks first. Everything stays local and encrypted; there is no server and no push notification, so generation only runs while the app is open and unlocked.

- **Data model.** A new encrypted single key `recurring` holds `Array<RecurringItem>`: `{ id, kind ('expense' | 'income'), amount, currency, categoryId (an expense or income category, by kind), description, frequency: { unit: 'day' | 'week' | 'month' | 'year', interval >= 1 }, startDate (local YYYY-MM-DD), end: never | onDate (inclusive) | afterCount, mode ('auto' | 'ask'), paused, handledThrough, handledAhead, occurrenceCount, createdAt, updatedAt }`. It is a data key labelled "Recurring", so `hasLocalData`, quarantine, backup and wipe cover it. `Expense` and `IncomeEntry` gain optional `recurringId` and `occurrenceDate` (YYYY-MM-DD); generated records carry both, ordinary records have neither, and no migration is needed. Editing a generated expense keeps both fields.
- **Schedule rules** (pure, `src/lib/recurrence.ts`). Occurrence k is `startDate + k × interval` units, always computed from `startDate`, so the day never drifts: Jan 31 monthly gives Feb 28 (Feb 29 in leap years), Mar 31, Apr 30; Feb 29 yearly gives Feb 28 in non-leap years. `end.afterCount` counts every occurrence from `startDate`. All maths is date-only (UTC arithmetic on the date string), so timezones and DST changes can't shift a date. A generated record's `createdAt` is local 12:00 of the occurrence date and it goes into that month's chunk.
- **Generation.** `processDueRecurring(today)` creates, for every active (not paused) auto item, the occurrences after `handledThrough` up to today, then advances `handledThrough` and `occurrenceCount`. Each item is one read-modify-write under the write lock of `recurring` plus every target chunk (or `income`) and ONE `setMany`; the target keys are planned outside the lock, re-checked under it, and re-planned when an edit changed them. Idempotency key: `recurringId + occurrenceDate`. An occurrence whose target already holds a record with the same pair is not created again (it still counts as handled), so two tabs, a retry or a restored backup never duplicate a record. Missed occurrences (weeks offline) are all created, grouped by chunk. Any error, a DecryptError included, propagates and nothing of that item is written; unreadable data is never overwritten.
- **When it runs.** After every unlock (`prepareUnlockedVault`, after the income categories are ensured), when the tab becomes visible while unlocked, and when the local date changes while the app is open (checked every minute). When records were created, one toast says "Added N recurring transactions". A DecryptError goes to the Data problem screen.
- **Missing category (D2).** When an item's category no longer exists (e.g. after a restore or merge), generation writes nothing for that item and leaves it pending (`handledThrough` is not advanced). Its row shows "Category missing – edit to choose one"; after the user picks a category the missed occurrences are caught up.
- **Ask mode.** Due, unhandled occurrences of active ask items show in the dashboard's "Due" card. Add (`confirmRecurringOccurrence`, optional amount / description override for that record only) creates the record under the same atomic rules; Skip (`skipRecurringOccurrence`) creates nothing. Handling the oldest due date advances `handledThrough` past it and past any following dates already handled out of order (`handledAhead`); handling a later date first adds it to `handledAhead`.
- **Managing items.** `addRecurring(input, { createThroughToday })`: with the checkbox off, `handledThrough` becomes the last occurrence on or before today and nothing is created; on, an auto item creates those occurrences in the same transaction and an ask item leaves them due. Validation (zod): amount > 0, a currency from the list, a category of the item's kind, interval a whole number 1–365, a valid start date, an end date not before the start, afterCount >= 1. Edits apply only to future occurrences: `handledThrough`, `handledAhead` and `occurrenceCount` are kept and already created records are never changed. Deleting an item keeps the records it created as ordinary records. Deleting a category that a recurring item of its kind uses is refused ("Used by N recurring items").
- **Pause (D3).** A paused item generates nothing and is left out of the totals and Upcoming. Resuming skips the occurrences that fell inside the pause: `handledThrough` moves to the last occurrence before today, so today's occurrence onward is generated as normal.
- **Quick creation.** Quick Add and Add Income have a "Repeat" select (Don't repeat / Weekly / Monthly / Yearly). A repeat saves the record as usual (with `recurringId` and today's `occurrenceDate`) and an auto item starting today with `handledThrough = today`, in one transaction, so nothing is duplicated.
- **Backup.** The payload carries `recurring` (additive; `schemaVersion` and the backup `version` stay 1). Replace writes the list (`[]` for a backup without it); merge upserts by id and the newer `updatedAt` wins. Recurring changes are counted in the summary's added / updated / conflicts. A non-empty `recurring` makes merge the default restore mode. A restore never generates records; the next run does, and the idempotency key prevents duplicates.
- **UI.** `/recurring` (a data route; "Recurring" in the menu between Income and Settings): "Committed per month" with one total per kind and currency from the monthly equivalent (daily × 365 / 12, weekly × 52 / 12, monthly / interval, yearly / (12 × interval), 2 decimals; currencies are never mixed or converted; paused and ended items are left out), and one row per item (name or category, icon, amount, frequency text such as "Every month on the 31st", next date or "Ended", Auto/Ask and Paused badges, Edit / Pause–Resume / Delete with "Past transactions are kept."). The add/edit form offers kind, amount + currency, category, description, interval + unit, start date, end, mode ("Add automatically" / "Ask me first") and, when creating with a start on or before today, "Also add occurrences up to today" (checked by default when the start is today). The dashboard shows "Due" and "Upcoming" (next 7 days, up to 5 rows, link to `/recurring`) below the summary, and nothing when there are no recurring items. The transaction and income tables show a small Repeat icon on generated records.

## 15. Main currency

Every total is shown in one **main currency** (default UAH). Each expense and income entry keeps its typed amount and currency as the source of truth and also stores an unrounded conversion into the main currency, computed from the official National Bank of Ukraine (NBU) rate for the entry's local date.

- **Data model.** `Expense` / `IncomeEntry` gain `conversion?: { mainCurrency, rate, mainAmount, rateDate, source }` (`source` is the provider id `nbu`, `manual` or `identity`; `mainAmount = amount × rate`, never rounded) and `manualRate?: { mainCurrency, rate }`. An entry is **converted** only when `conversion.mainCurrency` equals the current main currency; anything else is **pending**. Totals use `mainAmountOf()`: the stored `mainAmount`, else the amount itself when the entry is already in the main currency, else nothing (pending entries are left out and counted, never mixed in). Rounding to 2 decimals happens only on display (`formatMoney`).
- **Settings.** `meta:settings` holds `mainCurrency` (one of `CURRENCIES`, default UAH) and `fetchExchangeRates` (default true), read by `getCurrencySettings()` (never throws; invalid values read as defaults). `updateCurrencySettings` only changes `fetchExchangeRates`; the main currency is written only together with the budget conversion. Settings → General (the first tab) has the main currency select, the "Fetch exchange rates from the National Bank of Ukraine" switch with "Only dates are sent, never amounts" and a status line ("All entries converted" / "N entries waiting for exchange rates").
- **Provider.** `src/lib/rates/` holds the `RateProvider` contract (`getRates(date) → { base, effectiveDate, perBase }`, `crossRate`) and the NBU implementation. `src/lib/rates/index.ts` is the single swap point (e.g. a server function if the browser can't reach NBU). The NBU request is `GET https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&date=YYYYMMDD` with `credentials: 'omit'` and no referrer, so only the date leaves the device. A day counts only when it has a rate for every currency in `CURRENCIES`; otherwise the provider steps back one day, at most 7 dates in total. Each request is retried on 429 / 5xx / network errors (3 tries, exponential backoff); at most 3 requests run at once. There is no persistent rates table: a conversion run fetches each date once and forgets it.
- **NBU findings (probed 2026-10-15).** Weekends and holidays return rates with `exchangedate` equal to the requested date; future and very old dates return `200 []` (hence the step-back); GET and the OPTIONS preflight send `access-control-allow-origin: *`; Cloudflare sets a `__cf_bm` cookie (not sent: credentials are omitted); no documented rate limit.
- **Saving and conversion.** Saving never touches the network: an entry in the main currency gets its identity conversion immediately, any other entry is stored pending. Editing the amount, currency or date clears the conversion (identity again in the main currency); a manual rate stays unless the currency changes. A background run (`convertPending`, coalesced per tab) converts pending entries chunk by chunk and writes back only `conversion` (never `updatedAt`) under the write lock; an entry edited meanwhile is skipped and converted by the next run. Identity and manual rates need no network. With rates off or offline, other entries stay pending. Runs start after every committed entry write in the tab, after unlock (after due recurring records are created), after a backup restore and when the browser comes back online. Budgets saved in another currency are converted once at today's rate when rates are available.
- **Changing the main currency.** A confirm dialog ("Recalculate N entries in X. Budgets will be converted at today's NBU rate.") runs the change: offline or rates off are refused when a rate is needed, as is a failed fetch of today's rates, and nothing is written then. Otherwise the budgets are converted at today's rate and the new main currency is stored in one transaction, then every entry is recalculated with progress shown. Entries without a rate stay pending.
- **Totals.** Dashboard, Analytics, budgets and recurring totals sum main-currency amounts. A note "N entries waiting for exchange rates" (with a link to Settings → General when rates are off) replaces the old per-currency "Not included" line; budgets in another currency are skipped and noted. The Analytics currency select is gone. Budgets are always edited in the main currency. Recurring "Committed per month" shows one ≈ total per kind at today's rate, falling back to per-currency lines with "Exchange rates unavailable".
- **Display.** Entries show `20.00 USD ≈ 830.40 UAH` (rate, source and rate date in the tooltip), the plain amount in the main currency, or `… · rate pending`.
- **Backup and CSV.** Backups carry `conversion` / `manualRate` on the raw records and `mainCurrency` / `fetchExchangeRates` in the settings (replace restores valid values, merge keeps the local ones; `version` and `schemaVersion` stay 1). A backup from before this change restores as pending and is converted by the next run. `expenses.csv` and `income.csv` gain trailing `main_amount` (unrounded, empty when pending) and `main_currency` columns, which import ignores.
- **Privacy.** The landing page says: "Exchange rates come from the National Bank of Ukraine; only dates are sent, never amounts."

## 16. Languages

The UI is in Ukrainian and English (English is the second language). Everything the user reads is translated: text, buttons, placeholders, accessible labels, toasts, validation and error messages, chart labels, the landing page (including its `<title>` and meta description) and the vault screens. Not translated: user data (category names, descriptions), CSV headers and file names, the backup format, console logs and the brand "MinimaSpend".

- **Choosing the language.** A stored choice wins; otherwise Ukrainian when any browser language starts with `uk`, otherwise English (Russian is never mapped to Ukrainian). The choice is stored only when the user switches: in localStorage `minima_lang` and a cookie `minima_lang` (path `/`, SameSite=Lax, one year, not HttpOnly). Switchers: Settings → General "Мова / Language", a UK | EN toggle in the landing header and on the create / unlock / recover screens, so the language can be chosen before unlock. Switching updates the UI and `<html lang>` at once, with no reload. The language is per device: it is not in the vault or in backups.
- **No flash.** The server renders the request's language (the cookie, then `Accept-Language`) with the matching `<html lang>`, and the client hydrates in the same language. The offline shell resolves the language on the client before first paint (the page stays hidden until then).
- **Formatting.** Amounts, dates and plurals follow the UI language, never the device locale: Ukrainian "1 234,50 грн", "20,00 USD", "14 жовт.", "жовтень 2026"; English "1,234.50 UAH", "Oct 14", "October 2026". Ukrainian writes the hryvnia as "грн" and keeps the other currency codes. Amount inputs accept both "," and "." in both languages. Machine formats (YYYY-MM-DD in storage, CSV, URLs, file names) never change.
- **Default categories.** A vault created in Ukrainian gets Їжа, Транспорт, Оренда, Кава, Розваги, Сервери and the income categories Зарплата, Фриланс, Подарунки, Інвестиції, Повернення, Інше. Existing categories are user data and are never renamed when the language changes; a legacy backup restored without income categories gets the English defaults.
- **Remove data** also clears the language cookie, so the language goes back to automatic detection.
