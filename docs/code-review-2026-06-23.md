# Code Review — 2026-06-23

Full-codebase max-effort review. 9 finder angles (A–E correctness + reuse/simplification/efficiency/altitude), 1 verifier pass, 1 gap sweep. 15 findings ranked by severity.

---

## 🔴 Critical

### 1. Every expense delete silently fails
**File:** `src/components/transactions/TransactionsTable.tsx:162`

`onDelete` prop is typed as `(id: string) => void` and called as `onDelete(tx.id)`. The handler in `transactions.tsx` is `handleDelete(id, createdAt)` — TypeScript allows the assignment (wider function ← narrower type) but at runtime `createdAt` arrives as `undefined`. `deleteExpense(id, undefined)` → `expenseChunkKey(undefined)` → `new Date(undefined)` → Invalid Date → key `expenses_NaN_NaN` → original chunk untouched → expense reappears on next render.

**Fix:** Change the prop type to `(id: string, createdAt: string) => void` and the call site to `onDelete(tx.id, tx.createdAt)`.

---

### 2. Open redirect after OAuth login
**File:** `src/routes/auth.callback.tsx:18`

`redirect_to` is taken verbatim from the query string and passed to `throw redirect({ to: redirectTo })` with no origin check.

**Fix:** Validate that `redirectTo` starts with `/` (relative path) before using it; fall back to `'/'` otherwise.

---

### 3. No try/catch in handleSignOut — broken state on error
**File:** `src/components/SignOutDialog.tsx:42`

`wipeLocalDbKey()` runs first (synchronous), then `clearLocalDb()` and `supabase.auth.signOut()` are awaited. If either throws, `_key` is already null and IDB is partially or fully wiped, but `navigate({ to: '/login' })` never fires — the user is stuck on the current page with no data and no recovery path.

**Fix:** Wrap the entire `handleSignOut` body in `try/catch`; on error, show a toast and consider restoring a safe state or at minimum navigating to `/login` in the `finally` block.

---

## 🟠 Data Loss / Data Integrity

### 4. `expenseChunkKey` silently writes to `expenses_NaN_NaN` on invalid date
**File:** `src/lib/localDb.ts:82`

`new Date(invalidString).getUTCFullYear()` returns `NaN`. The expense is encrypted and written to `expenses_NaN_NaN` which no range query ever covers — the write succeeds but the data is permanently unreadable.

**Fix:** Throw early if `new Date(dateStr)` produces an invalid date, or assert in `addExpense`/`importExpensesFromCSV` that `createdAt` is a valid ISO string before calling `expenseChunkKey`.

---

### 5. `deleteCategory` does not cascade to orphaned budget entries
**File:** `src/lib/localDb.ts:233`

`deleteCategory` checks expense chunks for references but not the budgets store. When a category with an active budget is deleted, the budget row persists in IDB with a dangling `categoryId`. `getAllBudgets` returns it with `categoryName: ''`, and `computeRangeAnalytics` includes it in `budgetVariance` with an empty name indefinitely.

**Fix:** After the expense-reference check, also read `'budgets'` and filter out any entry whose `categoryId` matches the deleted id before writing back.

---

### 6. `DataToolsTab` `Promise.all` hides partial import success on error
**File:** `src/components/settings/DataToolsTab.tsx:57`

Non-category files are imported with `Promise.all`. If one importer throws (e.g. `expenses.csv` throws "Import categories.csv first"), `Promise.all` rejects and the catch block sets `importError`, discarding results from files that already committed rows to IDB. The user sees only the error and re-uploads, duplicating data.

**Fix:** Replace `Promise.all` with a sequential or `allSettled`-based loop that collects both successes and per-file errors, always setting `importResults` regardless of individual failures.

---

### 7. `updateCategory` non-null assertion crashes when id is not found
**File:** `src/lib/localDb.ts:230`

```ts
return updated.find((c) => c.id === input.id)!
```

If `input.id` matches nothing (race condition, stale data), `.find()` returns `undefined`. The `!` suppresses the type error but the `undefined` propagates to the caller, which crashes on first property access with no user-visible message.

**Fix:** Throw a descriptive error (`'Category not found'`) instead of using the non-null assertion.

---

## 🟡 Import / UX Bugs

### 8. Imported date-only strings shift one day for UTC− timezone users
**File:** `src/lib/localImport.ts:66`

The export emits `createdAt.slice(0, 10)` — a `YYYY-MM-DD` string. On re-import, `new Date('2024-01-15')` parses as Jan 15 00:00 **UTC**. In a UTC−5 timezone that is Jan 14 19:00 local, so the expense is stored with a Jan 14 `createdAt`, lands in the wrong month chunk, and appears on the wrong day in analytics.

**Fix:** Parse as local midnight: `new Date(dateStr + 'T00:00:00')` (no `Z` suffix) instead of bare `new Date(dateStr)`.

---

### 9. `from`/`to` range is frozen at mount — new expenses invisible after midnight
**File:** `src/routes/index.tsx:41`

```ts
const [to] = useState(() => dayjs().endOf('day').toISOString())
```

`to` captures the end of the day the page was opened. An expense added after midnight has a `createdAt` beyond `to` and never appears in monthly stats or the recent list until the page is reloaded.

**Fix:** Derive `from`/`to` from `useMemo` keyed on the current date (e.g. `dayjs().format('YYYY-MM-DD')`), or invalidate the range when a new expense is added.

---

### 10. `categoryId: z.string()` accepts empty string
**File:** `src/lib/schemas.ts:15`

`createExpenseSchema` uses `z.string()` for `categoryId` without `.min(1)`. An empty string passes validation, is stored in IDB, and the expense renders with no category and cannot be grouped in analytics.

**Fix:** Change to `z.string().min(1, 'Category is required')`.

---

### 11. `BudgetRow` inputs go stale after a query refetch or import
**File:** `src/components/settings/BudgetTab.tsx:38`

`BudgetRow` initialises `limit` and `currency` state from the `existingBudget` prop via `useState`. `useState` ignores subsequent prop changes, so after a React Query refetch (e.g. triggered by an import) the inputs still show the old values. Clicking Save writes the stale value back, silently reverting the import.

**Fix:** Either add a `useEffect` that syncs local state when `existingBudget` changes, or remount the row by passing `key={existingBudget?.id ?? 'new'}`.

---

### 12. Income list has no sort — imported historical records appear last
**File:** `src/routes/income.tsx:29`

Income is displayed in IDB insertion order. After importing historical entries they appear below newer ones, inverting the expected newest-first order that the expenses list uses.

**Fix:** Sort the income array by `createdAt` descending before slicing for pagination, matching the `getAllExpenses` sort.

---

## 🔵 Security / Privacy

### 13. Expense month metadata is readable before password unlock
**File:** `src/lib/localDb.ts:129`

`allExpenseChunkKeys()` calls `keys(store)` with no `_key` guard. Any JS running in the page origin before the user enters their password can enumerate IDB keys like `['expenses_2024_01', 'expenses_2024_02']`, revealing which months the user recorded spending even though values remain encrypted.

**Fix:** Add `if (!_key || !store) return []` at the top of `allExpenseChunkKeys`, consistent with the other read helpers.

---

### 14. User email stored in plaintext localStorage
**File:** `src/routes/__root.tsx:44`

The offline auth fallback serialises `{ id, email }` into `localStorage` under `minima_offline_user`. The email is PII and is never needed for decryption or key lookup — only `userId` is used for the salt/verifier prefix.

**Fix:** Store only `{ id }` (drop `email`) in `minima_offline_user`; derive display name from Supabase session when online.

---

## ⚪ Dead Code

### 15. `localStore.ts` `categoriesProvisioned` flag is never written or read
**File:** `src/lib/localStore.ts:7`

The `categoriesProvisioned` key and the `localStore` module are defined but never imported anywhere. Any future code that reads this flag to skip re-provisioning will always find it `null` and re-provision, overwriting user-added categories with the six defaults.

**Fix:** Delete `localStore.ts`. The provisioning guard lives in `provisionDefaultCategories()` in `localDb.ts` (checks if the categories array is non-empty).

---

## Summary table

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | 🔴 Critical | `TransactionsTable.tsx:162` | Expense delete always no-ops — missing `createdAt` in `onDelete` |
| 2 | 🔴 Security | `auth.callback.tsx:18` | Open redirect via unvalidated `redirect_to` param |
| 3 | 🔴 Critical | `SignOutDialog.tsx:42` | No try/catch — broken state if sign-out throws |
| 4 | 🟠 Data loss | `localDb.ts:82` | Invalid date → `expenses_NaN_NaN` chunk, data permanently lost |
| 5 | 🟠 Integrity | `localDb.ts:233` | `deleteCategory` leaves orphaned budget entries |
| 6 | 🟠 Import | `DataToolsTab.tsx:57` | `Promise.all` discards partial success, causes data duplication on retry |
| 7 | 🟠 Crash | `localDb.ts:230` | `updateCategory` non-null assertion crashes on missing id |
| 8 | 🟡 Import | `localImport.ts:66` | `YYYY-MM-DD` parsed as UTC midnight, wrong day in UTC− timezones |
| 9 | 🟡 UX | `routes/index.tsx:41` | `from`/`to` stale after midnight — new expenses invisible |
| 10 | 🟡 Validation | `schemas.ts:15` | `categoryId` allows empty string |
| 11 | 🟡 UX | `BudgetTab.tsx:38` | `BudgetRow` state never syncs to updated prop |
| 12 | 🟡 UX | `routes/income.tsx:29` | Income list unsorted — imports appear in wrong order |
| 13 | 🔵 Privacy | `localDb.ts:129` | Chunk key names readable before unlock |
| 14 | 🔵 Privacy | `__root.tsx:44` | User email in plaintext localStorage |
| 15 | ⚪ Dead code | `localStore.ts:7` | `categoriesProvisioned` flag never written or read |
