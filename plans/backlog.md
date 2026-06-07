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

### 3.3 Server functions — `src/lib/income.ts` (new file) ✅

- [x] `getIncomePaginated({ pageIndex, pageSize })` — mirrors `getTransactionsPaginated`; returns `{ income, totalCount }`
- [x] `createIncome({ data })` — validates with `inputValidator`, inserts row, returns `IncomeEntry`
- [x] `deleteIncome({ data: id })` — deletes by id scoped to `user_id`
- [x] `getIncomeTotalForRange({ from, to })` — returns a single `number`; used by analytics

### 3.4 Route — `src/routes/income.tsx` (new file) ✅

- [x] Mirror the structure of `src/routes/transactions.tsx`:
  - TanStack Query for paginated fetch (`useQuery` with `['income', queryInput]` key)
  - Delete mutation with `toast.success` / `toast.error`
- [x] "Add Income" form inline at the top of the page (no separate route needed):
  - Fields: Amount + Currency (same combined input as `SpeedEntryForm`), Source (text input, required), Description (optional)
  - Validate with `createIncomeSchema` — show inline errors, same pattern as `SpeedEntryForm`
  - On success: invalidate query + `toast.success('Income saved')`
- [x] Income history table below the form:
  - Columns: Date, Source, Description, Amount
  - Pagination controls (reuse `TransactionsPagination`)
  - Delete button per row with `AlertDialog` confirmation (reuse pattern from `TransactionsTable`)

### 3.5 Navigation ✅

- [x] Add `{ to: '/income', icon: TrendingUp, label: 'Income' }` to `NAV_LINKS` in `src/components/Header.tsx` — insert between Transactions and Settings

### 3.6 Analytics integration ✅

- [x] Extend `getRangeAnalytics` in `src/lib/analytics.ts` to also call `getIncomeTotalForRange` and include `totalIncome: number` in `AnalyticsRangeSummary`
- [x] Add `totalIncome` field to `AnalyticsRangeSummary` in `src/lib/domain.ts`
- [x] Show "Total Income" stat card on the Analytics page alongside the existing "Total Spent" card

---

## 4. Budget system

_No budget table, limit-setting UI, or budget vs. actual chart._

### 4.1 Database

- [x] Run migration in Supabase SQL Editor:

  ```sql
  create table public.budgets (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    category_id uuid not null references public.categories(id) on delete cascade,
    monthly_limit numeric not null check (monthly_limit > 0),
    currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, category_id)
  );
  alter table public.budgets enable row level security;
  create policy "Users can view their own budgets" on public.budgets for select using (auth.uid() = user_id);
  create policy "Users can insert their own budgets" on public.budgets for insert with check (auth.uid() = user_id);
  create policy "Users can update their own budgets" on public.budgets for update using (auth.uid() = user_id);
  create policy "Users can delete their own budgets" on public.budgets for delete using (auth.uid() = user_id);

  create trigger set_budgets_updated_at
    before update on public.budgets
    for each row execute function public.handle_updated_at();
  ```

- [x] Add `budgets` table schema to `docs/db.md`

### 4.2 Domain & validation ✅

- [x] Add types to `src/lib/domain.ts`:
  - `BudgetEntry`: `id`, `categoryId`, `monthlyLimit`, `currency`
  - `UpsertBudgetInput`: `categoryId`, `monthlyLimit`, `currency`
  - `BudgetVarianceItem`: `categoryId`, `name`, `icon?`, `budget`, `actual`, `overBudget` (bool)
- [x] Add `budgetVariance: Array<BudgetVarianceItem>` field to `AnalyticsRangeSummary` in `src/lib/domain.ts`
- [x] Add `upsertBudgetSchema` to `src/lib/schemas.ts`:
  - `categoryId`: non-empty string
  - `monthlyLimit`: positive number
  - `currency`: `z.enum(CURRENCIES)`

### 4.3 Server functions — `src/lib/budgets.ts` (new file)

- [ ] `getBudgets()` — fetches all budgets for the current user, joined with `categories (id, name, icon)`; returns `Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>`
- [ ] `upsertBudget({ data })` — validates with `inputValidator` using `upsertBudgetSchema`; issues an `upsert` on `(user_id, category_id)` with `onConflict: 'user_id,category_id'`; returns the saved `BudgetEntry`
- [ ] `deleteBudget({ data: id })` — deletes budget row by id scoped to `user_id`; used when the user clears a category's limit

### 4.4 Analytics integration

- [ ] Extend `getRangeAnalytics` in `src/lib/analytics.ts`:
  - Add a third parallel query: `supabase.from('budgets').select('category_id, monthly_limit, currency').eq('user_id', user.id)`
  - After building `categoryMap`, merge budget limits: for each budget row look up the matching category in `categoryMap` and compute `actual` (use `0` if category had no spend), `budget: monthly_limit`, `overBudget: actual > monthly_limit`
  - Include categories that have a budget but zero spend in the range
  - Append `budgetVariance: Array<BudgetVarianceItem>` to the returned `AnalyticsRangeSummary`

### 4.5 Budget variance chart — `src/components/analytics/BudgetVarianceBarChart.tsx` (new file)

- [ ] Props: `data: Array<BudgetVarianceItem>`
- [ ] Use Recharts `BarChart` with two `Bar` components: "Budget" (blue, `fill="hsl(var(--primary))"`) and "Actual" (dynamic fill — green when under, red/destructive when over)
  - Implement a custom `Cell`-per-bar fill: iterate `data` and apply `fill="hsl(var(--destructive))"` when `overBudget` is true, else `fill="hsl(var(--chart-2))"` (match the color used by `CategoryDonutChart`)
- [ ] `XAxis dataKey="name"`, `YAxis`, `Tooltip`, `Legend` — same import pattern as `TimelineBarChart`
- [ ] Wrap in a `<ResponsiveContainer width="100%" height={260}>`

### 4.6 Settings — Budget tab

- [ ] Add `BudgetTab` to `src/components/settings/BudgetTab.tsx` (new file):
  - `useQuery(['budgets'], getBudgets)` to load existing limits
  - Accept `categories: Array<Category>` as a prop (already loaded by the settings route loader)
  - Render one row per category: icon + name on the left; a number `<Input>` for the monthly limit and a `<Select>` for currency on the right; a "Save" `<Button>` per row
  - Pre-fill inputs from the budgets query result; show empty inputs for categories with no budget
  - On "Save": call `upsertBudget` mutation → `toast.success('Budget saved')` / `toast.error(...)`; invalidate `['budgets']` query
  - Show a trash icon button per row only when a budget exists; on click: `AlertDialog` confirmation → `deleteBudget` → `toast.success('Budget removed')` → invalidate `['budgets']`
- [ ] Update `src/routes/settings.tsx`:
  - Add `getBudgets` call to the route `loader` so budgets are available server-side (or rely on client query — client `useQuery` is fine to keep it consistent with other tabs)
  - Change `TabsList` to `grid-cols-3`; add third `TabsTrigger` with `value="budget"` and `<Wallet>` icon from lucide-react
  - Add `<TabsContent value="budget"><BudgetTab categories={categories} /></TabsContent>`

### 4.7 Analytics page wiring

- [ ] In `src/routes/analytics.tsx`, after the "Over Time" section, conditionally render the variance chart:
  ```tsx
  {
    analytics.budgetVariance.length > 0 && (
      <section>
        <h2 className="text-sm font-semibold mb-2">Budget vs. Actual</h2>
        <BudgetVarianceBarChart data={analytics.budgetVariance} />
      </section>
    )
  }
  ```

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
