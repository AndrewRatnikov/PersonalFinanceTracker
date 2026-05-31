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

## 2. Default category provisioning on first login
_New users land with no categories, which breaks expense entry immediately._

- [ ] Add a `provisionDefaultCategories` server function in `src/lib/categories.ts`
  - Checks whether the user already has any categories
  - If none, bulk-inserts: Food, Transport, Rent, Coffee, Entertainment, Server Costs
- [ ] Call it inside the `beforeLoad` of `src/routes/__root.tsx` after `getServerUser` resolves (only when user is present)

---

## 3. Income tracking
_No income table, route, form, or analytics integration exists yet._

- [ ] Run `income` table migration in Supabase (see `docs/db.md` for schema)
- [ ] Add RLS policies (same pattern as `expenses`)
- [ ] Add `src/lib/income.ts` with `createIncome` and `getIncomeForRange` server functions
- [ ] Add `IncomeEntry` type to `src/lib/domain.ts`
- [ ] Create `src/routes/income.tsx` — paginated income history table (mirrors Transactions page)
- [ ] Add income entry form (Amount → Currency → Source → Description → Save)
- [ ] Add "Income" link to `src/components/Header.tsx`
- [ ] Extend analytics loader to include `totalIncome` for the selected range
- [ ] Show "Total Income" stat alongside "Total Spent" on the Analytics page

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
