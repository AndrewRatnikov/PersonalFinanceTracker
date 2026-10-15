# Architecture Decision Records

Architecture Decision Records for MinimaSpend: one file per decision, named `YYYY-MM-DD-slug.md` after the date it was made.

The nine ADRs below were **backfilled on 2026-10-11** from the AI Orchestrator's run records (plans, PRDs and their "CONTRACT_GAP" notes) for runs between 2026-09-29 and 2026-10-10. Each was checked against the code on `orchestrator/run_20261010_185645` (`56de15c`).

What the system does is already documented in [`docs/free-tier-spec.md`](../free-tier-spec.md) and [`CLAUDE.md`](../../CLAUDE.md). These ADRs add what those files mostly leave out: **why** a choice was made, what was rejected, and where the implementation went beyond or corrected the spec.

| Date | Decision | Status |
|---|---|---|
| [2026-09-29](2026-09-29-cross-month-expense-move-order.md) | Moving an expense to another month writes the new chunk before removing it from the old one | Accepted |
| [2026-09-30](2026-09-30-one-currency-at-a-time-no-conversion.md) | Totals are computed in one currency at a time; other currencies are listed, not converted | Superseded by [2026-10-15](2026-10-15-main-currency-stored-nbu-conversion.md) |
| [2026-10-05](2026-10-05-no-budget-dashboard-layout.md) | Without a budget, the month figures live in the dashboard hero, and `BudgetSummaryCard` only appears once a budget is set | Accepted |
| [2026-10-07](2026-10-07-decrypt-errors-from-queries-and-mutations.md) | A decrypt error from any query *or* mutation opens the Data problem screen and is never retried | Accepted |
| [2026-10-07](2026-10-07-recovery-key-confirmation.md) | The vault is usable before the recovery key is saved; an unconfirmed key is tracked and confirmed with a full random group | Accepted |
| [2026-10-08](2026-10-08-backup-restore-rules.md) | A backup restore is one transaction, with explicit replace and merge rules | Accepted |
| [2026-10-08](2026-10-08-offline-navigations-fall-back-to-spa-shell.md) | Offline navigations fall back to a precached SPA shell; nothing in the service worker expires | Accepted |
| [2026-10-08](2026-10-08-remove-data-clears-store-then-reloads.md) | "Remove data from this device" clears the store first, then deletes the database and reloads | Accepted |
| [2026-10-10](2026-10-10-auto-lock-is-per-tab.md) | Auto-lock locks only its own tab; a manual lock locks every tab | Accepted |
| [2026-10-14](2026-10-14-recurring-generation-per-item-idempotent.md) | Recurring transactions are generated client-side, one atomic write per item, keyed by recurringId + occurrenceDate | Accepted |
| [2026-10-15](2026-10-15-main-currency-stored-nbu-conversion.md) | Main currency with stored per-entry conversion (NBU) | Accepted |

## Where else decisions live

- [`docs/free-tier-spec.md`](../free-tier-spec.md): the free tier's product and security decisions. These include "Decisions taken (2026-10-07)", the vault v2 key hierarchy (§4), write serialisation (§5.1), the `.minima` format (§7), CSV (§8) and income categories (§13).
- [`docs/code-review-2026-10-05.md`](../code-review-2026-10-05.md): per-finding outcomes of `run_20261005_215952`.
- `.claude/rules/testing.md`: test-setup decisions (separate `vitest.config.ts`, locale-safe assertions, native `<select>` in testable forms, no jest-dom).

Not written up as ADRs, because the spec or `CLAUDE.md` already covers them: income categories (`run_20261010_185645`, spec §13), the write lock's design (spec §5.1 and `CLAUDE.md`), and the `ENABLE_ACCOUNTS` flag (`CLAUDE.md`).

## Adding a new ADR

The orchestrator writes ADRs for its runs (stage 6d, `orch-adr-writer`). To add one by hand,
copy an existing file. Name it `YYYY-MM-DD-short-slug.md` (the date the decision was made,
lowercase kebab-case slug) and add a row to the table above.

```markdown
# <the decision, stated as a sentence>

- **Status:** Accepted | Superseded by [YYYY-MM-DD-slug](YYYY-MM-DD-slug.md)
- **Date:** YYYY-MM-DD
- **Source:** <run id, PR or discussion>
- **Code:** <main files>

## Context
## Decision
## Alternatives considered
## Consequences
```

Don't edit an accepted ADR's decision. Write a new ADR that supersedes it, and change only
the old one's Status line.
