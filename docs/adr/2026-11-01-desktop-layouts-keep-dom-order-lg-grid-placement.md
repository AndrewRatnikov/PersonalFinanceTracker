# Desktop layouts keep the phone DOM order and place cells with lg-only grid classes

- **Status:** Accepted
- **Date:** 2026-11-01
- **Source:** orchestrator run `run_20261101_160957` (one shared page width and desktop layouts; Architect decision, the task required both a new desktop arrangement and an unchanged phone order)
- **Code:** `src/routes/index.tsx`, `src/routes/analytics.tsx`

## Context

The task wanted multi-column desktop arrangements for the Dashboard and Analytics while phones keep exactly the order they have today. The desktop pairing of cells differs from the phone order.

## Decision

The DOM order stays as it was on phones. Below `lg` the pages are a single `flex flex-col gap-8` column. From `lg`, placement is done with CSS only: the Dashboard container is `lg:grid lg:grid-cols-3 lg:items-start`, with the side column on `lg:col-start-3 lg:row-start-1` and the main area on `lg:col-span-2 lg:col-start-1 lg:row-start-1`. Analytics is `lg:grid lg:grid-cols-2`, and each chart cell gets `lg:order-1` to `lg:order-6`, with full-width cells using `lg:col-span-2`. Between `md` and `lg` the Dashboard stays one column, because two columns of about 336 px squeeze the three cards of `BudgetSummaryCard`.

## Alternatives considered

- **Reorder the DOM to the desktop order.** Rejected: it changes the phone order.
- **Render two layouts and hide one with `lg:hidden`.** Rejected: duplicate test ids and double-mounted queries and forms.
- **A `useIsDesktop` JS switch at `lg`.** Rejected: more code and a first-render flash for a problem CSS solves.

## Consequences

Phones are untouched and nothing is mounted twice. At `lg` the visual order differs from the DOM and focus order; accepted because the affected cells are charts and summary cards with few focus stops. New cells on these pages must pick an explicit `lg:` placement. The Analytics "Over time" card uses `flex-1` and can grow to the row height when paired with a taller cell; revisit if it looks too tall.
