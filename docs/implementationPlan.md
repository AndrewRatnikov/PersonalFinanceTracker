# Implementation Plan: Phase 1 (The Core)

This document outlines the detailed steps to implement the core of **MinimaSpend** using **TanStack Start**, **Supabase**, and **Tailwind CSS**.

---

## 1. Project Initialization & Infrastructure

### 1.1. TanStack Start Setup

- [ ] Initialize TanStack Start project using the official template (Vite-based).
- [ ] Install core dependencies:
  - `@tanstack/react-start`
  - `tailwindcss` + `autoprefixer` + `postcss`
  - `lucide-react` (for icons)
  - `zod` (for schema validation)
- [ ] Configure `app.config.ts` for TanStack Start and `tailwind.config.ts` for the monochromatic dark-mode theme.

### 1.2. Supabase Integration

- [ ] Initialize Supabase client in `src/lib/supabase.ts`.
- [ ] Create `.env` file with `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- [ ] **Database Schema Execution**:
  - Run SQL to create `categories` and `expenses` tables with RLS (Row Level Security) enabled.
  - Setup triggers for `updated_at` timestamps.
- [ ] Setup Google OAuth in the Supabase Dashboard and configure the redirect URLs.

---

## 2. Authentication & Guarding

### 2.1. Auth State Management

- [ ] Implement a `useAuth` hook or context that wraps the Supabase `onAuthStateChange`.
- [ ] Create a `Server Function` to validate the user session on the server side for SSR.

### 2.2. Login View

- [ ] Create `/login` route.
- [ ] Build a minimalist "Speed-Login" page with a single "Login with Google" button.
- [ ] Implement the redirect logic after successful authentication.

### 2.3. Route Guarding

- [ ] Implement a root-level check in `src/routes/__root.tsx` to redirect unauthenticated users to `/login`.

---

## 3. Data Model & Routing

### 3.1. File-Based Routing Structure

- [ ] `src/routes/index.tsx`: The Daily Dashboard / Entry point.
- [ ] `src/routes/analytics.tsx`: Donut and Bar charts with date-range filters.
- [ ] `src/routes/settings.tsx`: Category management and export/import tools.
- [ ] `src/routes/login.tsx`: Google Auth entry.

### 3.2. Auto-Provisioning Logic

- [ ] Create a `Server Function` that runs on a user's first login to check if categories exist.
- [ ] If no categories are found, bulk insert a default set (e.g., Food, Transport, Rent, Coffee).

---

## 4. "Speed-Entry" Core Features

### 4.1. Server Functions for Mutations

- [ ] `createExpense`: Validates input with Zod and inserts into Supabase.
- [ ] `createCategory`: Allows users to add custom labels.

### 4.2. Forms & Validation

- [ ] **Category Select**: A focusable, mobile-friendly category picker.
- [ ] **Amount Input**: A large, numeric-only input with currency selector (UAH/USD/EUR).
- [ ] Implement Zod-backed form validation for both manual and "Command-Line" style entries.

### 4.3. UX Polish

- [ ] Implement basic success/error toasts using a library like `sonner`.
- [ ] Add the floating "Add" button (FAB) for mobile thumb accessibility.

---

## 5. Success Criteria for Phase 1

- [ ] User can log in with Google.
- [ ] User sees default categories on first visit.
- [ ] User can successfully add an expense and see it persisted in the DB.
- [ ] Navigation between Dashboard, Analytics, and Settings is functional.
