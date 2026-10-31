# Family UX: one active space for the whole app, move as create + tombstone across spaces

- **Status:** Accepted
- **Date:** 2026-10-31
- **Source:** orchestrator run `run_20261031_094926` (Family UX: space switcher, per-space screens, move between spaces)
- **Code:** `src/lib/spaces/switcher.tsx`, `src/lib/spaces/activeSpace.ts`, `src/lib/spaces/useMoveRecords.ts`, `src/lib/localDb.ts`, `src/routes/__root.tsx`

## Context

Earlier runs made the data layer space-aware: every screen keys its queries by `useActiveSpace()` and reads through `useSpaceDb`. Nothing held the switch state, though, and `__root.tsx` always mounted `SpaceProvider` as Personal. Two things were needed: a way to show one space across the whole app, and a way for a user to move entries between Personal and Family. Each space has its own store keys, its own `rev` counter and its own key, so a move touches two independent stores that sync separately.

## Decision

**One active space per tab.** `ActiveSpaceRoot` (in `switcher.tsx`, mounted in `__root.tsx`) keeps the active space in React state and exposes it through `useSpaceSwitch()`: the held Family, whether it is read-only or paused, the member directory, `switchTo` and a drawer guard. `minima_active_space` (`activeSpace.ts`) is only the shared default used at start. The start space comes from the "Open the app in" setting (or the last used space for the shortcut). Other tabs are not notified, so switching in one tab does not switch another. With the flags off, or with no Family held, the context is the default (`family: null`) and no new query runs.

**Move is create + tombstone in one transaction.** `moveRecords({ from, to, type, ids })` in `localDb.ts` handles expenses, income and recurring items. For each live source record it:
- writes a copy into the target with the **same id**;
- maps the category by name, creating it in the target when missing;
- clears conversion fields and the member fields (`createdBy`, `updatedBy`, `paidBy`), then stamps the moving member in a Family target;
- writes a tombstone in the source.

The source data, the target data and both `meta:sync` counters go into ONE `setMany`, so a failure leaves both spaces unchanged. A recurring item keeps `handledThrough`, so it does not regenerate past occurrences in the target. Ids that are gone or already live in the target are skipped. Same-space moves are refused (`move-same-space`), as are more than `MOVE_RECORDS_MAX = 500` ids (`move-too-many`), and a read-only Family side refuses the move. The UI selects at most one page (15 rows) at a time and does not chunk.

## Alternatives considered

- **Subscribe to `subscribeActiveSpace` / `storage` events:** other tabs would switch too, which the task forbids.
- **Read `getActiveSpaceId()` on every render:** it depends on the keyring being loaded, so it flips from Personal to Family after unlock.
- **A route or URL segment per space:** needs new routes and a precache change, and breaks the shortcut.
- **Two transactions (create, then delete):** a crash between them duplicates or loses records.
- **A new id in the target:** breaks deterministic occurrence ids and the recurring idempotency check, and duplicates on a second move.
- **Re-running past occurrences of a moved recurring item in the target:** duplicates history.
- **Chunked bulk moves:** a failure part-way leaves a partial move. Unlimited ids would hold many decrypted chunks in memory in one transaction.

## Consequences

- Sync needs no new rules. The tombstone is the removal for the source's other members, and the record is the arrival for the target's, both through the normal newest-wins merge. The copy's `updatedAt` is set after any older tombstone of the same id so that it wins.
- Per-target idempotency from [2026-10-14-recurring-generation-per-item-idempotent](2026-10-14-recurring-generation-per-item-idempotent.md) still holds. Past generated records stay where they are, as that ADR's delete rule already says.
- The tombstone is a normal deletion, so the source copy is compacted by the usual tombstone retention. Moving back later is a second move with the same id.
- Authorship is not carried across: after a move the entry shows the moving member as creator and payer.
- A hard cap of 500 ids and one-page selection in the UI are the limits. Raising them means revisiting the memory use of the single transaction.
- Tabs can show different spaces. Locking, unlocking and removal of the Family still go through the shared keyring, and the guard in the context handles unsaved drawers on a switch.
