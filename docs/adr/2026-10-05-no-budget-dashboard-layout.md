# Without a budget, the month figures live in the dashboard hero, and `BudgetSummaryCard` only appears once a budget is set

- **Status:** Accepted. Supersedes the 2026-10-04 layout from `run_20261004_215444`.
- **Date:** 2026-10-05
- **Source:** orchestrator runs `run_20261004_215444` (first attempt) and `run_20261005_205735` (final)
- **Code:** `src/components/index/DashboardSummarySection.tsx`, `DashboardSummarySection.test.tsx`

## Context

With no budget set, the dashboard hero showed an Income / Expenses / Net grid, and `BudgetSummaryCard` directly below it showed the same three numbers again. The goal was that each month figure appears **once**.

## Decision

- **First attempt (2026-10-04, reversed):** remove the grid from the hero and keep `BudgetSummaryCard`. The hero became a card holding only the "Set up a budget" link.
- **Final (2026-10-05):** restore the original hero grid (Income / Expenses / Net, net in red when negative, then the "Set up a budget in Settings → Budget" link). Render `BudgetSummaryCard` **only when a budget is set** (`leftToSpend !== null`). With a budget, the hero shows "Left to spend" and the daily allowance, and the month figures come from `BudgetSummaryCard`.
- The second section is rendered only when it has content (a budget, or a "Not included" note), so the `gap-8` column never gets an empty gap.

## Consequences

- Each month figure appears exactly once in both states. Tests assert this by counting occurrences of each value in the section's text.
- The no-budget hero carries the headline numbers, so a new user sees their month at the top without setting up a budget first.
- `DashboardSummary.net` is still part of the data model and is used by the no-budget hero.
