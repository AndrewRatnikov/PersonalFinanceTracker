# PRD: MinimaSpend

## 1. Product Summary

MinimaSpend is a minimalist, mobile-first PWA for personal expense and income tracking. The core value proposition is a frictionless entry flow, flexible date-range analytics, and full data ownership — no bank sync, no subscriptions, no noise.

Target user: a developer or power user who wants a simple, self-contained tracker with offline access and privacy-first local storage.

---

## 2. Tech Stack

- **Framework:** TanStack Start (React + TanStack Router + Vite)
- **Styling:** Tailwind CSS + Shadcn UI
- **Backend/Auth:** Supabase (Server Functions + Google OAuth)
- **Data:** TanStack Query
- **Charts:** Recharts
- **PWA:** `vite-plugin-pwa` (Workbox)
- **Deployment:** Vercel + Supabase

---

## 3. Data Model

### `categories`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | `auth.users` |
| name | Text | |
| icon | Text | Lucide icon name, optional |
| created_at | Timestamptz | |

### `expenses`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | `auth.users` |
| category_id | UUID FK | `categories` |
| amount | Numeric | |
| currency | Enum | UAH, USD, EUR |
| description | Text | optional |
| is_recurring | Boolean | default false |
| created_at | Timestamptz | |
| updated_at | Timestamptz | auto-updated via trigger |

### `income` _(new)_
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | `auth.users` |
| source | Text | e.g. "Salary", "Freelance" |
| amount | Numeric | |
| currency | Enum | UAH, USD, EUR |
| description | Text | optional |
| created_at | Timestamptz | |

### `budgets` _(new)_
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | `auth.users` |
| category_id | UUID FK | `categories` |
| monthly_limit | Numeric | |
| currency | Enum | UAH, USD, EUR |
| created_at | Timestamptz | |

All tables use Supabase RLS — users can only access their own rows.

---

## 4. Features

### 4.1. Authentication
- Google OAuth only. No email/password.
- On first login, auto-provision default categories: Food, Transport, Rent, Coffee, Entertainment, Server Costs.

### 4.2. Expense Entry
- Speed-entry form: Amount → Currency → Category → Description (optional) → Save.
- Recurring flag for subscriptions.

### 4.3. Transactions Page
- Full table with date, category, description, amount columns.
- Pagination (server-side).
- Filter by category.
- Inline edit and delete per row.

### 4.4. Income Tracking _(new)_
- Dedicated income entry form: Amount → Currency → Source → Description (optional) → Save.
- Income history table (similar to Transactions).
- Income is displayed in Analytics as a contrast to expenses.

### 4.5. Budgets _(new)_
- Set a monthly spending limit per category.
- Analytics page shows Budget vs. Actual bar chart.
- Visual indicator (progress bar or color) when a category is nearing or over budget.

### 4.6. Analytics
- Date-range picker persisted in URL search params (TanStack Router).
- **Donut chart:** expense distribution by category.
- **Bar chart:** chronological spending (daily if range < 2 months, monthly otherwise).
- **Budget vs. Actual bar chart:** side-by-side comparison per category _(after budgets are added)_.
- Total spent and total income for the selected range.

### 4.7. Settings
- Category manager: add, rename, delete.
- Budget manager: set/edit monthly limits per category.
- CSV export (all expenses) and CSV import (bulk upload).

### 4.8. PWA + Offline Cache _(new)_
- `manifest.json` for installable app (no browser chrome).
- Workbox service worker caches the shell + recent data so the app loads and is usable offline.
- Offline state shows the last-synced data clearly labeled as cached.

### 4.9. Encrypted Local State _(new)_
- Sensitive data written to `localStorage` / `IndexedDB` (for offline cache) is encrypted at rest using the Web Crypto API (AES-GCM).
- Encryption key is derived from the user's Supabase session token so no separate passphrase is needed.
- On session expiry or sign-out, the local cache is wiped.

### 4.10. Profile
- Displays Google avatar, name, email.
- Sign-out button.

---

## 5. Out of Scope
- Bank synchronization or open banking APIs.
- Multi-currency auto-conversion (MonoBank/NBU).
- AI-powered features (forecasting, auto-categorization).
- Smart text parsing ("50 coffee").
- Keyboard shortcuts / command palette.
- Haptic feedback.
- Net worth tracking or Sankey diagrams.

---

## 6. Roadmap

### Done
- [x] Google OAuth + route guards
- [x] Expense entry (SpeedEntry form)
- [x] Category management (create, rename, delete)
- [x] Transactions page (paginated table, edit, delete)
- [x] Analytics (donut chart, bar chart, date-range filter)
- [x] CSV import/export
- [x] Profile page
- [x] 404 page

### Phase 2 — Data Completeness
- [ ] Default category provisioning on first login
- [ ] Income tracking (table, entry form, analytics integration)
- [ ] Budget system (set limits, budget vs. actual chart)
- [ ] Zod-backed form validation + `sonner` toast notifications

### Phase 3 — PWA & Privacy
- [ ] `vite-plugin-pwa` setup + `manifest.json`
- [ ] Workbox offline cache strategy (shell + recent data)
- [ ] Encrypted local state (Web Crypto API, AES-GCM, session-derived key)
- [ ] Cache wipe on sign-out

---

## 7. UI Principles
- Mobile-first. Thumb-reachable primary actions.
- Typography and whitespace over heavy borders or cards.
- Monochromatic palette with a single accent color.
- No modals for destructive actions — inline confirmation only.
