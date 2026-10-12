# Auto-lock locks only its own tab; a manual lock locks every tab

- **Status:** Accepted. Corrects the original spec §2.4.
- **Date:** 2026-10-10
- **Source:** orchestrator run `run_20261010_092310` (Phase 6, validation fixes, issue 1)
- **Code:** `src/lib/vaultSession.ts` (`startTabAutoLock`, `lockApp(queryClient, { broadcast })`), `src/routes/__root.tsx`, `src/lib/autoLock.ts`
- **Spec:** `docs/free-tier-spec.md` §2.4 (updated in the same run)

## Context

Spec §2.4 said locking broadcasts `lock` to other tabs, without separating manual lock from auto-lock. In a browser test with auto-lock set to 1 minute, an idle tab B locked tab A while the user was actively using A: B's auto-lock broadcast `lock`, and every tab obeyed.

## Decision

- Auto-lock calls `startTabAutoLock(minutes, queryClient)`, which locks with `{ broadcast: false }`. Only the idle tab locks.
- A manual lock (Header `LockButton`, Settings → Security "Lock now") still broadcasts `lock`, so it locks every tab.
- A `wiped` message still affects every tab.
- The callback lives in `vaultSession.ts` rather than inline in `__root.tsx`, so it can be tested with an injected sync channel.

## Consequences

- An active tab is never locked by an idle one. Each tab needs its own idle timeout to lock.
- An unlocked tab can stay open next to a locked one. This is acceptable: each tab locks after its own idle period.
