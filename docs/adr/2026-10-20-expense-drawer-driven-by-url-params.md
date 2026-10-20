# Expense add/edit in one drawer driven by URL params

- **Status:** Accepted
- **Date:** 2026-10-20
- **Source:** orchestrator run `run_20261020_064158` (fast add/edit expense drawer; the task asked for URL state, the param design is the Architect's)
- **Code:** `src/components/transactions/ExpenseDrawer.tsx`, `src/routes/transactions.tsx`, `src/lib/expenseDraft.ts`, `public/manifest.json`, `src/routes/index.tsx`

## Context

Expenses could be added only from the dashboard Quick Add, and edited only inline in the table through `ExpenseRowEditor`. The run needed a full add/edit form on the Transactions page, reachable from a home-screen shortcut and from links, and closable with the phone's back button. If the vault is locked when such a link is opened, the form has to appear after unlock. Data routes stay unmounted while the vault is locked, so any URL state survives the lock screen.

## Decision

One component, `ExpenseDrawer` (a Radix `Sheet`: bottom below `sm`, right from `sm`), handles both add and edit. `ExpenseRowEditor.tsx` is deleted. Its date rule (an unchanged date passes `createdAt` through, `buildCreatedAt`) moved unchanged to `src/lib/expenseDraft.ts`.

Whether the drawer is open is decided by the `/transactions` search params:

- `?add=expense` opens add mode. Optional `category`, `amount`, `currency`, `description` prefill it, and are read only together with `add=expense`.
- `?edit=<expenseId>` opens edit mode for that expense from the already-loaded list. A valid `edit` wins and is returned alone.
- `validateTransactionsSearch` in `src/lib/expenseDraft.ts` is the route's `validateSearch`. It drops anything invalid: unknown currency codes, non-positive or malformed amounts (`,` is accepted as decimal separator), over-long descriptions, empty ids.
- Opening navigates with a normal history push, so Back closes the drawer. Closing navigates to empty search with `replace: true`.
- An unknown `edit` id shows the toast "Transaction not found" once, after the expenses query has loaded, and drops the param. Closing a drawer marks its edit id as already judged, so a record deleted from its own drawer does not trigger that toast.
- `public/manifest.json` has a shortcut "Add expense" pointing to `/transactions?add=expense`.

`ExpenseDrawer` receives `categories`, `mainCurrency` and `entries` as props, not by querying itself. The dashboard caches expenses under `['expenses', from, to]` and Transactions under `['expenses']`, and the suggestions work on data already decrypted by each page. The dashboard's repeat-last "..." / long-press opens the same drawer locally, with component state instead of the URL, so the user stays on the dashboard.

## Alternatives considered

- **Local React state for open/close.** Back would not close the drawer, and neither links nor the manifest shortcut could open it. Rejected.
- **A separate `/transactions/new` route.** Needs another route, a regenerated route tree and a precache entry, and still does not give edit-in-place. Rejected.
- **Drawer queries its own data.** Would load a second copy of expenses under a different key. Rejected for props.

## Consequences

- Back button, deep links, the PWA shortcut and "open after unlock" need no extra code.
- Any link can prefill an expense (`amount`, `category`, ...). Input is sanitised, but a link can set a currency, which is why a currency given in the URL counts as an explicit choice and is not overridden by the category default.
- Every test that renders the Transactions page must stub `Route.useSearch()` and `Route.useNavigate()`.
- The dashboard drawer is not URL-driven, so Back there does not close it.
- Possible follow-up: if the Save button is still hidden by the on-screen keyboard on some Android browsers, add `interactive-widget=resizes-content` to the viewport meta in `src/routes/__root.tsx`.
