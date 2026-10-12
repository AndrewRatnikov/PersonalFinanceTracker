# Moving an expense to another month writes the new chunk before removing it from the old one

- **Status:** Accepted
- **Date:** 2026-09-29
- **Source:** orchestrator run `run_20260929_221728` (inline editing of expenses)
- **Code:** `src/lib/localDb.ts` (`updateExpense`)

## Context

Expenses are stored in encrypted month chunks (`expenses_YYYY_MM`, UTC month). Editing an expense's date can move it to another chunk, which takes two separate IndexedDB writes.

## Decision

- `updateExpense(id, originalCreatedAt, patch)` validates everything (unknown id, invalid date, unknown category) **before any write**.
- For a cross-month move, it **first appends to the new chunk, then removes the record from the old one**. A crash in between can only duplicate the record, never lose it. The id never changes.
- Since Phase 1 (`run_20261007_212533`), the whole read-modify-write holds the write lock on both chunk keys, acquired in sorted order.
- When the date in the inline editor is unchanged, `createdAt` is passed through untouched, so an edit never moves an expense by accident across a timezone boundary. When the date is changed, the original local time of day is kept.

## Alternatives considered

- **Remove first, then add.** Rejected: a failure in between would lose the expense.
- **One `setMany` transaction for both chunks.** Not done in this run. It would make the move atomic and remove the duplicate window. It's a reasonable follow-up, since `setMany` is already used for migration and restore.

## Consequences

- In the rare failure case, the user may see the expense twice and have to delete one copy.
