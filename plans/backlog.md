# Backlog

Items ranked by urgency. Each block is self-contained — implement top to bottom.

---

## 1. Form validation + toast notifications ✅
_Unvalidated inputs currently reach the DB or throw unhandled errors._

- [x] Install `zod` and confirm `sonner` in `package.json`
- [x] Add `<Toaster />` to `src/routes/__root.tsx`
- [x] Define Zod schema for expense creation in `src/lib/schemas.ts`
- [x] Apply schema in `SpeedEntryForm` — show inline field errors
- [x] Fire `toast.success` on expense create in `src/routes/index.tsx`
- [x] Fire `toast.error` on server function throw in `src/routes/index.tsx`
- [x] Transactions delete already had toasts — no change needed
- [ ] Apply schema in the transaction edit form (blocked — edit UI not built yet)

---

## 2. Default category provisioning on first login ✅
_New users land with no categories, which breaks expense entry immediately._

- [x] Add `provisionDefaultCategories` server function in `src/lib/categories.ts`
  - Checks whether the user already has any categories
  - If none, bulk-inserts: Food 🍔, Transport 🚌, Rent 🏠, Coffee ☕, Entertainment 🎬, Server Costs 🖥️
- [x] Call it inside `beforeLoad` of `src/routes/__root.tsx` after `getServerUser` resolves (only when user is present)

---

## 3. Income tracking
_No income table, route, form, or analytics integration exists yet._

### 3.1 Database ✅
- [x] Run migration in Supabase SQL Editor:
  ```sql
  create table public.income (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    source text not null,
    amount numeric not null,
    currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
    description text,
    created_at timestamptz not null default now()
  );
  alter table public.income enable row level security;
  create policy "Users can view their own income" on public.income for select using (auth.uid() = user_id);
  create policy "Users can insert their own income" on public.income for insert with check (auth.uid() = user_id);
  create policy "Users can update their own income" on public.income for update using (auth.uid() = user_id);
  create policy "Users can delete their own income" on public.income for delete using (auth.uid() = user_id);
  ```
- [x] Add `income` table schema to `docs/db.md`

### 3.2 Domain & validation ✅
- [x] Add `IncomeEntry` and `CreateIncomeInput` types to `src/lib/domain.ts`
  - `IncomeEntry`: `id`, `source`, `amount`, `currency`, `description`, `createdAt`
  - `CreateIncomeInput`: `source`, `amount`, `currency`, `description?`
- [x] Add `createIncomeSchema` to `src/lib/schemas.ts` (amount positive; source min 1 char)

### 3.3 Server functions — `src/lib/income.ts` (new file)
- [ ] `getIncomePaginated({ pageIndex, pageSize })` — mirrors `getTransactionsPaginated`; returns `{ income, totalCount }`
- [ ] `createIncome({ data })` — validates with `inputValidator`, inserts row, returns `IncomeEntry`
- [ ] `deleteIncome({ data: id })` — deletes by id scoped to `user_id`
- [ ] `getIncomeTotalForRange({ from, to })` — returns a single `number`; used by analytics

### 3.4 Route — `src/routes/income.tsx` (new file)
- [ ] Mirror the structure of `src/routes/transactions.tsx`:
  - TanStack Query for paginated fetch (`useQuery` with `['income', queryInput]` key)
  - Delete mutation with `toast.success` / `toast.error`
- [ ] "Add Income" form inline at the top of the page (no separate route needed):
  - Fields: Amount + Currency (same combined input as `SpeedEntryForm`), Source (text input, required), Description (optional)
  - Validate with `createIncomeSchema` — show inline errors, same pattern as `SpeedEntryForm`
  - On success: invalidate query + `toast.success('Income saved')`
- [ ] Income history table below the form:
  - Columns: Date, Source, Description, Amount
  - Pagination controls (reuse `TransactionsPagination`)
  - Delete button per row with `AlertDialog` confirmation (reuse pattern from `TransactionsTable`)

### 3.5 Navigation
- [ ] Add `{ to: '/income', icon: TrendingUp, label: 'Income' }` to `NAV_LINKS` in `src/components/Header.tsx` — insert between Transactions and Settings

### 3.6 Analytics integration
- [ ] Extend `getRangeAnalytics` in `src/lib/analytics.ts` to also call `getIncomeTotalForRange` and include `totalIncome: number` in `AnalyticsRangeSummary`
- [ ] Add `totalIncome` field to `AnalyticsRangeSummary` in `src/lib/domain.ts`
- [ ] Show "Total Income" stat card on the Analytics page alongside the existing "Total Spent" card

---

## 4. Budget system
_No budget table, limit-setting UI, or budget vs. actual chart._

- [ ] Run `budgets` table migration in Supabase (see `docs/db.md` for schema)
- [ ] Add RLS policies
- [ ] Add `src/lib/budgets.ts` with `getBudgets`, `upsertBudget` server functions
- [ ] Add `BudgetEntry` type to `src/lib/domain.ts`
- [ ] Add "Budget" tab to `src/routes/settings.tsx` — list categories with editable monthly limit inputs
- [ ] Add `getBudgetsForRange` server function that merges budget limits with actual spend per category
- [ ] Build `BudgetVarianceBarChart` component (side-by-side Budget vs. Actual bars; over-budget bars in red)
- [ ] Mount chart on the Analytics page beneath the existing charts

---

## 5. PWA setup
_App is not installable and has no offline shell._

- [ ] Install `vite-plugin-pwa`
- [ ] Add plugin to `vite.config.ts` with `registerType: 'autoUpdate'`
- [ ] Create `public/manifest.json` (name, short_name, icons, theme_color, display: standalone)
- [ ] Add 192×192 and 512×512 app icons to `public/`
- [ ] Verify install prompt works on mobile Chrome

---

## 6. Workbox offline cache
_Depends on #5._

- [ ] Configure Workbox in `vite.config.ts`: cache-first for shell assets, network-first for API calls
- [ ] Cache the last-fetched expenses and categories in IndexedDB via a Workbox plugin or manual strategy
- [ ] Show a "Viewing cached data" banner when the app detects it is offline

---

## 7. Encrypted local state
_Depends on #6 — nothing to encrypt until offline cache exists._

- [ ] Derive an AES-GCM key from the Supabase session token using Web Crypto API
- [ ] Wrap all IndexedDB writes with `crypto.subtle.encrypt` and reads with `crypto.subtle.decrypt`
- [ ] Store the derived key only in memory (never persisted)

---

## 8. Cache wipe on sign-out
_Depends on #6 and #7._

- [ ] On `supabase.auth.signOut()`, clear all IndexedDB stores and relevant `localStorage` keys
- [ ] Verify offline cache is gone after sign-out by testing in DevTools → Application → Storage
