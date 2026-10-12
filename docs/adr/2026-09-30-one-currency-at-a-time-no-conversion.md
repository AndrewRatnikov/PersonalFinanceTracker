# Totals are computed in one currency at a time; other currencies are listed, not converted

- **Status:** Accepted
- **Date:** 2026-09-30 (dashboard), extended to Analytics on 2026-10-05
- **Source:** orchestrator runs `run_20260930_210012` (dashboard redesign) and `run_20261005_215952` (code review 2026-10-05, finding #2)
- **Code:** `src/lib/dashboardSummary.ts` (`computeDashboardSummary`), `src/lib/localAnalytics.ts` (`computeRangeAnalytics(input, currency)`), `src/components/index/DashboardSummarySection.tsx`, `src/routes/analytics.tsx`

## Context

Expenses, income and budgets each carry a `currency` (UAH, USD, EUR). The old dashboard and Analytics summed raw amounts across currencies and labelled the result as UAH, so 100 USD + 100 UAH showed as "200 UAH". Budgets in one currency were also compared with spend in another.

## Decision

- Every total is computed for **one currency**. On the dashboard that is `baseCurrency` (default `UAH`). On Analytics it is a page-local currency selector (native `<select>`, default `UAH`, not stored in the URL or storage).
- Entries in other currencies are **left out of the totals** and reported in a muted line, e.g. "Not included: 120 USD, +50 EUR", built from an `excluded: Array<{ currency, expenses, income }>` list.
- Budgets only count when their currency is the selected one, so a USD budget is never compared with UAH spend.
- The dashboard numbers come from a pure `computeDashboardSummary` with the current time passed in as `now` (no `Date.now()` inside), so month boundaries and pacing can be unit-tested.

## Alternatives considered

- **Convert to one currency with exchange rates.** Rejected (out of scope). It needs a rate source, which means a network call. That conflicts with the local-only, offline free tier, and a stale rate would make the numbers quietly wrong.
- **Keep summing and label it "mixed".** Rejected: the total would still be meaningless.

## Consequences

- A user who spends in several currencies sees each currency's totals separately and must switch currency on Analytics.
- `formatExcluded` is duplicated in `DashboardSummarySection.tsx` and `analytics.tsx` (a deliberate trade-off, so the dashboard component didn't have to change).
- If conversion is ever added, it belongs in these two pure modules, behind an explicit rate source.
