# localDb.ts is split into layered src/lib/db/ modules behind an unchanged barrel that db files never import

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** orchestrator run `run_20261120_231529` (split `localDb.ts` into modules; the task came from `plans/split-localdb-orchestrator-prompt.md` and item 3 of the project review)
- **Code:** `src/lib/localDb.ts`, `src/lib/db/context.ts`, `src/lib/db/personal.ts`, `src/lib/db/handles.ts`, `src/lib/db/layout.test.ts`, `src/lib/localDb.exports.test.ts`, `src/lib/cloud/guards.test.ts`

## Context

`src/lib/localDb.ts` had grown to 4,574 lines holding the store, the vault key, space contexts, every domain (expenses, categories, income, budgets, recurring, sync, spaces, moves) and the Personal-space wrappers. It was hard to navigate and review. About 50 test files mock `'@/lib/localDb'`, `spaces/spaceDb.ts` imports it as a namespace, and every caller uses that path, so the public surface and the mock semantics had to stay exactly as they were. The change had to be a verbatim move: no behaviour, caller or dependency changes.

## Decision

- The code lives in 22 files under `src/lib/db/`, one per domain, in layers (lowest first): 0 `context`; 1 `records`, `revs`, `storage`; 2 `events`; 3 `settings`, `maintenance`; 4 `expenses`, `categories`, `income`, `budgets`, `entryConversion`; 5 `recurringOccurrences`, `recurring`; 6 `lifecycle`, `sync`, `syncApply`, `rekey`, `spaces`, `move`; 7 `personal`; 8 `handles`. A file imports only from its own or a lower layer, with no import cycles.
- `src/lib/localDb.ts` is only a header comment plus explicit named re-exports (no `export *`, no code): the same public API as before (89 runtime names, 15 types), minus the dead `ENABLE_SUPABASE_SYNC` stub. Internal helpers that db files export to each other are not re-exported.
- Files in `src/lib/db/` never import the barrel. A `vi.mock('@/lib/localDb')` therefore affects only callers outside the folder, as it did when everything was one file. Re-exporting from `db/context` still runs `setKeyringLoader(loadKeyring)` on import of the barrel.
- A file may not exceed 700 lines; two optional files (`recurringOccurrences`, `syncApply`) exist to stay under it.
- Where the section order in the old file would create a cycle, six helpers sit in a lower file than their old section: `readStore` and `META_SETTINGS_KEY` in `context`, `stampWritten` and the local/Family change listeners in `storage`, `asObject` in `revs`, `liveCategories` in `categories`.
- `src/lib/db/layout.test.ts` enforces the 22-file list, no barrel import, no cycle or upward edge, the 700-line limit, and that nothing outside `localDb.ts` and `src/lib/db` imports a `lib/db` path. `src/lib/localDb.exports.test.ts` pins the runtime export list and type surface. The sync guard in `src/lib/cloud/guards.test.ts` covers `localDb.ts` and every db file.
- Moved code is verbatim apart from imports and added `export`s. One departure: `_key` is `export let` in `context.ts`, and `rekeyLiveData` calls a new `replaceLocalDbKey(key)` there instead of assigning `_key`, because an imported binding cannot be assigned (TS2632). It swaps the key without clearing the keyring, like the original line.
- New data functions follow the pattern in `CLAUDE.md`: `xIn(ctx, ...)` in the matching domain file, the Personal wrapper in `db/personal.ts`, the member in `db/handles.ts`, the re-export in the barrel.

## Alternatives considered

- **A `src/lib/localDb/` folder with `index.ts`**, as the project review suggested. Rejected: the `'@/lib/localDb'` path would depend on removing the file, and the test mocks and the namespace import in `spaces/spaceDb.ts` rely on it.
- **`export *` in the barrel.** Rejected: internal helpers would leak into the public API and the mock surface.
- **Db files importing the barrel.** Rejected: a mock of `'@/lib/localDb'` would then also replace calls inside the db layer, changing today's mock semantics, and it would create cycles.
- **Keeping the literal section-to-file mapping.** Rejected: it produces cycles (context/storage, revs/settings, expenses/categories, a storage-to-events back edge). Moving the six helpers fixed this without editing code.
- **Calling `unlockLocalDb` from `rekeyLiveData` to replace the key.** Rejected: it clears the keyring, a behaviour change.

## Consequences

- Each file is small enough to review, and the layer rules are checked by tests rather than by habit.
- The barrel is an explicit list, so adding a public function means editing it too. A forgotten re-export fails the exports test.
- `_key` is a live binding; readers in other files see updates, and only `context.ts` assigns it. `vi.resetModules()` in the sync simulations re-evaluates every db module, so each simulated device keeps its own singletons.
- Revisit the 700-line limit and the layer list if `spaces.ts` (585 lines, the largest) or another file nears the limit.
- Out of scope and noted for follow-up rather than changed: oddities found while moving (for example the `getAllExpenses` TODO).
