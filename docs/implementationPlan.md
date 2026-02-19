# Implementation Plan: Phase 1 (The Core)

This document outlines the detailed steps to implement the core of **MinimaSpend** using **TanStack Start**, **Supabase**, and **Tailwind CSS**.

---

## 1. Project Initialization & Infrastructure

### 1.1. TanStack Start Setup

- [x] Initialize TanStack Start project using the official template (Vite-based).
- [/] Install core dependencies:
  - [x] `@tanstack/react-start`
  - [x] `tailwindcss`
  - [x] `lucide-react`
  - [ ] `zod` (for schema validation)
  - [ ] `recharts` (for analytics visuals - from PRD)
  - [ ] `sonner` (for notifications)
- [x] Configure `vite.config.ts` (Already exists with Tailwind support).

### 1.2. Supabase Integration

- [x] Initialize Supabase client in `src/lib/supabase.ts`.
- [x] Create `.env` file with `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- [x] **Database Schema Execution**:
  - Run SQL in Supabase Editor to create `categories` and `expenses` tables.
  - Apply RLS (Row Level Security) policies for user isolation.
  - Setup triggers for `updated_at` (See detail in `src/lib/supabase.ts` or PRD).
  - _Detail:_
    - `categories`: `id`, `user_id`, `name`, `icon`, `created_at`.
    - `expenses`: `id`, `user_id`, `category_id`, `amount`, `currency` (UAH/USD/EUR), `description`, `is_recurring`, `created_at`, `updated_at`.
- [x] **Setup Google OAuth**:
  - Configure Google Cloud Project (OAuth Consent + Client IDs).
  - Enable Google Provider in Supabase Dashboard.
  - Set Redirect URLs: `http://localhost:3000/auth/callback` and Supabase Auth callback.

---

## 2. Authentication & Guarding

### 2.1. Auth State Management (Detailed)

1.  **Dependencies**:
    - `@supabase/ssr`: For cookie-based auth in SSR/Server Functions.
    - `cookie`: (Optional) specifically for manual cookie parsing if needed.

2.  **Supabase Client (`src/lib/supabase.ts`)**:
    Split into browser and server client creators.

    ```typescript
    import {
      createBrowserClient,
      createServerClient,
      parseCookieHeader,
    } from '@supabase/ssr'

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

    export const createBrowserSupabaseClient = () =>
      createBrowserClient(supabaseUrl, supabaseAnonKey)

    export const createServerSupabaseClient = (
      cookieString: string,
      setCookie: (name: string, value: string, options: any) => void,
    ) =>
      createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            return parseCookieHeader(cookieString).map((cookie) => ({
              name: cookie.name,
              value: cookie.value ?? '',
            }))
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              setCookie(name, value, options),
            )
          },
        },
      })
    ```

3.  **Auth Context (`src/hooks/useAuth.tsx`)**:
    A React context to provide user state globally for browser-side renders once loaded.

    ```tsx
    import { createContext, useContext, useEffect, useState } from 'react'
    import { User } from '@supabase/supabase-js'
    import { createBrowserSupabaseClient } from '../lib/supabase'

    export const AuthContext = createContext<{
      user: User | null
      isLoading: boolean
    }>({ user: null, isLoading: true })

    export const AuthProvider = ({
      children,
    }: {
      children: React.ReactNode
    }) => {
      const [user, setUser] = useState<User | null>(null)
      const [isLoading, setIsLoading] = useState(true)
      const supabase = createBrowserSupabaseClient()

      useEffect(() => {
        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
          setUser(session?.user ?? null)
          setIsLoading(false)
        })
        return () => subscription.unsubscribe()
      }, [supabase])

      return (
        <AuthContext.Provider value={{ user, isLoading }}>
          {children}
        </AuthContext.Provider>
      )
    }

    export const useAuth = () => {
      const context = useContext(AuthContext)
      if (!context) {
        throw new Error('useAuth must be used within an AuthProvider')
      }
      return context
    }
    ```

4.  **Server Session Logic (`src/lib/auth.ts`)**:
    Server Functions to validate sessions on the server and to exchange OAuth codes using TanStack's native cookie utilities.

    ```typescript
    import { createServerFn } from '@tanstack/react-start'
    import { getRequest, setCookie } from '@tanstack/react-start/server'
    import { createServerSupabaseClient } from './supabase'

    export const getServerUser = createServerFn({ method: 'GET' }).handler(
      async () => {
        const req = getRequest()
        if (!req) return null

        const supabase = createServerSupabaseClient(
          req.headers.get('cookie') ?? '',
          (name, value, options) => {
            setCookie(name, value, options as any)
          },
        )
        const {
          data: { user },
        } = await supabase.auth.getUser()
        return user
      },
    )

    export const exchangeAuthCode = createServerFn({ method: 'POST' }).handler(
      async (ctx: any) => {
        const code = ctx.data as string
        const req = getRequest()
        if (!req) return null

        const supabase = createServerSupabaseClient(
          req.headers.get('cookie') ?? '',
          (name, value, options) => {
            setCookie(name, value, options as any)
          },
        )

        await supabase.auth.exchangeCodeForSession(code)
      },
    )
    ```

5.  **Router Integration (`src/routes/__root.tsx`)**:
    Guarding routes securely by awaiting the `getServerUser` Server Function during SSR, prior to returning the context to child components.

    ```tsx
    export const Route = createRootRouteWithContext<AuthContext>()({
      beforeLoad: async ({ location }) => {
        // Call the server function to validate the user session securely.
        const user = await getServerUser()
        const isLoading = false

        if (
          !user &&
          !location.pathname.startsWith('/login') &&
          !location.pathname.startsWith('/auth/callback')
        ) {
          throw redirect({ to: '/login', search: { redirect: location.href } })
        }

        // Return the updated context to propagate the user down to child routes.
        return { auth: { user, isLoading } }
      },
      // ... head, scripts, devtools omitted for brevity
    })
    ```

### 2.2. Login View

- [x] Create `/login` route.
- [x] Build a minimalist "Speed-Login" page with a single "Login with Google" button.
- [x] Implement the redirect logic after successful authentication.

### 2.3. Route Guarding

- [x] Implement a root-level check in `src/routes/__root.tsx` to redirect unauthenticated users to `/login`.

---

## 3. Data Model & Routing

### 3.1. File-Based Routing Structure

- [x] **Cleanup**: Remove demo routes and experimental data files (`src/routes/demo/*`, `src/data/demo.*`).
- [ ] `src/routes/index.tsx`: Rewrite for the Daily Dashboard / Entry point.
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
