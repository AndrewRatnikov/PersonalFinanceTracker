# Plan: Analytics Dashboard Enhancement

> Source PRD: `docs/prd-analytics-enhancement.md`

## Architectural Decisions

Durable decisions that apply across all phases:

- **Route**: All new charts live inside the existing `/analytics` route. No new top-level route is introduced.
- **URL / Search Params**: The existing `from` / `to` search-param pattern (validated in `AnalyticsSearch`) is extended with a `view` param (e.g. `?view=cashflow`) to let users deep-link to a specific chart tab.
- **Data fetching**: All aggregation happens server-side via TanStack Start `createServerFn` handlers, following the same pattern as `getRangeAnalytics`. New server functions are added to `src/lib/analytics.ts` (or a sibling file if it grows too large).
- **Schema — New tables**:
  - `income(id, user_id, amount, currency, source, created_at)` — manual income entries.
  - `budgets(id, user_id, category_id, amount, currency, period_start)` — one row per category per month.
- **Key domain models** (new types added to `src/lib/domain.ts`):
  - `IncomeEntry` — mirrors the `income` table row.
  - `BudgetEntry` — mirrors the `budgets` table row.
  - `NetWorthPoint { date, cumulative }` — computed series for the area chart.
  - `SankeyData { nodes, links }` — Recharts-compatible Sankey input.
- **Chart library**: Stay with **Recharts** (already used). The Sankey diagram requires the `recharts` `Sankey` component which ships with v2+; confirm the installed version supports it before Phase 4.
- **AI / forecasting**: Implemented as a separate, opt-in server function that uses a simple linear-regression model on historical data. No external LLM API calls in the first iteration — purely statistical, keeping it free-tier compatible.
- **Styling**: All new chart cards follow the existing `bg-card/50 backdrop-blur-sm` pattern and use the same `hsl(var(--...))` CSS variable palette. No new design tokens are introduced.
- **Testing**: Aggregation logic is unit-tested in isolation (pure functions only). Visual/interactive behaviour is verified manually in the browser.

---

## Phase 1: Income Entry — Data Layer + Minimal UI

**User stories**: Story 1 (line chart needs income data), Story 4 (Sankey needs income sources)

### What to build

Add the `income` Supabase table with RLS, then expose two server functions — one to list income for a date range and one to create an entry. Wire up a minimal "Add Income" form on the Analytics page (temporarily below the existing charts) so income entries can be created and verified end-to-end. No new chart yet — this phase is purely about having real income data flowing through the system.

### Acceptance criteria

- [ ] `income` table exists in Supabase with RLS policies (user can only read/write their own rows).
- [ ] `getIncomeForRange({ from, to })` server function returns an array of `IncomeEntry` for the authenticated user.
- [ ] `createIncome({ amount, currency, source })` server function inserts a row and returns the created entry.
- [ ] "Add Income" form on `/analytics` submits successfully and the new entry appears in the network response on the next loader refresh.
- [ ] No TypeScript errors are introduced.

---

## Phase 2: Spending vs. Income Line Chart

**User stories**: Story 1 — "I want to see my income and expenses tracked on a single line chart"

### What to build

Extend `getRangeAnalytics` (or add a sibling server function) to also return a day-bucketed income series alongside the existing expenses timeline. Build a `TrendingLineChart` component that renders both series — expenses and income — as two `Line` elements on a shared `LineChart`. Mount it in the Analytics page beneath the existing Donut and Bar charts, respecting the active date range from URL params.

### Acceptance criteria

- [ ] Server returns `incomeTimeline: Array<{ date, label, total }>` appended to `AnalyticsRangeSummary` (or a new response type).
- [ ] `TrendingLineChart` renders two labeled lines: "Expenses" and "Income", with distinct colors from the existing palette.
- [ ] Tooltip shows both values for each date point.
- [ ] Chart correctly reflects the active `from` / `to` date range from the URL.
- [ ] Empty state (no income or no expenses) is handled gracefully without crashes.

---

## Phase 3: Budget System — Data Layer + Budget vs. Actual Bar Chart

**User stories**: Story 2 — "I want to see a Budget vs. Actual bar chart"

### What to build

Add the `budgets` table to Supabase. Expose a `getBudgetsForRange` server function that returns budget limits grouped by category. Build a `BudgetVarianceBarChart` component that renders side-by-side bars (Budget vs. Actual) for each category using the existing `categoryBreakdown` data already in the loader. Add a minimal "Set Budget" UI to the Settings page (or inline on Analytics) so users can enter a monthly limit per category.

### Acceptance criteria

- [ ] `budgets` table exists in Supabase with RLS.
- [ ] `getBudgetsForRange` returns `Array<{ categoryId, categoryName, budgeted, actual }>`, merging budget rows with the existing expense aggregation.
- [ ] `BudgetVarianceBarChart` renders grouped bars; "over budget" bars are visually distinct (e.g. a destructive/red fill).
- [ ] Budget amounts are editable via a form; changes persist and are reflected on next page load.
- [ ] If no budget is set for a category, that category is omitted from the chart (not shown as zero).

---

## Phase 4: Cash Flow Sankey Diagram

**User stories**: Story 4 — "I want to see how my income flows into expense categories"

### What to build

Add a `getCashFlowSankey` server function that aggregates income (by source) and expenses (by category) for the selected range and returns a `SankeyData` shape compatible with Recharts' `<Sankey>` component. Build a `CashFlowSankey` chart component and add it to the Analytics page under a `?view=cashflow` tab or collapsible section. Each "node" is either an income source or an expense category; each "link" has a value equal to the proportionally allocated flow.

### Acceptance criteria

- [ ] Recharts version in `package.json` supports the `<Sankey>` component; if not, a compatible version is installed.
- [ ] `getCashFlowSankey` returns correctly shaped `{ nodes: [], links: [] }` data from the server.
- [ ] `CashFlowSankey` renders without errors for the selected date range.
- [ ] Node labels (income sources and expense categories) are legible on mobile widths.
- [ ] If total income is zero, the component renders an empty-state card rather than crashing.

---

## Phase 5: Net Worth Area Chart with Statistical Forecast

**User stories**: Story 3 — "I want to see an Area chart of my net worth growth with AI-embedded forecasting"

### What to build

Add a `getNetWorthSeries` server function that accumulates `income - expenses` over time to produce a `Array<NetWorthPoint>`. Optionally appends a few forecast data points using a simple linear-regression extrapolation (pure TS, no external API). Build a `ForecastingAreaChart` component that renders a filled `AreaChart` with two `Area` elements: one for historical data and one (dashed or lower opacity) for the projected continuation. Mount it on the Analytics page.

### Acceptance criteria

- [ ] `getNetWorthSeries` returns a chronologically sorted array of `{ date, cumulative }` points.
- [ ] Forecast points are clearly distinguishable from historical points (e.g. dashed stroke or lower fill opacity).
- [ ] The number of forecast steps is configurable (default: 7 days or 1 month, depending on range granularity).
- [ ] The chart gracefully handles ranges where income data is absent (treats income as 0 for those days).
- [ ] No external API keys or paid services are required.

---

## Phase 6: Analytics Page Layout & Navigation Polish

**User stories**: All 5 stories — this phase ensures all charts are discoverable and the page feels cohesive.

### What to build

Introduce a tab or segmented-control navigation on the Analytics page (e.g. "Overview", "Cash Flow", "Net Worth", "Budgets") driven by a `view` URL search param. The existing Donut + Bar charts remain on the default "Overview" tab. All new charts from Phases 2–5 land in their respective tabs. Ensure the date-range filter persists across tab switches (it's already in the URL, so this should be automatic).

### Acceptance criteria

- [ ] A tab bar (or equivalent) renders at the top of the chart area with labels for each view.
- [ ] Switching tabs updates `?view=` in the URL without triggering a full data reload.
- [ ] The active date range is preserved when switching tabs.
- [ ] All four views render their charts in an empty state when no data is available for the range.
- [ ] The page layout remains within `max-w-xl mx-auto` and works on mobile viewports.
