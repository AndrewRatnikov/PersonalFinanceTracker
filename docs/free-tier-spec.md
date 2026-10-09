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
   - Then they confirm by typing the **last group** of the key. This catches keys that were never actually saved.
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
  3. Broadcasts `lock` to other tabs (§5.4).
  4. Shows the unlock screen.
- **Auto-lock**:
  - Options: *Off / 1 / 5 / 15 (default) / 60 minutes*.
  - The timer counts inactivity: no pointer, key or visibility events.
  - When the tab is hidden, the time spent hidden counts as inactive time.
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

`meta:settings` holds plaintext, non-sensitive settings: `autoLockMinutes`, `backupReminderDays`, `lastBackupAt`, `lastDataChangeAt`, `installHintDismissed`, `persistRequestedAt`.

### 4.4 Brute-force UX

There's no server, so these limits are local and best-effort. They only slow down casual guessing; PBKDF2 is the real defence.

- After 5 failed attempts in a row, add a delay that doubles each time (5 s, 10 s, 20 s, … capped at 5 min). The counter is stored in `meta:settings` and resets on success.

### 4.5 Migration from v1 (current production format)

Detection: `localStorage['minima_key_verify_<userId>']` exists and there is no `meta:vault`.

1. The user enters their old password. The app derives the v1 key (PBKDF2 200k, the device salt from localStorage) and checks the v1 verifier.
2. Generate the DEK and the recovery key. Decrypt every v1 value in memory and re-encrypt it with the DEK.
3. Write all re-encrypted values **plus** `meta:vault` in **one IndexedDB transaction** (`setMany`). If anything fails, the v1 data stays untouched and the user can retry.
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
  - Offers **"Restore from backup"**.
- **Orphaned data** (data keys exist, but neither `meta:vault` nor a v1 verifier does): show the recovery screen with **Restore from backup** or **Remove data from this device**. Never show "Create password" over existing data.

### 5.3 Every view handles errors

- No query may render defaults (`= []`, zero totals) when it is in an error state.
- Dashboard, Analytics, Transactions, Income and Settings each show an inline error with **Retry**.
- Analytics must not spin forever. Today it checks `isLoading || !analytics` and never checks `isError`.

### 5.4 Multi-tab consistency

- A `BroadcastChannel('minima')` carries these events:
  - `changed:{keys}` after each committed write. Other tabs run `invalidateQueries` for the affected query keys.
  - `lock`: all tabs lock.
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
- **Lock:** after locking, `queryClient` is empty and the key is null. Auto-lock fires after the timeout. Lock propagates to a second tab.
- **Remove:** the IndexedDB database and `minima_*` localStorage keys are gone, and a second tab returns to `/`.
- **Backup:**
  - Backup → remove → restore on an empty device gives identical records (ids, timestamps).
  - Merge-restoring the same file twice adds nothing.
  - A backup made before a password change opens with the old password and with the recovery key.
- **CSV:** importing the same file twice gives 0 inserted with N duplicates on the second run. A quoted multiline description round-trips.
- **Budget:** a 90-day range with 800/month spend against a 1,000/month limit is not over budget.
- **Offline:** load once, go offline, wait more than 24 hours (fake clock) and reload: the app loads and unlocks, and every route works.
