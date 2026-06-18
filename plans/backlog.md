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

### 4.3 Server functions — `src/lib/budgets.ts` (new file) ✅

- [x] `getBudgets()` — fetches all budgets for the current user, joined with `categories (id, name, icon)`; returns `Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>`
- [x] `upsertBudget({ data })` — validates with `inputValidator` using `upsertBudgetSchema`; issues an `upsert` on `(user_id, category_id)` with `onConflict: 'user_id,category_id'`; returns the saved `BudgetEntry`
- [x] `deleteBudget({ data: id })` — deletes budget row by id scoped to `user_id`; used when the user clears a category's limit

### 4.4 Analytics integration ✅

- [x] Extend `getRangeAnalytics` in `src/lib/analytics.ts`:
  - Add a third parallel query: `supabase.from('budgets').select('category_id, monthly_limit, currency').eq('user_id', user.id)`
  - After building `categoryMap`, merge budget limits: for each budget row look up the matching category in `categoryMap` and compute `actual` (use `0` if category had no spend), `budget: monthly_limit`, `overBudget: actual > monthly_limit`
  - Include categories that have a budget but zero spend in the range
  - Append `budgetVariance: Array<BudgetVarianceItem>` to the returned `AnalyticsRangeSummary`

### 4.5 Budget variance chart — `src/components/analytics/BudgetVarianceBarChart.tsx` (new file) ✅

- [x] Props: `data: Array<BudgetVarianceItem>`
- [x] Use Recharts `BarChart` with two `Bar` components: "Budget" (blue, `fill="hsl(var(--primary))"`) and "Actual" (dynamic fill — green when under, red/destructive when over)
  - Implement a custom `Cell`-per-bar fill: iterate `data` and apply `fill="hsl(var(--destructive))"` when `overBudget` is true, else `fill="hsl(var(--chart-2))"` (match the color used by `CategoryDonutChart`)
- [x] `XAxis dataKey="name"`, `YAxis`, `Tooltip`, `Legend` — same import pattern as `TimelineBarChart`
- [x] Wrap in a `<ResponsiveContainer width="100%" height={260}>`

### 4.6 Settings — Budget tab ✅

- [x] Add `BudgetTab` to `src/components/settings/BudgetTab.tsx` (new file):
  - `useQuery(['budgets'], getBudgets)` to load existing limits
  - Accept `categories: Array<Category>` as a prop (already loaded by the settings route loader)
  - Render one row per category: icon + name on the left; a number `<Input>` for the monthly limit and a `<Select>` for currency on the right; a "Save" `<Button>` per row
  - Pre-fill inputs from the budgets query result; show empty inputs for categories with no budget
  - On "Save": call `upsertBudget` mutation → `toast.success('Budget saved')` / `toast.error(...)`; invalidate `['budgets']` query
  - Show a trash icon button per row only when a budget exists; on click: `AlertDialog` confirmation → `deleteBudget` → `toast.success('Budget removed')` → invalidate `['budgets']`
- [x] Update `src/routes/settings.tsx`:
  - Change `TabsList` to `grid-cols-3`; add third `TabsTrigger` with `value="budget"` and `<Wallet>` icon from lucide-react
  - Add `<TabsContent value="budget"><BudgetTab categories={categories} /></TabsContent>`

### 4.7 Analytics page wiring ✅

- [x] In `src/routes/analytics.tsx`, after the "Over Time" section, conditionally render the variance chart

---

## 5. PWA setup

_App is not installable and has no offline shell._

**Current state**

- `public/manifest.json` exists but has TanStack placeholder content (`name`, `theme_color`, icons)
- `public/logo192.png` and `public/logo512.png` exist but are TanStack logos — need replacing
- `vite-plugin-pwa` is not installed; no service worker is registered

**Compatibility note**
The app uses `nitro` (Vercel preset) + `@tanstack/react-start`. `vite-plugin-pwa` generates a static SW file and injects the registration script at build time — this is fine for Nitro because the SW file lands in the output root and Nitro serves it as a static asset. Use `injectRegister: 'script'` (not `'auto'`) so the plugin emits an explicit `<script>` tag rather than relying on module injection that Nitro's HTML transform may strip.

### 5.1 Install

- [x] `npm install -D vite-plugin-pwa`

### 5.2 App icons

- [x] Replace `public/logo192.png` with a 192×192 Minima Spend app icon
- [x] Replace `public/logo512.png` with a 512×512 Minima Spend app icon
  - Both must be square PNG with a solid or transparent background
  - Derive from `public/favicon.svg` if possible (e.g. via Inkscape, Figma, or `sharp` CLI)

### 5.3 Manifest

- [x] Update `public/manifest.json`:
  ```json
  {
    "name": "Minima Spend",
    "short_name": "Minima",
    "start_url": "/",
    "display": "standalone",
    "theme_color": "#6366f1",
    "background_color": "#09090b",
    "icons": [
      { "src": "logo192.png", "sizes": "192x192", "type": "image/png" },
      {
        "src": "logo512.png",
        "sizes": "512x512",
        "type": "image/png",
        "purpose": "any maskable"
      }
    ]
  }
  ```

### 5.4 Vite plugin

- [x] Add `VitePWA` to `vite.config.ts`:

  ```ts
  import { VitePWA } from 'vite-plugin-pwa'

  // inside plugins array:
  VitePWA({
    registerType: 'autoUpdate',
    injectRegister: 'script',
    manifest: false, // use the file in public/ — don't let the plugin overwrite it
    workbox: {
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
    },
  })
  ```

  - `manifest: false` keeps `public/manifest.json` as the single source of truth
  - Place `VitePWA(...)` **before** `tanstackStart()` in the plugins array so it runs first

### 5.5 Manifest link

- [x] Confirm `<link rel="manifest" href="/manifest.json">` is present in the HTML shell (check `src/routes/__root.tsx` `<Meta />` / `<Links />` — TanStack Start auto-injects assets from `public/`; add the link explicitly if it is missing)

### 5.6 Verify

- [x] Run `npm run build && npm run preview`
- [x] Open Chrome DevTools → Application → Manifest — confirm name, icons, and display mode load correctly
- [x] DevTools → Application → Service Workers — confirm SW is registered and active
- [x] On mobile Chrome (or via DevTools device emulation + "Add to Home Screen"): verify install prompt appears

---

## 6. Workbox offline cache

_Depends on #5. The Workbox SW from #5 already caches static assets and JS bundles via `CacheFirst`. This step adds a navigation cache strategy and a data-layer offline fallback so the app renders meaningful content without a network connection._

_Data note: the app fetches data through TanStack Router `loader` functions (not React Query `useQuery`), so offline fallback is implemented at the loader level, not in query hooks._

### 6.1 Install

- [x] `npm install idb-keyval` — tiny (≈ 1 kB gzipped) typed key-value wrapper over IndexedDB; no separate `@types` package required

### 6.2 Workbox navigation strategy — `vite.config.ts` ✅

- [x] Add a `NetworkFirst` entry for navigate-mode requests to the existing `runtimeCaching` array inside `VitePWA`:
  ```ts
  {
    urlPattern: ({ request }) => request.mode === 'navigate',
    handler: 'NetworkFirst',
    options: {
      cacheName: 'navigation',
      networkTimeoutSeconds: 3,
      expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 },
    },
  }
  ```

  - `networkTimeoutSeconds: 3` — fall back to the cached shell after 3 s if the server does not respond
  - Place this entry **before** the existing `CacheFirst` assets entry in the array

### 6.3 IDB cache module — `src/lib/offlineCache.ts` (new file) ✅

- [x] Create a typed IDB wrapper using `idb-keyval`'s custom-store API:
  ```ts
  import { createStore, get, set, clear } from 'idb-keyval'
  const store = createStore('minima-offline', 'cache')
  ```
- [x] Define a `OfflineCacheKey` string-union type covering the three persisted datasets:
  - `'recentExpenses'` → `Array<Expense>`
  - `'categories'` → `Array<Category>`
  - `'monthlyStats'` → `Array<MonthlyExpenseSummary>`
- [x] Export three SSR-safe helpers (guard with `typeof window === 'undefined'` and return early/undefined on the server):
  - `getOfflineCache<T>(key: OfflineCacheKey): Promise<T | undefined>`
  - `setOfflineCache<T>(key: OfflineCacheKey, value: T): Promise<void>`
  - `clearOfflineCache(): Promise<void>` — called on sign-out (used by #8)

### 6.4 Offline-aware loader — `src/routes/index.tsx`

- [ ] Wrap the existing `Promise.all([getMonthlyExpenses(), getRecentExpenses(), getUserCategories()])` in `try/catch`:
  - **On success** (happy path): after destructuring, call `setOfflineCache` for `'recentExpenses'`, `'categories'`, and `'monthlyStats'` when `typeof window !== 'undefined'`; return the data as before
  - **On network failure**: if `typeof window !== 'undefined' && !navigator.onLine`, attempt to read all three keys via `getOfflineCache`; if at least `recentExpenses` and `categories` are present, return them (use `[]` as fallback for `monthlyStats`) with a `fromCache: true` flag appended to the return value; if IDB is empty, re-throw the original error
- [ ] Add `fromCache?: boolean` to the loader's inferred return type so `Route.useLoaderData()` exposes it

### 6.5 Offline-aware loader — `src/routes/settings.tsx`

- [ ] Apply the same try/catch pattern to the `getUserCategories()` call in the settings loader:
  - On success: write to `'categories'` via `setOfflineCache`
  - On offline error: read `'categories'` from IDB and return it; re-throw if IDB is empty

### 6.6 Online status hook — `src/lib/useOnlineStatus.ts` (new file)

- [ ] Implement using `navigator.onLine` as the initial value plus `'online'` / `'offline'` event listeners:

  ```ts
  import { useEffect, useState } from 'react'

  export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(
      typeof navigator !== 'undefined' ? navigator.onLine : true,
    )
    useEffect(() => {
      const on = () => setOnline(true)
      const off = () => setOnline(false)
      window.addEventListener('online', on)
      window.addEventListener('offline', off)
      return () => {
        window.removeEventListener('online', on)
        window.removeEventListener('offline', off)
      }
    }, [])
    return online
  }
  ```

### 6.7 Offline banner — `src/components/OfflineBanner.tsx` (new file)

- [ ] Render a fixed bar at the top of the viewport when offline:

  ```tsx
  import { WifiOff } from 'lucide-react'
  import { useOnlineStatus } from '@/lib/useOnlineStatus'

  export function OfflineBanner() {
    const online = useOnlineStatus()
    if (online) return null
    return (
      <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 bg-muted px-4 py-2 text-xs text-muted-foreground">
        <WifiOff className="h-3.5 w-3.5" />
        Viewing cached data — some features may be unavailable
      </div>
    )
  }
  ```

- [ ] Import and render `<OfflineBanner />` in `RootDocument` in `src/routes/__root.tsx` as the very first child inside `<body>`, before `<Header />`

### 6.8 Verify

- [ ] Run `npm run build && npm run preview`
- [ ] DevTools → Application → Cache Storage — confirm a `navigation` cache with HTML entries appears after visiting a few routes
- [ ] DevTools → Network → Offline; reload — confirm the app shell loads from SW cache and the dashboard renders recent expenses + categories from IDB instead of a blank or error state
- [ ] Confirm the "Viewing cached data" banner appears while offline and disappears when the network is restored (toggle the DevTools offline switch while the app is open)
- [ ] DevTools → Application → IndexedDB → `minima-offline` → `cache` — confirm `recentExpenses`, `categories`, and `monthlyStats` keys are present with correct data after an online visit
- [ ] DevTools → Network → back Online; navigate to `/` — confirm live data resumes, banner disappears, and IDB is refreshed

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
