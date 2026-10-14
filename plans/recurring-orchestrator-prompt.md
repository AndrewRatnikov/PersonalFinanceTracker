# Orchestrator prompt: Recurring transactions and subscriptions

Starts from `main` at 90202c4 (chart theme fix merged).

```text
Add recurring transactions (subscriptions, rent, salary) to MinimaSpend. A recurring item creates its expense or income automatically when it's due, or asks first. The dashboard shows what's coming up, and a new Recurring page lists every item and the monthly total committed. Everything stays local and encrypted, with no server and no push notifications. Where this prompt is silent, follow the existing patterns in src/lib/localDb.ts and record a CONTRACT_GAP.

CONTEXT
- Data layer: src/lib/localDb.ts.
  - Encrypted idb-keyval store. Expenses are chunked as expenses_YYYY_MM (UTC month of createdAt); income, categories, incomeCategories and budgets are single keys.
  - Every mutation runs under withWriteLock (cross-tab via navigator.locks), then calls afterCommit (sync channel + lastDataChangeAt).
  - A setMany helper (~line 106) writes several encrypted keys in ONE IndexedDB transaction.
  - prepareUnlockedVault (~line 620) runs after every unlock.
  - deleteCategory and deleteIncomeCategory refuse while records use the category.
- Data keys: src/lib/dataErrors.ts SINGLE_KEY_LABELS. Query invalidation: src/lib/syncChannel.ts queryKeysFor. Backup payload: src/lib/backup.ts BackupPayload, where optional fields are additive (see incomeCategories).
- The original PRD (docs/prd.md) listed a "recurring flag for subscriptions" that was never built.
- Decisions already made: docs/adr/ (follow them; e.g. one currency at a time, no conversion).

DATA MODEL
1. New storage key `recurring`: Array<RecurringItem>, encrypted.
   - Add it to SINGLE_KEY_LABELS with the label "Recurring", so it counts as a data key for hasLocalData, quarantine, backup and wipe.
   - Add it to LocalDbMap.
   - syncChannel: `recurring` → [['recurring'], ['expenses'], ['income'], ['analytics']].

   interface RecurringItem {
     id: string
     kind: 'expense' | 'income'
     amount: number
     currency: Currency
     categoryId: string              // expense category or income category, by kind
     description: string | null
     frequency: { unit: 'day' | 'week' | 'month' | 'year'; interval: number }   // interval >= 1
     startDate: string               // local calendar date, YYYY-MM-DD
     end: { type: 'never' } | { type: 'onDate'; date: string } | { type: 'afterCount'; count: number }
     mode: 'auto' | 'ask'            // auto = create when due; ask = show as "Due" until confirmed or skipped
     paused: boolean
     handledThrough: string | null   // last occurrence date that is fully handled (created, confirmed or skipped)
     handledAhead: Array<string>     // ask mode: occurrences after handledThrough already handled out of order; pruned as handledThrough advances
     occurrenceCount: number         // occurrences handled so far (for end.afterCount)
     createdAt: string
     updatedAt: string
   }

2. Expense and IncomeEntry gain optional `recurringId?: string` and `occurrenceDate?: string` (YYYY-MM-DD). Generated records carry both. Ordinary records don't have them, and no migration is needed.

RECURRENCE RULES (pure module src/lib/recurrence.ts, no IndexedDB)
3. occurrencesBetween(item, afterExclusive: string | null, throughInclusive: string): Array<string> returns the occurrence dates in order.
   - The occurrences are startDate + k × interval units, for k = 0, 1, 2, …
   - Month and year steps are always computed from startDate, so the day never drifts:
     - Jan 31 monthly → Feb 28 (Feb 29 in leap years) → Mar 31 → Apr 30
     - Feb 29 yearly → Feb 28 in non-leap years
   - It respects end.onDate (inclusive) and end.afterCount (counted across all occurrences from startDate).
   - It uses date-only arithmetic, so daylight-saving changes and timezones can't shift a date.
4. nextOccurrence(item, afterExclusive) and monthlyEquivalent(item) for the "per month" figure:
   - daily × 365 / 12
   - weekly × 52 / 12
   - monthly / interval
   - yearly / (12 × interval)
   - rounded to 2 decimals

GENERATION
5. processDueRecurring(today = local YYYY-MM-DD) in localDb:
   - For each active (not paused) auto-mode item, take the occurrences after handledThrough up to today.
   - Create one expense or income record per occurrence: createdAt = occurrence date at local 12:00, plus recurringId and occurrenceDate.
   - Advance handledThrough and occurrenceCount, and set updatedAt.
   - Each item's writes go in ONE setMany: the `recurring` key plus every affected expenses chunk or the `income` key. Hold withWriteLock on all of those keys for the whole read-modify-write.
   - Idempotency: before creating an occurrence, skip it if a record with the same recurringId + occurrenceDate already exists in the target. Two tabs, a retry or a restored backup must never produce duplicates.
   - Catch-up: create every missed occurrence, e.g. after weeks offline. Group the writes by chunk; don't do one write per record.
   - Call afterCommit with every written key.
   - Return { created: number, itemsTouched: number }.
6. Call processDueRecurring:
   - from prepareUnlockedVault, after the income categories have been ensured
   - when the tab becomes visible again while unlocked (visibilitychange)
   - when the local date changes while the app is open
   When it created records, show one toast, e.g. "Added 3 recurring transactions". A DecryptError must surface on the Data problem screen as today; never overwrite unreadable data.
7. Ask mode:
   - getDueRecurring(today) returns the due-but-unhandled occurrences of ask-mode items: { item, occurrenceDate }[].
   - confirmRecurringOccurrence(itemId, date, overrides?: { amount?, description? }) creates the record (same atomic rules as step 5) and marks the date handled.
   - skipRecurringOccurrence(itemId, date) marks it handled without creating anything.
   - Handling the oldest due date advances handledThrough past it and past any following dates already in handledAhead. Handling a later date first adds it to handledAhead.

CRUD
8. In localDb, with the same lock and afterCommit rules:
   - getAllRecurring
   - addRecurring(input, { createThroughToday: boolean })
   - updateRecurring(id, patch)
   - setRecurringPaused(id, paused)
   - deleteRecurring(id)

   Rules:
   - Validate with a zod schema in src/lib/schemas.ts: amount > 0, a currency from CURRENCIES, a categoryId that exists for the kind, interval an integer 1–365, an end date not before startDate, afterCount >= 1.
   - createThroughToday === false sets handledThrough to the last occurrence on or before today, without creating anything. true creates them (auto mode) or leaves them due (ask mode).
   - Edits apply only to future occurrences. Changing frequency or startDate keeps handledThrough. Already-created transactions are never changed.
   - Deleting a recurring item never deletes the transactions it created; they become ordinary records.
   - deleteCategory and deleteIncomeCategory also refuse while a recurring item uses the category: "Used by N recurring items".

BACKUP
9. BackupPayload gains optional `recurring?: Array<RecurringItem>`. This is additive and schemaVersion stays 1. Replace and merge treat it like the other single-key lists: replace writes the list, merge upserts by id and the newer updatedAt wins. Restore never generates records itself; the next processDueRecurring run does, and the idempotency check prevents duplicates.

UI
10. New route /recurring ("Recurring" in the header nav with the lucide `Repeat` icon, between Income and Settings).
    - Summary: "Committed per month", with one total per currency built from monthlyEquivalent. Expenses and income are shown separately; currencies are never mixed or converted.
    - List: each item with name (description, falling back to category), category icon, amount and currency, frequency text ("Every month on the 31st", "Every 2 weeks", "Every year on Mar 1"), next date, an auto/ask badge, and a paused state.
    - Row actions: Edit, Pause/Resume, Delete (AlertDialog: "Past transactions are kept.").
    - Add / Edit form:
      - kind toggle; amount + currency; a category select filtered by kind; description
      - frequency: interval number + unit select; start date
      - end: Never / On date / After N times
      - mode: "Add automatically" (default) / "Ask me first"
      - when creating with a start date on or before today, a checkbox "Also add occurrences up to today": default checked when the start date is today, unchecked when it is earlier
    - testids: recurring-page, recurring-add-btn, recurring-form, recurring-row, recurring-monthly-total.
11. Quick creation:
    - SpeedEntryForm (dashboard Quick Add) and AddIncomeForm get a compact "Repeat" select: Don't repeat (default) / Weekly / Monthly / Yearly.
    - Choosing one saves the transaction as today AND creates a matching auto-mode recurring item starting today with handledThrough = today, so no duplicate is created.
    - testid: speed-entry-repeat, income-repeat.
12. Dashboard (src/routes/index.tsx, below the summary):
    - a "Due" card (data-testid="recurring-due"), shown only when ask-mode occurrences are due, with Add and Skip per row
    - an "Upcoming" card (data-testid="recurring-upcoming") with the next 7 days of occurrences across active items, up to 5 rows, and a link to /recurring
    - nothing is shown when there are no recurring items
13. TransactionsTable and IncomeTable show a small Repeat icon (title "From a recurring item") on records that have recurringId.

CONSTRAINTS
- No server, no push notifications, no new runtime dependencies (dayjs is already available).
- Do not change the meta:vault header, the encryption, or the backup `version`. The payload change is additive only.
- Analytics, budgets and dashboard totals need no special handling: generated records are normal records.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass.
- Add an ADR in docs/adr/ for the generation model (when it runs, idempotency key recurringId + occurrenceDate, one transaction per item, month-end clamping). Add a section "14. Recurring transactions" to docs/free-tier-spec.md. Update CLAUDE.md (storage keys, query keys, where generation runs).

ACCEPTANCE (each must be a test)
- recurrence.ts:
  - monthly from Jan 31 gives Jan 31, Feb 28, Mar 31, Apr 30 (Feb 29 in 2028)
  - yearly from 2028-02-29 gives 2029-02-28
  - every 2 weeks, every 3 days and every 2 months give the right dates
  - end.onDate is inclusive; end.afterCount stops after N occurrences in total
  - the results don't change under TZ=Pacific/Auckland or TZ=America/Los_Angeles
- processDueRecurring:
  - A monthly auto item with startDate exactly 3 months before today and handledThrough = null creates 4 records (start, +1, +2 and +3 months, the last being today) with the right createdAt, recurringId and occurrenceDate in the right month chunks, and advances handledThrough to today.
  - Running it again creates nothing.
  - Paused items and ask-mode items create nothing.
- Atomicity and duplicates:
  - Two concurrent processDueRecurring calls create each occurrence exactly once.
  - A failure injected in setMany leaves the `recurring` key and every chunk byte-identical.
  - A pre-existing record with the same recurringId + occurrenceDate is not duplicated.
- Ask mode:
  - getDueRecurring lists the due dates.
  - Confirming the oldest creates one record and advances handledThrough.
  - Skipping a later date first and then confirming the oldest advances handledThrough past both.
  - Overrides change only that record's amount and description.
- addRecurring with createThroughToday false creates nothing and sets handledThrough to the last occurrence on or before today. Quick Add with Repeat = Monthly creates exactly one expense today, and the next processDueRecurring creates nothing until next month.
- updateRecurring changes future occurrences only. deleteRecurring keeps the past records. deleteCategory refuses while a recurring item uses the category.
- monthlyEquivalent: weekly 100 → 433.33, yearly 1200 → 100, every 2 months 300 → 150. The Recurring page shows per-currency totals without mixing currencies.
- Backup: recurring items round-trip. Restoring a backup whose generated records already exist and then running processDueRecurring creates no duplicates. Backups made before this change (no `recurring` field) still restore.
- Dashboard: recurring-upcoming lists the next occurrences within 7 days; recurring-due appears only with due ask-mode occurrences, and Add / Skip work; neither appears with no recurring items.
- A 'changed' message for `recurring` invalidates ['recurring'], ['expenses'], ['income'] and ['analytics'].

OUT OF SCOPE
Push notifications or reminders outside the app, currency conversion, "left to spend" forecasting from upcoming items, recurring transfers between accounts, CSV import/export of recurring items, paid sync.
```
