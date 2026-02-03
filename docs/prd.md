# PRD: MinimaSpend (Expense Tracker PWA)

## 1. Executive Summary

MinimaSpend is a minimalist, mobile-first Progressive Web App (PWA) built for developers who want a frictionless way to track spending. The app focuses on "flexible time-traveling" analytics, allowing users to view summaries across any custom timeframe.

## 2. Technical Stack (The "Free-Tier" Stack)

- **Framework:** TanStack Start (React + TanStack Router + Vite)
- **Styling:** Tailwind CSS (Minimalist/Dark Mode support)
- **Backend/Auth:** Supabase (via Server Functions + Google OAuth)
- **Data Management:** TanStack Query (Integrated with TanStack Start)
- **Charts:** Recharts
- **Deployment:** Vercel (using the `vercel` adapter) + Supabase (DB)

---

## 3. Data Model (PostgreSQL)

### 3.1. Categories Table

Allows users to define their own labels.

- `id`: UUID (PK)
- `user_id`: UUID (FK to Auth)
- `name`: String (e.g., "Coffee", "Server Costs")
- `icon`: String (optional Lucide icon name)
- `created_at`: Timestamp

### 3.2. Expenses Table

- `id`: UUID (PK)
- `user_id`: UUID (FK to Auth)
- `category_id`: UUID (FK to Categories)
- `amount`: Numeric (Decimal)
- `currency`: String (Enum: UAH, USD, EUR)
- `description`: Text (Optional)
- `is_recurring`: Boolean (For subscriptions)
- `created_at`: Timestamp (Used for flexible filtering)
- `updated_at`: Timestamp

---

## 4. Functional Requirements

### 4.1. Authentication

- **Google Login:** Primary and only entry point.
- **Auto-Provisioning:** On first login, create a set of default categories (e.g., Food, Transport) so the user isn't starting with a blank slate.

### 4.2. Expense & Category Entry

- **Manual Input:** A "Speed-Entry" form (Amount -> Currency -> Category -> Save).
- **Command-Line Entry:** Smart input that parses text like "50 coffee" into amount and category.
- **Bulk Import/Export:** CSV upload/download to handle historical data and ensure portability.
- **Category Manager:** A settings view to add, rename, or delete custom categories.

### 4.3. Flexible Analytics Engine

- **Custom Time-Frame Selector:** A date-range picker that overrides the "Monthly" default.
  - _Implementation:_ Uses TanStack Router Search Params for persistent, sharable URLs.
- **Smart Summaries:**
  - Total Spent calculation for the active range.
  - Automated currency conversion via MonoBank/NBU API (display all values in a selected "Primary" currency).
- **Visualizations:**
  - **Donut Chart:** Expense distribution by `category_id`.
  - **Bar Chart:** Chronological spending. (Logic: Group by day if range < 2 months; group by month if range > 2 months).

### 4.4. Mobile & PWA

- **App-like Feel:** No browser address bar (via `manifest.json`).
- **Offline Cache:** Allow the user to see their balance/recent history even without a connection.

---

## 5. UI/UX Principles (Minimalist)

- **Zero Friction:** The "Add Expense" button should be reachable by the thumb.
- **Typography-First:** Use high-contrast fonts and whitespace rather than heavy borders or cards.
- **Developer-First:** Keyboard shortcuts (e.g., `Cmd+K`) for desktop efficiency.
- **Tactile Feedback:** Haptic vibrations on save for the PWA experience.
- **Color Palette:** Monochromatic with one accent color (e.g., Electric Blue or Mint Green).

---

## 6. Implementation Roadmap

### Phase 1: The Core (Week 1)

- [ ] Set up TanStack Start project with Supabase & Google Auth.
- [ ] Define file-based routes (Index, Analytics, Settings).
- [ ] Build the "Add Expense" and "Add Category" forms using Server Functions.

### Phase 2: The Logic (Week 2)

- [ ] Build the History List with "Delete" and "Edit" capabilities.
- [ ] Implement Date-Range filter logic via Router Search Params (Zod validation).
- [ ] Add basic currency switching (UAH/USD/EUR).

### Phase 3: The Polish (Week 3)

- [ ] Integrate Recharts (Donut & Bar).
- [ ] Configure `vite-plugin-pwa` for installation.
- [ ] Build the CSV Import/Export tool.
