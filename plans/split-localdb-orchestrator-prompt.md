# Orchestrator prompt: Split localDb.ts into modules

Starts from `main` at d787d5f. Item 3 of `docs/project-review-2026-11-13.md`.

```text
Split src/lib/localDb.ts (4,574 lines, about 214 top-level declarations) into smaller modules under a new folder src/lib/db/. This is a pure refactor: no behaviour change, no new features, no change for any caller. src/lib/localDb.ts stays as the only public entry point and becomes a barrel that re-exports exactly today's public API. Where this prompt is silent, prefer the option that changes less and record a CONTRACT_GAP.

CONTEXT
- The file already has section headers (`// ── <name> ──`). Current sections and line ranges:
  - 1–222 imports, re-exports (DecryptError, SpaceReadOnlyError), storage key constants, `store`, `_key`, getLocalStore / getLocalDbKey / unlockLocalDb / wipeLocalDbKey
  - 223–428 Space context, keyring and cryptoFor (ctxFor, PERSONAL_CTX, loadKeyring, `setKeyringLoader(loadKeyring)` at module load, member stamps, withSpaceLock, clearLocalDb)
  - 429–460 Records: liveness and the local rev
  - 461–529 The change counter (meta:sync)
  - 530–557 Local change hook
  - 558–611 Generic encrypted read/write (readStore, writeKeysMany)
  - 612–637 Family local change hook
  - 638–708 Expense chunk helpers
  - 709–735 Commit hook: lastDataChangeAt
  - 736–793 Conversion trigger (in-tab), afterCommit
  - 794–963 Synced settings (+ conversionOnSave)
  - 964–1001 Quarantine and orphan detection
  - 1002–1030 Soft deletes
  - 1031–1292 Expenses
  - 1293–1514 Categories
  - 1515–1657 Income categories, ensureIncomeCategories, prepareUnlockedVault
  - 1658–1717 Income
  - 1718–1781 Budgets
  - 1782–1952 Main-currency conversion (readEntriesForConversion, applyEntryConversions, convertBudgets)
  - 1953–2608 Recurring items
  - 2609–3130 Sync API (listChangedRecords, applyIncomingRecords, compactTombstones)
  - 3131–3231 Legacy duplicate occurrences (dedupeOccurrences)
  - 3232–3375 Re-key (rekeyLiveData)
  - 3376–3414 Member identity
  - 3415–3603 Spaces API
  - 3604–3887 Family share state on spaceKeys entries
  - 3888–4089 Personal exports (the top-level wrappers with today's signatures)
  - 4090–4461 Moving records between spaces (moveRecords, copyCategoriesFromSpace)
  - 4462–4574 SpaceDb interface, buildSpaceDb, spaceDb handles
- Callers: 23 non-test files import '@/lib/localDb' (or a relative path to it). src/lib/spaces/spaceDb.ts does `import * as localDb from '../localDb'` and dbFor('personal') returns that namespace as a SpaceDb.
- Tests: about 830 tests in src/lib/localDb.*.test.ts; 50 test files mock '@/lib/localDb' (20 of them partially, with importOriginal); src/test/sync/simDevice.ts imports it dynamically after vi.resetModules(), so every simulated device gets its own module singletons.
- src/lib/cloud/guards.test.ts reads the source of 'lib/localDb.ts' ("the unchanged files still do not know about sync").
- .claude/verify.json lists src/lib/localDb.ts as a sensitive path.
- CLAUDE.md "Storage" and "Spaces → Making a function space-aware" describe localDb.ts as one file.
- Testing rules: .claude/rules/testing.md.

1. TARGET LAYOUT
   Create these files under src/lib/db/ (names fixed; avoid the existing src/lib/conversion.ts, src/lib/syncRecords.ts and src/lib/spaces/spaceDb.ts names):
   - context.ts: storage key constants, store, _key, unlock / wipe / getters, clearLocalDb, space context (ctxFor, PERSONAL_CTX, storageKeyOf, personalLocked), the keyring loader and its `setKeyringLoader(loadKeyring)` registration, cryptoFor, member stamps, withSpaceLock
   - records.ts: liveness helpers (liveRecords, withoutRev, nowIso, editedAt) and soft deletes (softDeleteIn)
   - revs.ts: the meta:sync change counter (parseLocalRev, getLocalRevIn, openRevCounter, syncMetaEntry)
   - storage.ts: readStore, writeKeysMany, expense chunk helpers (expenseChunkKey, chunkKeysBetween, readChunk, allExpenseChunkKeys)
   - events.ts: local and Family change listeners, markDataChanged, the conversion trigger, afterCommit
   - settings.ts: synced settings, readMainCurrency, migrateSyncedSettings, conversionOnSave
   - maintenance.ts: quarantineKey, hasLocalData
   - expenses.ts, categories.ts (expense and income categories), income.ts, budgets.ts
   - entryConversion.ts: readEntriesForConversion, applyEntryConversions, convertBudgets
   - recurring.ts: everything in "Recurring items" (split into recurring.ts + recurringOccurrences.ts if over the size limit)
   - lifecycle.ts: prepareUnlockedVault
   - sync.ts: listChangedRecords, applyIncomingRecords, compactTombstones, dedupeOccurrences (split applyIncomingRecords into syncApply.ts if over the size limit)
   - rekey.ts: rekeyLiveData
   - spaces.ts: member identity, the Spaces API and the Family share state
   - move.ts: moveRecords, copyCategoriesFromSpace and their types
   - personal.ts: the personal top-level wrappers (today's "Personal exports")
   - handles.ts: the SpaceDb interface, buildSpaceDb, spaceDb
   If a function clearly belongs elsewhere than this list says (for example a helper used by only one domain file), put it where it is used and record a CONTRACT_GAP.

2. RULES FOR THE MOVE
   - Move code verbatim: same names, same logic, same comments (comments travel with their code), same order inside a section. The only allowed edits are import/export lines, `export` keywords on helpers that another db file now needs, and file header comments.
   - Module singletons (`store`, `_key`, ctxCache, keyringLoad, the listener sets, the handle map) each live in exactly one file. Do not duplicate or re-create any of them.
   - The keyring loader registration stays a module-load side effect of context.ts, and src/lib/localDb.ts imports context.ts, so importing '@/lib/localDb' still registers it exactly as today.
   - Files in src/lib/db/ import each other directly and NEVER import src/lib/localDb.ts (no barrel import inside the folder). This keeps today's mock semantics: a test that mocks a top-level function of '@/lib/localDb' affects callers outside the folder only, never calls inside it, exactly as with the single file.
   - No import cycles between db files. Layers, lowest first: context → records / revs / storage → events → settings / maintenance → expenses / categories / income / budgets / entryConversion → recurring → lifecycle / sync / rekey / spaces / move → personal → handles. A file imports only from its own or lower layers; inside a layer, no cycles.
   - Size limit: every file in src/lib/db/ is at most 700 lines.
   - Do not rename, reformat or "improve" code while moving it. Fix nothing you notice; list it under FOLLOW-UPS in the PR instead.

3. THE BARREL (src/lib/localDb.ts)
   - A short header comment: what the folder holds, the no-barrel-import rule, and where new code goes.
   - Explicit named re-exports (no `export *`), grouped by source file, of exactly today's public API: every runtime export and every exported type/interface, under the same names.
   - Internal helpers that only became `export` so another db file can use them are NOT re-exported.
   - The one allowed change to the public API: remove the unused `ENABLE_SUPABASE_SYNC` stub (nothing outside localDb.ts uses it) and its CLAUDE.md line.
   - src/lib/spaces/spaceDb.ts keeps `import * as localDb from '../localDb'` and still type-checks as a SpaceDb.

4. ORDER OF WORK
   a. Before moving any code, add src/lib/localDb.exports.test.ts: `Object.keys(await import('@/lib/localDb')).sort()` equals an inline list captured from the current file (minus ENABLE_SUPABASE_SYNC). Commit it while it passes against the single file.
   b. Extract files from the lowest layer up (context first, handles last). After each extraction, tsc --noEmit and `vitest run src/lib/localDb` must pass before the next one.
   c. When the barrel is final, run the full suite, lint and the precache build.

5. GUARDS AND CONFIG
   - New src/lib/db/layout.test.ts (node environment, reads source text like the existing guard tests):
     - no file in src/lib/db/ imports '@/lib/localDb', '../localDb' or any path that resolves to src/lib/localDb.ts
     - the import graph between db files has no cycles and follows the layer order in section 2
     - every non-test file in src/lib/db/ has at most 700 lines
     - no non-test file outside src/lib/localDb.ts and src/lib/db/ imports from a 'lib/db/' path (callers keep using '@/lib/localDb')
   - src/lib/cloud/guards.test.ts: the "unchanged files still do not know about sync" check covers src/lib/localDb.ts and every file in src/lib/db/.
   - .claude/verify.json: add "src/lib/db/**" to sensitive_paths (keep src/lib/localDb.ts).

6. DOCS
   - CLAUDE.md, Storage section: replace "the primary data module is src/lib/localDb.ts" with a short module map (one line per db file), the barrel rule (callers import '@/lib/localDb'; db files never import the barrel; no cycles; 700-line limit) and update every mention of a localDb.ts section that now lives elsewhere. Keep the existing rules (isLive, rev, write lock, DecryptError, quarantine) unchanged in meaning.
   - CLAUDE.md, "Making a function space-aware": implement `xIn(ctx, …)` in the matching domain file, add the personal wrapper to db/personal.ts, the member to SpaceDb / buildSpaceDb in db/handles.ts, and the re-export to src/lib/localDb.ts.
   - Short ADR "localDb split into src/lib/db/ behind the localDb barrel" (why, the layer order, the no-barrel-import rule and its reason: test mocks).
   - docs/project-review-2026-11-13.md: mark item 3 as done with the PR number.

CONSTRAINTS
- Pure refactor. No change to stored data, keys, encryption, locks, revs, events, error types or messages, timing, or the order of operations in any function.
- No changes to callers outside src/lib/localDb.ts and src/lib/db/, except src/lib/cloud/guards.test.ts as stated. src/lib/spaces/spaceDb.ts is unchanged.
- No existing test is edited, skipped or deleted (guards.test.ts excepted). If one cannot pass without an edit, stop, explain why in a CONTRACT_GAP, and do not work around it with a behaviour change.
- No new dependencies.
- tsc --noEmit, npm run lint (0 warnings, including test files), npm test and npm run test:precache all pass.

ACCEPTANCE (each must be a test or a check in the PR)
- The full existing suite passes with no edits to existing tests, including src/lib/localDb.*.test.ts, the sync and Family simulations (src/test/sync/), the route tests and the performance tests (localDb.spacesPerf, localDb.syncPerf).
- localDb.exports.test.ts: the runtime export list of '@/lib/localDb' equals the captured list (today's list minus ENABLE_SUPABASE_SYNC).
- Type surface: every type and interface that src/lib/localDb.ts exported before is still exported under the same name (check with a type-only import test file, or list them in the PR from a before/after diff of `export type` / `export interface` names).
- layout.test.ts passes, and fails on a sample that imports the barrel from inside src/lib/db/, on a sample cycle and on an over-long file (test the checker functions on fixtures).
- guards.test.ts covers every db file and passes.
- src/lib/localDb.ts contains only the header comment, imports needed for side effects, and re-exports (no function bodies).
- `npm run build` succeeds; total size of the client JS in .vercel/output/static/assets is within ±2% of main (report both numbers in the PR).

MANUAL CHECK (document in the PR)
- Dev build in the browser: create a vault, add an expense, an income entry, a recurring item and a budget, lock and unlock, export a backup and restore it, reload offline. Everything behaves as on main.
- With VITE_ENABLE_ACCOUNTS / SYNC / SPACES on against a local or preview Supabase: sync two browser profiles and add a Family expense on each.

OUT OF SCOPE
Splitting backup.ts or other large files, moving or renaming the localDb.*.test.ts files, changing any localDb behaviour or API, renaming functions, performance work (for example the getAllExpenses TODO), and any fix found during the move (list it as a follow-up).
```
