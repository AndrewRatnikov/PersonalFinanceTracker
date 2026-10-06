# Code Review — 2026-10-05

Full-codebase review of `main` at `beca21e`. Every finding below was checked against the current code. `tsc --noEmit` is clean and `vitest run` passes (88 tests), so these are logic and behaviour problems, not type or test failures.

All 15 findings from `code-review-2026-06-23.md` are fixed in the current code (e.g. `TransactionsTable.tsx:214` now passes `tx.createdAt`; `localDb.ts:84` rejects invalid dates; `deleteCategory` cascades to budgets; `categoryId` has `.min(1)`). Two earlier fixes were checked for being incomplete: the `redirect_to` guard in `auth.callback.tsx:11` accepts `//host`, but the router normalises that to `/host` (verified with `buildLocation`), so it is not an open redirect. A bug remains in the login side of the same flow, see #8.

16 findings ranked by severity.

---

## 🟠 Data Loss / Data Integrity

### 1. Decryption failures are swallowed and then overwritten

**Status:** Fixed in run_20261005_215952

**Files:** `src/lib/localDb.ts:57-68`, `src/lib/localDb.ts:111-120`, `src/lib/localDb.ts:340-349`, `src/components/PasswordUnlockDialog.tsx:26`

`readStore` and `readChunk` catch every decrypt error and return `undefined` / `[]`. Every mutation is read-modify-write on top of that (`addExpense` → `writeChunk(chunkKey, [...existing, entry])`, `addCategory`, `addIncome`, `upsertBudget`, …), so a chunk that cannot be decrypted is silently replaced by one containing only the new record.

The state is reachable: `isNewUser` is derived solely from `localStorage['minima_key_verify_<id>']`. If that key is missing while IndexedDB still holds data (partial site-data eviction, devtools, a storage-clearing extension), the dialog offers "Create encryption password", derives a new key, and `handleUnlocked(key, true)` calls `provisionDefaultCategories()`. That sees `readStore('categories')` as `[]` (decrypt failed) and overwrites the encrypted categories with six defaults. Every expense chunk is then undecryptable, and the next `addExpense` into any month overwrites that month.

**Fix:** Distinguish "key absent" (return empty) from "decrypt failed" (throw a typed error) in `readStore` / `readChunk`, and let mutations abort on it. In `PasswordUnlockDialog`, treat "no verifier but IDB has `expenses_*`/`categories` keys" as a recovery state (prompt for the old password or an explicit "erase local data") instead of a new user.

---

### 2. Analytics add amounts across currencies and label them all UAH

**Status:** Fixed in run_20261005_215952

**Files:** `src/lib/localAnalytics.ts:31-47`, `:69-71`, `:73-84`; `src/routes/analytics.tsx:36-50`, `:127`, `:131`; `src/components/index/DashboardStats.tsx:39`, `:79`; `src/components/analytics/CategoryDonutChart.tsx:107`; `TimelineBarChart.tsx:105`; `BudgetVarianceBarChart.tsx:100`

The dashboard summary (`dashboardSummary.ts`) correctly filters to a base currency and reports the rest as "Not included". The analytics page does not: `computeRangeAnalytics` sums `e.amount` for every currency into `categoryBreakdown`, `timeline` and `totalIncome`; `budgetVariance` compares that mixed total to `b.monthlyLimit` regardless of the budget's currency; and `computeMonthlyStats` sums all currencies per month. The UI then prints the result with a hardcoded `UAH` / `₴`.

A user with 100 USD + 1000 UAH of food sees "1,100 UAH" and a budget bar that is wrong by roughly 40×. A USD budget of 200 compared against UAH spend shows "under budget" when it is not.

**Fix:** Filter expenses/income/budgets to a single selected currency (default UAH, matching the dashboard) in `computeRangeAnalytics` and `computeMonthlyStats`, surface the other currencies as "not included" like the dashboard, and take the label from that currency instead of hardcoding `UAH`.

---

### 3. Export → import shifts dates by one day

**Status:** Fixed in run_20261005_215952

**Files:** `src/lib/localExport.ts:30`, `:42`; `src/lib/localImport.ts:67-75`

Export writes `createdAt.slice(0, 10)`, which is the **UTC** calendar date of the ISO string. Import (after the fix for the earlier #8) parses `YYYY-MM-DD` as **local** midnight. The two disagree whenever local date ≠ UTC date. Verified with `TZ=Europe/Kyiv`: an expense at 2024-01-15 01:00 local exports as `2024-01-14` and re-imports as Jan 14. For UTC− users the shift goes forward for evening entries. Around month boundaries the record lands in a different month, so monthly totals and budget variance change after a restore.

**Fix:** Export the local date (`dayjs(e.createdAt).format('YYYY-MM-DD')`) so it round-trips with the local-midnight import.

---

### 4. Account deletion can leave the user in a half-deleted state

**Status:** Fixed in run_20261005_215952

**File:** `src/components/settings/DeleteAccountDialog.tsx:36-52`

`deleteCurrentUserAccount()` (the server-side delete) runs first, then `clearLocalDb()` and `supabase.auth.signOut()` inside the same `try`. If either later step throws (IDB blocked by another tab, network failure on `signOut`), the catch reports "Account deletion failed" and does not navigate, even though the account no longer exists; the user keeps a live local session and retrying the delete will fail. Separately, `AlertDialogAction` closes the dialog on click, so the in-dialog "Deleting…" label and `delete-account-error` text are never seen; only the toast is.

**Fix:** After a successful server delete, treat the remaining cleanup as best-effort (own `try/catch`, always `navigate({ to: '/login' })` in `finally`) and show a success toast. `preventDefault()` in the action handler if the in-dialog progress/error is meant to be visible.

---

## 🟡 UX / Behaviour Bugs

### 5. Deleting the last row on the last page leaves an empty, un-navigable page

**Status:** Fixed in run_20261005_215952

**Files:** `src/routes/transactions.tsx:25`, `:36-43`, `:139`; `src/routes/income.tsx:18`, `:38`, `:84`

`pageIndex` is never clamped. With 16 transactions on page 2, deleting the single row there leaves `pageIndex = 1` with zero rows: the table shows "No transactions found" and the pagination is hidden because it is only rendered when `transactions.length > 0`. The user has to reload or change the category filter to get back. Same on the Income page.

**Fix:** Clamp the index (`Math.min(pageIndex, Math.max(totalPages - 1, 0))`) when computing the slice, or render pagination whenever `totalPages > 1`.

---

### 6. Timeline buckets days by UTC date, not local date

**Status:** Fixed in run_20261005_215952

**File:** `src/lib/localAnalytics.ts:48-53`

The range is built from local day boundaries (`normalizeRange`), but each expense is bucketed with `dateObj.toISOString().split('T')[0]`, i.e. the UTC date, and the label comes from `dayjs(key)`. For a user in UTC+2/+3, anything entered between 00:00 and 02:00/03:00 local is drawn on the previous day; for UTC− users, late-evening entries move to the next day (and may fall outside the selected range's last day bar).

**Fix:** Use `dateObj.format('YYYY-MM-DD')` (local) for the key.

---

### 7. Quick Add clears the form before the save succeeds and leaks a rejection

**Status:** Fixed in run_20261005_215952

**Files:** `src/components/index/SpeedEntryForm.tsx:56-59`, `src/routes/index.tsx:96-104`

`SpeedEntryForm` calls `onSubmit(result.data)` and immediately resets amount/description, without awaiting. `handleCreateExpense` uses `mutateAsync` in a `try/finally` with no `catch`, and the form's `onSubmit` is typed `void`, so a failed write (e.g. the IDB write throws) produces an unhandled promise rejection in addition to the error toast. The user has already lost what they typed.

**Fix:** Make `onSubmit` return a `Promise`, reset the fields only after it resolves, and `catch` in `handleCreateExpense` (or use `mutate`, since `onError` already toasts).

---

### 8. Login `redirect_to` is not URL-encoded, so query strings are truncated

**Status:** Fixed in run_20261005_215952

**File:** `src/routes/login.tsx:37`

`redirectTo: \`${origin}/auth/callback?redirect_to=${fallback}\``interpolates`search.redirect`(which`__root.tsx:71`sets to`location.href`, query included) without `encodeURIComponent`. For `/analytics?from=2024-01-01&to=2024-03-31`, everything after the first `&`becomes a separate parameter of the callback URL, and`auth.callback.tsx`only reads`redirect_to`, so the user lands on `/analytics?from=2024-01-01` with the end date dropped.

**Fix:** `redirect_to=${encodeURIComponent(fallback)}`.

---

### 9. Delete-category dialog promises the opposite of what happens

**Status:** Fixed in run_20261005_215952

**Files:** `src/components/settings/CategoryRow.tsx:143`, `src/lib/localDb.ts:308-316`

The confirmation says "Expenses in this category will become uncategorized", but `deleteCategory` throws `"N expenses use this category"` and deletes nothing when any expense references it. The user confirms, then gets an error banner at the top of the page.

**Fix:** Change the dialog copy to say a category in use cannot be deleted (ideally disable the action and show the count up front), or implement the reassign/uncategorize behaviour the text describes.

---

### 10. Category names are not trimmed or de-duplicated outside CSV import

**Status:** Fixed in run_20261005_215952

**Files:** `src/lib/localDb.ts:280-306`, `src/components/settings/CategoriesTab.tsx:43`, `src/lib/localImport.ts:116-118`, `:215-217`

`CategoriesTab` only checks `newName.trim()` for the button state, then saves the untrimmed string; `addCategory` / `updateCategory` accept duplicates ("Food" and "food"). `importCategoriesFromCSV` dedupes case-insensitively, but `importExpensesFromCSV` / `importBudgetsFromCSV` build `new Map(name.toLowerCase() → id)`, so with duplicates the later category silently wins and rows are attributed to the wrong one. A trailing-space name also never matches a re-imported (CSV-trimmed) name.

**Fix:** Trim in `CategoriesTab`/`CategoryRow` (or in `addCategory`/`updateCategory`) and reject case-insensitive duplicates there.

---

### 11. CSV import replaces a bad or missing date with "now"

**Status:** Fixed in run_20261005_215952

**File:** `src/lib/localImport.ts:67-75`

`parseDate` returns `new Date().toISOString()` for an empty or unparsable date. The row is counted as `inserted` with no entry in `errors`, so a typo like `2024-13-45` or a different date format (`15/01/2024`) imports hundreds of rows dated today, inflating this month's totals and budgets with no warning.

**Fix:** Make `parseDate` return `null` for invalid input and record a `Row N: invalid date` error / skip, as is already done for amount and currency.

---

## 🔵 Auth / Privacy

### 12. Stale offline identity is never cleared, and a corrupt cache throws

**Status:** Fixed in run_20261005_215952

**File:** `src/routes/__root.tsx:43-52`

`minima_offline_user` is written when `getServerUser()` returns a user but is not removed when it returns `null` (session expired or revoked). A later request that fails (offline, server error) takes the `catch` branch, reads the old cache and treats the user as signed in, so the unlock dialog and data pages are reachable for a session the server has already ended. `JSON.parse(raw)` there is also unguarded: a corrupt value throws from inside the `catch`, surfacing as a route error instead of a login redirect.

**Fix:** Remove `OFFLINE_USER_KEY` when `getServerUser()` resolves to `null`; wrap the `JSON.parse` in `try/catch` and fall through to the "no cache" branch.

---

### 13. Sign-out / delete leave the per-user key material behind

**Status:** Fixed in run_20261005_215952

**Files:** `src/components/SignOutDialog.tsx:44-50`, `src/components/settings/DeleteAccountDialog.tsx:42-49`

Both flows wipe IndexedDB but keep `minima_device_salt_<id>` and `minima_key_verify_<id>` in `localStorage`. After "Sign out & delete data" the next login on that device still demands the old password and cannot "start fresh", and after account deletion the verifier of a deleted account is retained. Per-user crypto metadata should be removed together with the data it protects.

**Fix:** Also `removeItem` both keys in `handleSignOut` and `handleDelete`.

---

---

## ⚪ Dead Code

### 14. Legacy Supabase data layer is unreachable

**Status:** Fixed in run_20261005_215952

**Files:** `src/lib/database.ts`, `src/lib/categories.ts`, `src/lib/expenses.ts`, `src/lib/income.ts`, `src/lib/budgets.ts`, `src/lib/analytics.ts`, `src/lib/csvTools.ts`, `src/lib/serverClient.ts`, `src/lib/transactions/` (`index.ts`, `getTransactionsPaginated.ts`, `deleteExpense.ts`, `updateExpense.ts`)

No source file imports `database.ts`, `income.ts`, `budgets.ts`, `csvTools.ts` or `lib/transactions/*`. `categories.ts`, `expenses.ts` and `analytics.ts` are imported only by `database.ts`, and `serverClient.ts` only by those legacy modules. (`AnalyticsFilters.tsx` imports `analyticsUtils` and the _route_ `routes/analytics`, not `lib/analytics.ts`.) All routes use `localDb.ts`. These files still ship server functions (`createServerFn`) that read and write Supabase tables, so they are attack surface and bundle weight with no callers.

**Fix:** Delete them (CLAUDE.md already marks them as legacy; `offlineCache.ts` and `localStore.ts` are already gone). `analyticsUtils.ts` stays.

---

### 15. `RecentHistoryList` component is unused

**Status:** Fixed in run_20261005_215952

**File:** `src/components/index/RecentHistoryList.tsx`

Not imported by any route, component or test; the dashboard uses `RecentActivityList`.

**Fix:** Delete the file.

---

### 16. Cleanup of a localStorage key that nothing writes

**Status:** Fixed in run_20261005_215952

**Files:** `src/components/SignOutDialog.tsx:47`, `src/components/settings/DeleteAccountDialog.tsx:45`

Both remove `minima_migrated_<userId>`. Nothing in `src/` ever sets it (the Supabase→IDB migration that used it is gone).

**Fix:** Remove the two `removeItem` calls.

---

## Summary table

| #   | Severity      | File                                                 | Issue                                                                                |
| --- | ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | 🟠 Data loss  | `localDb.ts:57-120`, `PasswordUnlockDialog:26`       | Decrypt errors swallowed → next write overwrites unreadable data                     |
| 2   | 🟠 Wrong data | `localAnalytics.ts:31-84`, `analytics.tsx`           | Analytics sum UAH+USD+EUR and label everything UAH; budget variance ignores currency |
| 3   | 🟠 Integrity  | `localExport.ts:30`, `localImport.ts:67`             | Export uses UTC date, import local → dates shift a day on restore                    |
| 4   | 🟠 Integrity  | `DeleteAccountDialog.tsx:36-52`                      | Failure after server-side delete leaves a live session on a deleted account          |
| 5   | 🟡 UX         | `transactions.tsx:25,139`, `income.tsx:18,84`        | Page index not clamped; deleting last row strands user on an empty page              |
| 6   | 🟡 Wrong data | `localAnalytics.ts:48`                               | Timeline buckets by UTC date; entries land on wrong day                              |
| 7   | 🟡 UX         | `SpeedEntryForm.tsx:56`, `index.tsx:96`              | Form cleared before save resolves; failed save → lost input + unhandled rejection    |
| 8   | 🟡 UX         | `login.tsx:37`                                       | `redirect_to` not encoded; query string truncated at first `&`                       |
| 9   | 🟡 UX         | `CategoryRow.tsx:143`                                | Dialog says expenses become uncategorized; delete actually fails                     |
| 10  | 🟡 Integrity  | `localDb.ts:280`, `CategoriesTab.tsx:43`             | Untrimmed/duplicate category names; CSV import maps to wrong category                |
| 11  | 🟡 Import     | `localImport.ts:67`                                  | Invalid/missing date silently becomes "now", counted as inserted                     |
| 12  | 🔵 Auth       | `__root.tsx:43-52`                                   | Stale `minima_offline_user` accepted after session ends; corrupt cache throws        |
| 13  | 🔵 Privacy    | `SignOutDialog.tsx:44`, `DeleteAccountDialog.tsx:42` | Device salt and key verifier survive sign-out / account deletion                     |
| 14  | ⚪ Dead code  | `src/lib/*` (Supabase layer), `lib/transactions/`    | Unreachable legacy server functions with no importers                                |
| 15  | ⚪ Dead code  | `RecentHistoryList.tsx`                              | Component never imported                                                             |
| 16  | ⚪ Dead code  | `SignOutDialog.tsx:47`, `DeleteAccountDialog.tsx:45` | Removes `minima_migrated_*` key that is never written                                |
