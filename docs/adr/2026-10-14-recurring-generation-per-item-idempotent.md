# Recurring transactions are generated client-side, one atomic write per item, keyed by recurringId + occurrenceDate

- **Status:** Accepted
- **Date:** 2026-10-14
- **Source:** orchestrator run `run_20261014_070533` (recurring transactions; task.md required an ADR for the generation model)
- **Code:** `src/lib/localDb.ts`, `src/lib/recurrence.ts`, `src/components/RecurringScheduler.tsx`, `src/lib/backup.ts`

## Context

MinimaSpend has no server: all data is encrypted in IndexedDB and written under `withWriteLock` (one `setMany`, then `afterCommit`). Recurring items ("rent on the 31st", "Netflix monthly") must turn into ordinary expense or income records. Generation can run in several tabs at once, can be retried after a failed write, and can see a restored backup whose `handledThrough` is behind the data already stored. It must never create the same occurrence twice, and must never overwrite unreadable data.

## Decision

- **When it runs.** `processDueRecurring(today)` runs on vault unlock (from `prepareUnlockedVault`), when the tab becomes visible again, and when the local date changes (`RecurringScheduler` checks every `checkIntervalMs`; it does not run on mount, because unlock already did). It creates records for every missed occurrence (catch-up). A `DecryptError` goes to the Data problem screen; other errors are logged.
- **Which items.** Only active (not paused) `mode: 'auto'` items. Ask-mode items create nothing; their due dates are listed by `getDueRecurring` and handled by `confirmRecurringOccurrence` or `skipRecurringOccurrence`.
- **One transaction per item.** Each item is processed on its own: one `setMany` writes the `recurring` key plus every affected expense chunk (or the `income` key), under a lock on all of those keys. One bad item does not block the others, and items committed before an error stay committed. `processDueRecurring` returns `{ created, itemsTouched }`.
- **Locks are bounded.** The target keys are planned outside the lock, then the item is re-read and re-checked under the lock of `recurring` plus those keys. If an edit changed the needed keys, the attempt is released and replanned. After 3 attempts (`RECURRING_ATTEMPTS`) the item is skipped with a `console.warn`, nothing is written, and the next run picks it up. `confirmRecurringOccurrence` locks `recurring`, `income` and the date's expense chunk, since the target depends on the item's kind.
- **Idempotency key.** Each generated record carries `recurringId` and `occurrenceDate`. Before creating one, `planOccurrenceWrites` skips the date if its target already holds a record with the same pair. Two tabs, a retry or a restored backup therefore cannot produce duplicates. Generated records get `createdAt` at local noon of the occurrence date.
- **Month-end clamping.** Occurrences are always `startDate + k * interval` units, computed from `startDate` and never from the previous occurrence (`src/lib/recurrence.ts`). Jan 31 monthly gives Feb 28/29, Mar 31, Apr 30; Feb 29 yearly gives Feb 28 in non-leap years. Date-only arithmetic, so DST and time zones cannot shift a date. `end.afterCount` counts from `startDate`.
- **Progress markers.** `handledThrough` is the last handled occurrence; `handledAhead` holds ask-mode dates handled out of order and is pruned as `handledThrough` advances. When an ask item is switched to auto, dates in `handledAhead` are not created again and do not add to `occurrenceCount`.
- **Missing category.** If the item's category no longer exists (after a restore or merge), generation skips the item and writes nothing; `handledThrough` is not advanced, so the occurrences are caught up once the user picks a category. Confirming such an item throws "Category not found".
- **Resume after pause.** `setRecurringPaused(id, false)` moves `handledThrough` to the last occurrence before today (and past following `handledAhead` dates), so occurrences inside the pause are skipped, not caught up.
- **Backups.** `recurring` is an optional list in the backup payload, with no schema version bump. Restore never generates records itself; the next `processDueRecurring` does, and the idempotency check covers any overlap.

## Alternatives considered

- **One global transaction over all items.** It would lock many chunks at once, and one bad item would fail every item.
- **Locking every expense chunk.** Unbounded as history grows.
- **A background timer only.** Misses work while the tab sleeps; unlock and visibility triggers cover that.
- **Creating records with a dangling category for a missing category.** They would show as "Uncategorized" and could not be cleaned up properly. Advancing `handledThrough` instead would silently lose occurrences. Re-creating the category would write data the user did not ask for.
- **Catching up everything on resume.** A user who paused a subscription would get a burst of past transactions; "pause" means those occurrences did not happen.

## Consequences

- Generation is atomic per item and safe across tabs, retries and restores, with lock sizes bounded by the number of months an item catches up over.
- Nothing is generated while the app is closed and locked; records appear at the next unlock or when the tab is shown. Dates are exact because they come from the schedule, not from when generation ran.
- Known gap: the expense chunk of an occurrence depends on the device time zone (local noon in UTC). If a backup is restored in a zone more than 12 h away, with a regressed `handledThrough` and an occurrence on a month boundary, the idempotency lookup may miss the copy stored in the neighbouring chunk. Accepted; checking the adjacent chunk is the fix if it ever matters.
- An item whose target keys keep changing is deferred silently (console warning only).
- Deleting a recurring item keeps the records it created; they become ordinary records.
- Revisit if a server or background sync is added, since the idempotency key then has to hold across devices.
