# "Remove data from this device" clears the store first, then deletes the database and reloads

- **Status:** Accepted
- **Date:** 2026-10-08
- **Source:** orchestrator run `run_20261008_064656` (Phase 3, no-account mode, CONTRACT_GAP 4 and Risks)
- **Code:** `src/lib/localWipe.ts` (`wipeLocalData`), `reloadToHome()`, `RemoveDataDialog`
- **Spec:** `docs/free-tier-spec.md` §2.5

## Context

The wipe must leave no data behind. `indexedDB.deleteDatabase('minima-local')` is **blocked while any connection is open**, and `idb-keyval` never closes its connections. An awaited delete could hang, and a delete queued behind an open connection might never run.

## Decision

1. Lock the vault.
2. **Clear the IndexedDB store** (this removes the data even if the delete never completes).
3. Remove every `minima_*` localStorage key.
4. Post `wiped` on the sync channel.
5. Request `deleteDatabase` **without awaiting it**.
6. Do a **full reload** to `/` (`location.replace('/')`), in this tab and in every tab that receives `wiped`. The reload closes the `idb-keyval` connections so the queued delete can complete, and it drops everything held in memory.

## Consequences

- If the browser drops the queued delete during navigation, an **empty** database remains. That is still a complete wipe of the data.
- The wipe is a full page reload, not an in-app navigation, which is fine for a destructive, rare action.
