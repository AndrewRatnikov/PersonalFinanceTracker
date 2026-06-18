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

### 6.4 Offline-aware loader — `src/routes/index.tsx` ✅

- [x] Wrap the existing `Promise.all([getMonthlyExpenses(), getRecentExpenses(), getUserCategories()])` in `try/catch`:
  - **On success** (happy path): after destructuring, call `setOfflineCache` for `'recentExpenses'`, `'categories'`, and `'monthlyStats'` when `typeof window !== 'undefined'`; return the data as before
  - **On network failure**: if `typeof window !== 'undefined' && !navigator.onLine`, attempt to read all three keys via `getOfflineCache`; if at least `recentExpenses` and `categories` are present, return them (use `[]` as fallback for `monthlyStats`) with a `fromCache: true` flag appended to the return value; if IDB is empty, re-throw the original error
- [x] Add `fromCache?: boolean` to the loader's inferred return type so `Route.useLoaderData()` exposes it

### 6.5 Offline-aware loader — `src/routes/settings.tsx` ✅

- [x] Apply the same try/catch pattern to the `getUserCategories()` call in the settings loader:
  - On success: write to `'categories'` via `setOfflineCache`
  - On offline error: read `'categories'` from IDB and return it; re-throw if IDB is empty

### 6.6 Online status hook — `src/lib/useOnlineStatus.ts` (new file) ✅

- [x] Implement using `navigator.onLine` as the initial value plus `'online'` / `'offline'` event listeners:

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

### 6.7 Offline banner — `src/components/OfflineBanner.tsx` (new file) ✅

- [x] Render a fixed bar at the top of the viewport when offline:

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

- [x] Import and render `<OfflineBanner />` in `RootDocument` in `src/routes/__root.tsx` as the very first child inside `<body>`, before `<Header />`

### 6.8 Verify

- [x] Run `npm run build && npm run preview`
- [x] DevTools → Application → Cache Storage — confirm a `navigation` cache with HTML entries appears after visiting a few routes
- [x] DevTools → Network → Offline; reload — confirm the app shell loads from SW cache and the dashboard renders recent expenses + categories from IDB instead of a blank or error state
- [x] Confirm the "Viewing cached data" banner appears while offline and disappears when the network is restored (toggle the DevTools offline switch while the app is open)
- [x] DevTools → Application → IndexedDB → `minima-offline` → `cache` — confirm `recentExpenses`, `categories`, and `monthlyStats` keys are present with correct data after an online visit
- [x] DevTools → Network → back Online; navigate to `/` — confirm live data resumes, banner disappears, and IDB is refreshed

---

## 7. Local-first storage with encryption

_Depends on #6 — IDB infrastructure and offlineCache module exist._

**Goal:** IDB becomes the primary data store for all user data (expenses, categories, income, budgets). Every write is encrypted with AES-GCM before it touches disk. Supabase is retained for auth and will be used for cloud sync in a future Premium tier — for now all data operations bypass the server entirely.

**Architectural shift**

| | Before | After |
|---|---|---|
| Primary store | Supabase (PostgreSQL) | IndexedDB (encrypted) |
| Offline data | IDB read-through cache | IDB is the source of truth |
| Server functions | All CRUD | Auth only |
| Analytics | Computed server-side | Computed client-side from IDB |

**Key derivation strategy:** the access token rotates on every refresh, so it cannot be used as stable key material. Instead, derive the key from `userId` (stable) plus a per-device random salt stored in `localStorage` under `minima_device_salt_{userId}`. This makes the key unique per user per device. If `localStorage` is cleared the IDB data becomes unreadable — treat as a fresh start (data can be re-seeded from Supabase for Premium users; free-tier users lose local data, which is acceptable).

### 7.1 Crypto module — `src/lib/crypto.ts` (new file)

- [ ] Export `getOrCreateDeviceSalt(userId: string): Uint8Array`:
  - Key: `minima_device_salt_{userId}` in `localStorage`
  - If absent: `crypto.getRandomValues(new Uint8Array(32))`, hex-encode and store, return it
  - If present: hex-decode and return
  - Guard with `typeof window === 'undefined'` early-return (throws on SSR — callers must be client-only)
- [ ] Export `deriveKey(userId: string, deviceSalt: Uint8Array): Promise<CryptoKey>`:
  ```ts
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(userId),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: deviceSalt, info: new Uint8Array() },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  ```
- [ ] Export `encryptValue(key: CryptoKey, value: unknown): Promise<Uint8Array>`:
  - Generate random 12-byte IV: `crypto.getRandomValues(new Uint8Array(12))`
  - Encode: `new TextEncoder().encode(JSON.stringify(value))`
  - `crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)`
  - Return `Uint8Array` with IV (bytes 0–11) prepended to ciphertext
- [ ] Export `decryptValue(key: CryptoKey, data: Uint8Array): Promise<unknown>`:
  - Split IV (`data.slice(0, 12)`) and ciphertext (`data.slice(12)`)
  - `crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)`
  - UTF-8 decode, JSON-parse, return

### 7.2 Local DB module — `src/lib/localDb.ts` (new file)

This module replaces direct calls to server functions for all data operations. `offlineCache.ts` is retired — its three cache keys become part of the richer schema here.

**IDB store layout** (one `idb-keyval` custom store `'minima-local'` / `'data'`):

| Key | Type |
|---|---|
| `'expenses'` | `Array<Expense>` |
| `'categories'` | `Array<Category>` |
| `'income'` | `Array<IncomeEntry>` |
| `'budgets'` | `Array<BudgetEntry>` |

- [ ] Module-level `let _key: CryptoKey | null = null`
- [ ] Create a `createStore('minima-local', 'data')` store (same guard pattern as `offlineCache.ts`)
- [ ] Export `initLocalDb(userId: string): Promise<void>`:
  - Guard: early-return if `typeof window === 'undefined'`
  - Call `getOrCreateDeviceSalt(userId)` then `deriveKey` → assign `_key`
- [ ] Export `wipeLocalDbKey(): void` — sets `_key = null`; called on sign-out by #8
- [ ] Internal helpers `readStore<K>(key)` / `writeStore<K>(key, data)`:
  - `readStore`: if `_key` is null return `undefined`; read raw IDB value; if not `Uint8Array` return `undefined` (legacy data); `decryptValue` in `try/catch`, return `undefined` on error
  - `writeStore`: if `_key` is null throw `'LocalDb not initialized'`; `encryptValue` then `set(key, encrypted, store)`
- [ ] **Expenses CRUD**:
  - `getAllExpenses(): Promise<Array<Expense>>` — reads `'expenses'`, returns `[]` if absent; joins category from `'categories'` by id so `expense.category` is always populated
  - `addExpense(input: CreateExpenseInput): Promise<Expense>` — reads current array, appends new entry with `crypto.randomUUID()` id and `new Date().toISOString()` createdAt, writes back; returns the new entry
  - `deleteExpense(id: string): Promise<void>` — filters out by id and writes back
- [ ] **Categories CRUD**:
  - `getAllCategories(): Promise<Array<Category>>` — reads `'categories'`, returns `[]` if absent
  - `addCategory(input: CreateCategoryInput): Promise<Category>` — appends with new UUID, writes back
  - `updateCategory(input: UpdateCategoryInput): Promise<Category>` — maps over array replacing matching id, writes back
  - `deleteCategory(id: string): Promise<void>` — checks for any expense in `'expenses'` referencing this `categoryId`; throws the same "X expenses use this category" error if found; otherwise filters and writes back
  - `provisionDefaultCategories(): Promise<void>` — reads `'categories'`; if non-empty returns early; inserts the same six default entries as the current `categories.ts` server function (Food 🍔, Transport 🚌, Rent 🏠, Coffee ☕, Entertainment 🎬, Server Costs 🖥️) with client-generated UUIDs; writes back
- [ ] **Income CRUD**:
  - `getAllIncome(): Promise<Array<IncomeEntry>>` — reads `'income'`, returns `[]` if absent
  - `addIncome(input: CreateIncomeInput): Promise<IncomeEntry>` — appends with UUID + createdAt, writes back
  - `deleteIncome(id: string): Promise<void>` — filters and writes back
- [ ] **Budgets CRUD**:
  - `getAllBudgets(): Promise<Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>>` — reads `'budgets'`, joins category name/icon from `'categories'`
  - `upsertBudget(input: UpsertBudgetInput): Promise<BudgetEntry>` — reads current array; if entry with same `categoryId` exists replace it (preserving `id`), otherwise append with new UUID; writes back
  - `deleteBudget(id: string): Promise<void>` — filters and writes back

### 7.3 One-time data migration from Supabase — `src/lib/dataMigration.ts` (new file)

Existing users have data in Supabase. On first run after this feature ships, pull it into IDB.

- [ ] Export `runDataMigration(userId: string): Promise<void>`:
  - Check `localStorage.getItem('minima_migrated_' + userId)` — if present, return early
  - Call in parallel: existing server functions `getUserCategories()`, `getRecentExpenses()` (note: fetches only 10; see caveat below), `getAllIncome({ pageIndex: 0, pageSize: 1000 })`, `getBudgets()`
  - Write each result to IDB via `writeStore` (raw, since `localDb` helpers use `readStore/writeStore` internally — call the CRUD setters or `writeStore` directly)
  - For expenses: `getRecentExpenses()` only returns 10 rows. Use `getTransactionsPaginated` in a loop (page through all pages) to seed the full history. Cap at 500 rows to avoid a massive first-load stall — log a warning if truncated
  - Set `localStorage.setItem('minima_migrated_' + userId, '1')` on success
  - Wrap the whole function in `try/catch` — on failure log the error and do **not** set the flag (will retry next load)

### 7.4 Local analytics — `src/lib/localAnalytics.ts` (new file)

Replace the `getRangeAnalytics` server function with a client-side computation over IDB data.

- [ ] Export `computeRangeAnalytics(from: string, to: string): Promise<AnalyticsRangeSummary>`:
  - Call `getAllExpenses()`, `getAllCategories()`, `getAllIncome()`, `getAllBudgets()` in parallel
  - Filter expenses to those with `createdAt >= from && createdAt <= to`
  - Build `categoryBreakdown`: group filtered expenses by `categoryId`, sum amounts, join name/icon from categories
  - Build `timeline`: group filtered expenses by ISO date (`createdAt.slice(0, 10)`), sum amounts, format label as `DD Mon`
  - Compute `totalIncome`: sum income entries whose `createdAt` falls in range
  - Compute `budgetVariance`: for each budget, find actual spend in range from `categoryBreakdown` (default 0); set `overBudget: actual > monthlyLimit`; include categories with budget but zero spend
  - Return `AnalyticsRangeSummary` with `from`, `to`, and all computed fields

### 7.5 Update routes to use localDb

All routes drop their Supabase server function calls. Data fetching moves entirely to React Query `useQuery` against `localDb` functions. The SSR `loader` for each route becomes auth-only (no data).

**`src/routes/index.tsx`**
- [ ] Remove `getMonthlyExpenses()`, `getRecentExpenses()`, `getUserCategories()` from the `loader`; remove the offline try/catch pattern — it is no longer needed
- [ ] Add `useQuery(['categories'], getAllCategories)` and `useQuery(['expenses'], getAllExpenses)` in the component
- [ ] Compute monthly stats client-side: group `getAllExpenses()` result by month/year, sum totals — replaces `MonthlyExpenseSummary` server logic
- [ ] Remove `fromCache` flag handling (IDB is always the source of truth now)

**`src/routes/transactions.tsx`**
- [ ] Replace `getTransactionsPaginated` fetcher with a local function that calls `getAllExpenses()` and paginates in-memory (sort by `createdAt` descending, slice by `pageIndex`/`pageSize`)
- [ ] Replace `createExpense` mutation with `addExpense` from `localDb`; keep `toast.success` / `toast.error` and `queryClient.invalidateQueries(['expenses'])`
- [ ] Replace `deleteExpense` mutation with `deleteExpense` from `localDb`

**`src/routes/income.tsx`**
- [ ] Same pattern: replace `getIncomePaginated`, `createIncome`, `deleteIncome` with localDb equivalents; query key stays `['income']`

**`src/routes/settings.tsx`**
- [ ] Remove `getUserCategories()` from the `loader`; remove offline try/catch
- [ ] `CategoriesTab`: replace `createCategory`, `updateCategory`, `deleteCategory` mutations and `getUserCategories` query with localDb equivalents; query key `['categories']`
- [ ] `BudgetTab`: replace `getBudgets`, `upsertBudget`, `deleteBudget` with localDb equivalents; query key `['budgets']`

**`src/routes/analytics.tsx`**
- [ ] Replace `getRangeAnalytics({ from, to })` call with `computeRangeAnalytics(from, to)` from `localAnalytics.ts`

### 7.6 Wire init + migration — `src/routes/__root.tsx`

- [ ] Import `initLocalDb` from `../lib/localDb`, `runDataMigration` from `../lib/dataMigration`
- [ ] In `beforeLoad`, after `getServerUser()` resolves and `user` is non-null, add:
  ```ts
  if (typeof window !== 'undefined') {
    await initLocalDb(user.id)
    await runDataMigration(user.id)
  }
  ```
  - Place **before** the `provisionDefaultCategories` call
- [ ] Change the `provisionDefaultCategories()` call to use the localDb version: replace `await provisionDefaultCategories()` (server function) with `await localProvisionDefaultCategories()` imported from `../lib/localDb`; remove the `setLocalStore(user.id, 'categoriesProvisioned', true)` guard — `localDb.provisionDefaultCategories()` already short-circuits if categories exist

### 7.7 Premium Supabase sync (stub — not wired)

- [ ] Add `export const ENABLE_SUPABASE_SYNC = false` at the top of `src/lib/localDb.ts`
- [ ] Add a comment block explaining: when `true`, each write mutation should also call the corresponding server function in `src/lib/expenses.ts` / `categories.ts` / `income.ts` / `budgets.ts`; guarded behind a Premium check; not implemented yet

### 7.8 Retire `src/lib/offlineCache.ts`

- [ ] Remove `offlineCache.ts` (all its functionality is superseded by `localDb.ts`)
- [ ] Remove `import … from '../lib/offlineCache'` from `src/routes/index.tsx` and `src/routes/settings.tsx`
- [ ] Remove the `<OfflineBanner />` offline try/catch fallbacks in loaders — they existed to serve the old IDB-as-cache pattern; with local-first the banner still shows when offline, but data always comes from IDB without a special code path

### 7.9 Verify

- [ ] `npm run dev` — create a new expense; open DevTools → Application → IndexedDB → `minima-local` → `data` → confirm the `expenses` entry is a binary blob, not readable JSON
- [ ] Reload the page — confirm expenses still appear (decrypt on read works)
- [ ] DevTools → Network → Offline; reload — confirm the dashboard, transactions, income, analytics pages all load normally from IDB with no server calls
- [ ] Confirm the "Viewing cached data" banner still appears when offline
- [ ] Add an expense while offline; go back online; confirm the expense persists (it was written directly to IDB, not a network call)
- [ ] Open a second browser profile pointing to the same `localhost`; confirm it cannot read the IDB data (different `deviceSalt` in that profile's `localStorage`)
- [ ] Existing user migration: sign in with an account that has Supabase data; confirm all historical expenses/categories/income appear in the app after first load

---

## 8. Data wipe on sign-out

_Depends on #7. With IDB as the primary data store (not just a cache), clearing it on sign-out is a security requirement — the next person who opens the browser must not be able to read another user's expenses._

### 8.1 Local CSV export — `src/lib/localExport.ts` (new file)

The existing `exportExpensesCSV` in `csvTools.ts` is a server function that reads from Supabase. After #7 all data lives in IDB, so it must be replaced with a client-side export covering all four collections.

- [ ] Export `exportAllLocalData(): Promise<void>`:
  - Reads `getAllExpenses()`, `getAllCategories()`, `getAllIncome()`, `getAllBudgets()` in parallel from `localDb`
  - Builds four CSV strings:
    - **expenses.csv** — columns: `date, amount, currency, category, description` (same format as the existing `exportExpensesCSV` so import still works)
    - **income.csv** — columns: `date, source, amount, currency, description`
    - **categories.csv** — columns: `name, icon`
    - **budgets.csv** — columns: `category, monthly_limit, currency`
  - For each CSV string, triggers a browser download via a temporary `<a href="blob:..." download="filename.csv">` element (no extra dependency — four sequential downloads)
  - Helper: `triggerDownload(filename: string, csvContent: string): void` — creates a `Blob` with `type: 'text/csv'`, creates a temporary object URL, clicks a hidden `<a>`, then revokes the URL

### 8.2 Sign-out confirmation dialog

- [ ] Replace the sign-out button in `src/components/Header.tsx` with an `AlertDialog` confirmation:
  - Title: `"Sign out?"`
  - Description: `"All locally stored data — expenses, categories, income, and budgets — will be permanently deleted from this device. Export your data first if you want to keep a copy."`
  - Secondary action button: `"Export my data"` — calls `exportAllLocalData()` without closing the dialog, so the user can download and then confirm
  - Confirm button: `"Sign out & delete data"` (destructive variant)
  - Cancel button: `"Cancel"`
  - Only proceed with cleanup + sign-out when the user confirms

### 8.3 Sign-out cleanup

- [ ] Wrap the sign-out flow in a helper that runs in this order:
  1. `exportAllLocalData()` is already opt-in from the dialog — no automatic export here
  2. `wipeLocalDbKey()` from `src/lib/localDb.ts` — clears the in-memory `CryptoKey`
  3. Clear the IDB store (`clear(store)` from `localDb.ts`) — wipes all encrypted blobs
  4. Clear `localStorage` keys for the signed-out user:
     - `minima_device_salt_{userId}` — device key material (makes any residual IDB blobs permanently unreadable)
     - `minima_migrated_{userId}` — migration flag (re-login triggers a fresh seed)
     - `minima_offline_user` — cached user identity used by the offline `beforeLoad` fallback
  5. Call `supabase.auth.signOut()` and redirect to `/login`

### 8.4 Update `csvTools.ts`

- [ ] Mark `exportExpensesCSV` server function as deprecated with a comment pointing to `localExport.ts`; do not delete it yet — the import UI still references it and will be migrated separately

### 8.5 Verify

- [ ] Click sign-out → confirm the dialog appears with the warning description
- [ ] Click "Export my data" → confirm four `.csv` files download (expenses, income, categories, budgets); dialog remains open
- [ ] Click "Sign out & delete data" → DevTools → Application → IndexedDB → confirm `minima-local` store is empty; LocalStorage → confirm the three keys are gone
- [ ] Navigate back to `/` — confirm redirect to `/login` with no stale data
