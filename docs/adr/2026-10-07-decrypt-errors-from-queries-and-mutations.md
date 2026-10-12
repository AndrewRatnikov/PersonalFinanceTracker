# A decrypt error from any query *or* mutation opens the Data problem screen and is never retried

- **Status:** Accepted
- **Date:** 2026-10-07
- **Source:** orchestrator run `run_20261007_212533` (free tier Phase 1, "Safety net"). Builds on finding #1 of `docs/code-review-2026-10-05.md` (`run_20261005_215952`).
- **Code:** `src/lib/dataErrors.ts`, `src/lib/queryClient.ts` (`handleQueryError`, `shouldRetryQuery`, `createAppQueryClient`), `src/lib/dataProblem.ts`, `src/routes/__root.tsx` (`DataProblemGate`)
- **Spec:** `docs/free-tier-spec.md` §5.2

## Context

Before this change, `readStore` and `readChunk` returned empty data when decryption failed. The next mutation then overwrote the unreadable blob, so data was lost silently. Spec §5.2 says a "React Query global onError" should turn `DecryptError` into a Data problem screen.

## Decision

- Reads throw `DecryptError` (it carries the `storageKey`). Mutations never catch it, so an unreadable blob is never overwritten.
- Both the global **`QueryCache` and `MutationCache`** `onError` report a `DecryptError` to `dataProblem.ts`. This goes beyond the spec's wording: adding an expense to a corrupt month switches to the Data problem screen as well as showing the usual toast.
- `shouldRetryQuery` returns false for a `DecryptError`, so it fails at once instead of after about 7 s of default retries.
- `DataProblemGate` and an error boundary live in the app shell (`__root.tsx`) and replace the routes while a problem is active.

## Alternatives considered

- **Report only query errors, as the spec's wording suggests.** Rejected: a mutation that hits corrupt data would show only a toast and leave the user unaware the data is unreadable.
- **Retry as usual.** Rejected: decryption is deterministic, so retrying only delays the screen.

## Consequences

- **Known gap:** TanStack Router wraps each route in its own CatchBoundary. A `DecryptError` thrown *during render* inside a route would be caught there and never reach the shell boundary. Today every read goes through `useQuery`, so this can't happen. Adding `throwOnError` or suspense queries later would also need a router `defaultErrorComponent`.
- "Quarantine and continue" resets the queries (`queryClient.resetQueries()`), not just invalidates them, to avoid a flash of the cached error when the routes remount.
