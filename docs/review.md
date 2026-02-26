MinimaSpend architecture review & improvement plan

High-level architecture

flowchart LR
  user[User] --> uiRoutes[Routes]
  uiRoutes --> rootRoute[src/routes/__root.tsx]
  uiRoutes --> dashboardRoute[src/routes/index.tsx]
  uiRoutes --> authRoutes[src/routes/login.tsx & auth.callback.tsx]

  dashboardRoute --> libDatabase[src/lib/database.ts]
  authRoutes --> libAuth[src/lib/auth.ts]

  libAuth --> supabaseClient[src/lib/supabase.ts]
  libDatabase --> supabaseClient

  supabaseClient --> supabase[Supabase Backend]





Entrypoint & routing: TanStack Start router (src/router.tsx, src/routeTree.gen.ts) with a root route shell and file-based child routes.



Server-side logic: Co-located in src/lib as TanStack createServerFn functions ([src/lib/auth.ts](src/lib/auth.ts), [src/lib/database.ts](src/lib/database.ts)), using Supabase via [src/lib/supabase.ts](src/lib/supabase.ts).



UI layer: Page routes under src/routes (__root.tsx, index.tsx, login.tsx, auth.callback.tsx) plus leaf components in src/components (Header, DashboardStats, SpeedEntryForm, RecentHistoryList).

What is good (architecturally)





Clear layering between routes, domain logic, and infrastructure





Routes delegate data fetching and mutations to lib server functions (getMonthlyExpenses, getRecentExpenses, createExpense), keeping UI components mostly presentational.



Supabase integration is centralized in [src/lib/supabase.ts](src/lib/supabase.ts), so cookie handling and client setup are not scattered.



Centralized authentication and access control





[src/routes/__root.tsx](src/routes/__root.tsx) uses beforeLoad + getServerUser to gate almost all routes, enforcing login by default.



[src/lib/database.ts](src/lib/database.ts) uses getAuthenticatedClient so every server function reuses the same auth check and Supabase client wiring.



Simple, focused features and files





Each route file has a single responsibility (dashboard data + mutations, login, OAuth callback).



Components like DashboardStats, SpeedEntryForm, and RecentHistoryList are small and composable; layout/styling is handled cleanly with Tailwind.



Modern, cohesive stack and tooling





Vite + TanStack Start + Supabase + TypeScript + ESLint/Prettier/Vitest give a strong foundation for maintainability and future growth.

What is weak / "done wrong" from an architecture & organization perspective





Overuse of any and missing domain types at boundaries





DashboardStats, SpeedEntryForm, and RecentHistoryList all accept any[] or any-typed props ([src/components/DashboardStats.tsx](src/components/DashboardStats.tsx), [src/components/SpeedEntryForm.tsx](src/components/SpeedEntryForm.tsx), [src/components/RecentHistoryList.tsx](src/components/RecentHistoryList.tsx)), and createExpense uses an identity inputValidator that just returns the raw data ([src/lib/database.ts](src/lib/database.ts)).



This means route loaders and server functions don’t define stable contracts; type errors or shape changes in Supabase results can leak all the way to the UI without compile-time protection.



src/lib/database.ts is a growing grab-bag module





It mixes different concerns: category listing, recent expense listing, monthly aggregation, and inserts (getUserCategories, getRecentExpenses, getMonthlyExpenses, createExpense) in a single file.



As features expand (budgets, recurring rules, reports, etc.), this file will become a dumping ground, making it harder to reason about dependencies and change impact.



Domain modeling is tightly coupled to Supabase table shapes





Select strings like '*, categories (name, icon)' 
in getRecentExpenses and raw amount, currency, category_id fields throughout tie the app directly to the database schema.



There are no explicit domain models (e.g. Expense, Category, MonthlySummary) that decouple the UI from storage details or allow richer in-memory invariants.



Router context and auth context are not fully aligned





getRouter initializes a context with auth: { user: null, isLoading: false } ([src/router.tsx](src/router.tsx)), while the root route’s beforeLoad returns a richer auth object based on getServerUser.



The context type is defined in __root.tsx rather than being a shared central type, and there’s no clear separation between “public routes” and “authenticated app shell” beyond the pathname checks.



Limited separation between app shell and feature areas





Header is globally mounted in the root shell, but there’s no clear sub-structure for future feature areas (e.g., settings, reports, admin) in src/routes — everything currently hangs off /.



The dashboard route index.tsx owns both read-side (loaders) and write-side (createExpense mutation) logic directly, instead of delegating mutations to a small domain/service layer.

Proposed improvement plan

1. Introduce explicit domain types and shared contracts





Goal: Replace any at key boundaries with well-defined domain models to stabilize contracts between server functions, routes, and components.



Actions:





Add a small domain types module, e.g. [src/lib/domain.ts](src/lib/domain.ts), with interfaces like Expense, Category, MonthlyExpenseSummary that reflect the logical app model (not raw Supabase rows).



Update getUserCategories, getRecentExpenses, and getMonthlyExpenses in [src/lib/database.ts](src/lib/database.ts) to map Supabase results into these domain types.



Refine component props in DashboardStats, SpeedEntryForm, and RecentHistoryList to use these types instead of any.

2. Split src/lib/database.ts by domain/bounded context





Goal: Avoid a monolithic data module and prepare for feature growth.



Actions:





Extract domain-specific modules, e.g.:





[src/lib/categories.ts](src/lib/categories.ts) for getUserCategories and any category mutations.



[src/lib/expenses.ts](src/lib/expenses.ts) for getRecentExpenses, createExpense, and future expense mutations.



[src/lib/analytics.ts](src/lib/analytics.ts) for getMonthlyExpenses and future reporting/aggregation logic.



Keep getAuthenticatedClient in a small shared file such as [src/lib/serverClient.ts](src/lib/serverClient.ts) or keep it in supabase.ts to emphasize it as infrastructure/shared server access.



Adjust routes to import from these more focused modules.

3. Strengthen server function input/output validation





Goal: Make createServerFn handlers explicitly validate input and return typed outputs.



Actions:





Replace the identity inputValidator in createExpense with a proper validator (even a simple manual check to start, or a small schema library if you choose later).



Declare explicit return types for each server function based on the new domain models (e.g., Promise<Expense[]>, Promise<MonthlyExpenseSummary[]>).



Ensure loaders in [src/routes/index.tsx](src/routes/index.tsx) use these types in their return shape so components benefit from full typing.

4. Clarify auth context and app shell boundaries





Goal: Make it clear where auth state is managed and how public vs private routes are organized.



Actions:





Extract the AuthContext type from __root.tsx into a shared module (e.g. [src/lib/authContext.ts](src/lib/authContext.ts)) and use it to type both createRootRouteWithContext and getRouter.



Consider structuring routes so that the authenticated app lives under a root like /app/* while /login and /auth/callback belong to a small public route group; this makes it easier to see which parts are gated.



Optionally, add a dedicated AuthProvider/hook for client-side auth context consumption if the app starts needing more client-only auth states.

5. Prepare the routes directory for feature growth





Goal: Keep the dashboard lean as you add more features.



Actions:





Keep src/routes/index.tsx focused on orchestrating data and rendering the main dashboard composition; move more complex domain logic into the new lib/* modules.



Introduce sub-routes when you add new sections (e.g. /categories, /reports), rather than continuing to pack everything into the root dashboard route.

These changes keep the current working behavior but improve the architecture: clearer domain boundaries, safer contracts between layers, and a routes/lib structure that will scale nicely as you add more features around spending, budgeting, and reporting.