# Orchestrator prompt: Family budget run D of 4 — everyday Family experience

Starts from `main` once run C (sharing flows and Family sync) is merged.

| Run | What | Visible? |
|---|---|---|
| A | Local data for Personal + Family | done |
| B | Family server | done |
| C | Create, invite, join, approve, members, rotation, Family sync | done (behind flags) |
| **D (this one)** | Space switcher, every screen per space, "Paid by", analytics by member, family budgets, "Move to Family", landing copy, go-live checklist | Behind flags |

```text
Make the Family space part of everyday use. A switch in the menu (Personal | Family) decides what the whole app shows and where new entries go. Family entries show who paid, analytics can be split by member, budgets are shared, and entries can be moved between Personal and Family. Some people will use only Family, so the app must work just as well when Family is the only space they open. Everything stays behind the existing flags. This run also writes the go-live checklist for turning accounts, sync and Family on in production. Where this prompt is silent, follow existing UI patterns and record a CONTRACT_GAP. Read the ADRs of Family runs A–C and spec §20–22 first.

CONTEXT
- Run A:
  - every data function and React Query key is space-aware
  - SpaceProvider / useActiveSpace, getActiveSpaceId / setActiveSpaceId (localStorage minima_active_space)
  - per-space syncedSettings (main currency)
  - Family records carry createdBy / updatedBy / paidBy
  - memberProfiles { id, displayName, color }, spaceInfo { name }
- Run C:
  - Settings → Family tab, Family sync states (useSyncState(spaceId))
  - a read-only space after removal (SpaceReadOnlyError)
  - 'paused' and 'rotation-pending' states
- Existing UI:
  - Header with nav and the lock button
  - dashboard Quick Add and Repeat-last chips
  - ExpenseDrawer driven by URL params (?add=expense, ?edit=id)
  - Transactions, Income, Recurring, Analytics, Settings (General, Categories, Budget, Security, Data, Account, Sync, Family)
  - the home-screen shortcut /transactions?add=expense
- Flags: ENABLE_ACCOUNTS, ENABLE_SYNC, ENABLE_SPACES. Testing rules: .claude/rules/testing.md (native controls for anything a test changes).

1. SPACE SWITCHER
   - Shown only when the flags are on AND this device holds a Family space (active, paused or read-only). Otherwise nothing changes anywhere.
   - Desktop: a segmented control in the Header ("Особисте | <Family name>"). Mobile: at the top of the menu or nav sheet, plus a compact chip in the mobile header showing the current space; tapping it switches.
     - data-testid="space-switcher", options space-switch-personal / space-switch-family
     - keyboard accessible
   - Switching updates every screen immediately (no reload), keeps the current route, and closes an open drawer (which is discarded only after a confirm if it has unsaved input).
   - The choice is remembered per device (run A). New setting in Settings → General: "Open the app in" with "Last used" (default) / "Personal" / "Family" (native select, per device, stored with the device-only settings). A Family-only user picks "Family" or just stays on last used.
   - Clear "where am I" cues while Family is active:
     - the page title line reads "<Family name>" with a small people icon
     - the Quick Add and drawer headers read "Adding to <Family name>"
     - a subtle accent uses a theme token, not a hard-coded colour, and works in light and dark
     - the Family sync state icon (run C) sits next to the switcher
   - Read-only Family (removed or space gone): browsing works; every add, edit and delete control is disabled, with a banner "Read-only copy of <name>. You're no longer a member." and a link to Settings → Family. Paused: a small banner; editing still works.

2. EVERY SCREEN FOLLOWS THE ACTIVE SPACE
   - Dashboard, Transactions, Income, Recurring, Budgets and Analytics read and write only the active space, including totals, the conversion banner ("N entries waiting for rates"), Repeat-last, suggestions, upcoming recurring, CSV export and import.
   - Settings tabs split in two:
     - space settings (General → main currency and the rates switch, Categories, Budget) show a header "Settings for <space name>" and edit the active space
     - device and account settings (language, auto-lock, "Open the app in", Security, Data, Account, Sync, Family) are global
   - URL params and shortcuts:
     - ?add=expense adds to the active space; an optional `space=personal|family` param switches first
     - ?edit=<id> looks in the active space, then the other one, and switches with a toast "Switched to <space>" when found there
     - the home-screen shortcut adds to the last used space
   - The multi-tab channel and React Query invalidation already carry the spaceId. Verify that switching in one tab doesn't switch the other (the choice is per tab until reload, and the stored default is shared).

3. "PAID BY" AND AUTHORSHIP (Family only)
   - ExpenseDrawer and Quick Add get "Paid by"; the income form gets "Received by". It is a native select of active members from memberProfiles, showing displayName, defaulting to me (data-testid="paid-by-select"). Personal shows no such field.
   - Recurring items in Family get the same field. Generated entries inherit paidBy from their recurring item.
   - Transactions and Income tables: a small member chip (initials on the member's colour, with the name in the tooltip / aria-label) per row, plus a "Member" filter (native select: All, then each member, including former members who still have entries, labelled "(left)").
   - The drawer in edit mode shows "Added by <name> · Edited by <name>, <date>" from createdBy / updatedBy.
   - Former members: their memberProfile stays for history (it is never hard-deleted while entries reference it). Unknown ids show "Former member".

4. ANALYTICS AND DASHBOARD BY MEMBER (Family only)
   - Analytics adds a "By member" section:
     - total spent per payer in the main currency, with a bar or donut using theme tokens
     - share in %
     - average per month over the selected range
     - the same for income ("Received by")
   - The existing member filter applies to every chart.
   - The dashboard Family summary card: "This month: <You> 12 400 грн · <Olena> 9 800 грн" (top 3 members, then "+N"), using the existing formatting helpers.
   - Pending-conversion entries are excluded and counted exactly as today.

5. FAMILY BUDGETS
   - The Budget screen in Family is the shared budget: every member sees and edits the same limits and progress (it already works per space; verify it).
   - Each budget row gets a "By member" breakdown (tooltip or expandable row) showing how much each payer contributed this month.
   - The dashboard "Left to spend" card follows the active space.

6. MOVE BETWEEN PERSONAL AND FAMILY
   - Transactions and Income: a row action "Move to Family" / "Move to Personal", plus bulk selection (checkboxes, select all on the page) with the same action. Recurring: a per-item move.
   - A confirm dialog lists the count and says "Everyone in <Family> will see these" (to Family) or "This removes them from <Family> for everyone" (to Personal).
   - localDb.moveRecords({ from, to, type, ids }):
     - creates the records in the target space with the same id (spaces are separate) and tombstones them in the source, in ONE setMany across both spaces' keys, with revs bumped in both spaces
     - only what is visible to the user changes
     - categories are mapped by name, ignoring case and diacritics, to the target's categories; a missing category is created in the target (with its icon and default currency)
     - conversion is cleared (the target's main currency converts it later)
     - paidBy / createdBy / updatedBy are set to me when moving into Family, and dropped when moving to Personal
     - for a recurring item, future occurrences generate in the target, and past generated entries stay where they are unless selected
     - refuses when the target is read-only or locked
   - Family Settings → Categories: "Copy categories from Personal" (adds missing ones by name, never duplicates).

7. EMPTY STATES AND HINTS (Family)
   - An empty Family dashboard offers "Invite members" (owner, goes to Settings → Family), "Move entries from Personal" and "Add the first expense".
   - After a Family pull that brings records written by others, when the user is looking at Personal: one subtle toast "<N> new entries in <Family>" with "Open" (switches space). At most one per cycle, none during the first full download.

8. LANDING AND COPY
   - When ENABLE_SPACES is on, the landing features list gets "Family budget: track shared spending together, end-to-end encrypted, free during the beta" in uk and en. Check /privacy and /terms still describe Family accurately; update "Last updated" only if the text changed.
   - Glossary additions: Personal → Особисте, Paid by → Хто платив, Received by → Хто отримав, Move to Family → Перенести в сім'ю, Move to Personal → Перенести в особисте, Member → Учасник, Former member → Колишній учасник, Open the app in → Відкривати застосунок у.
   - All new strings go in both catalogs. The untranslated-text guard must pass.

9. GO-LIVE CHECKLIST (docs/release/accounts-sync-family-checklist.md)
   A step-by-step checklist the owner follows before turning the flags on in production:
   - migrations from sync run 2, Family run B and any later ones applied to production Supabase, with the check scripts passing
   - Google OAuth consent screen published, with the privacy and terms URLs and the production redirect URLs
   - operator name and contact constants filled in (src/lib/legal.ts); privacy and terms reviewed
   - plan limits reviewed in `plans`; sync_free_for_all = true
   - Vercel env vars VITE_ENABLE_ACCOUNTS, VITE_ENABLE_SYNC and VITE_ENABLE_SPACES set per environment; the order to enable them (accounts, then sync, then spaces) and how to roll back (flags off: local data is untouched, cloud data stays)
   - a two-device and two-account smoke test (a list of the run 3, C and D manual checks)
   - Supabase backups enabled, and what to watch (sync_records and space_records sizes, function errors)
   Link it from CLAUDE.md and the PR.

CONSTRAINTS
- With the flags off, or without a Family on this device, the app is byte-for-byte the same as before for the user. Test it.
- No new runtime dependencies. No server changes. No change to encryption, sync rules or the backup version.
- Performance: switching spaces with 20,000 entries in each renders the dashboard without a full reload and within the existing test timeouts. Member breakdowns are computed in memory from the already-loaded queries.
- Accessibility: the switcher, member chips, bulk selection and filters have labels, are keyboard operable, and have touch targets of at least 44 px on mobile.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass.
- Docs:
  - ADR "Family UX: one active space for the whole app, move as create + tombstone across spaces"
  - spec section "23. Family budget in daily use"
  - CLAUDE.md: active-space rules, which settings are per space, moveRecords

ACCEPTANCE (each must be a test)
- Switcher:
  - hidden without a Family or with the flags off
  - shown with one; switching changes the dashboard totals, Transactions list, Income, Recurring, Budgets and Analytics to the Family data and back, without a reload
  - the choice persists; "Open the app in: Family" opens in Family after a restart
  - the "Adding to <Family>" cue appears in Quick Add and the drawer
- Isolation: an expense added while Family is active is stored only in the Family space, and Personal totals are unchanged; CSV export in Family exports only Family.
- Space settings: changing the main currency in Family doesn't change Personal's; Categories and Budget edit the active space; language and auto-lock are global.
- URL:
  - ?add=expense&space=family switches and opens the drawer
  - ?edit=<family id> while in Personal switches with the toast
  - the shortcut adds to the last used space
- Paid by:
  - defaults to me
  - choosing another member saves paidBy
  - a recurring item's paidBy carries to generated entries
  - the table chip and the member filter work, including a former member labelled "(left)"
  - edit mode shows "Added by … · Edited by …"
- Analytics: per-member totals and shares for a fixture match hand-computed values in the main currency, pending entries excluded and counted; the member filter applies to every chart; the dashboard card shows the top 3 and "+N".
- Budgets: the per-member contribution for a category matches the fixture; both members' devices (PGlite multi-user harness) show the same limit after sync.
- Move:
  - moving 3 personal expenses to Family creates 3 Family records and 3 personal tombstones in one transaction (an injected failure leaves both unchanged), with revs bumped in both spaces
  - categories map by name, and a missing one is created
  - conversion is cleared, then recomputed
  - after sync the other member sees the moved entries
  - moving to Personal removes them for the other member
  - a move into a read-only Family is refused
  - "Copy categories from Personal" adds only missing names
- Read-only and paused: read-only disables every add, edit and delete control and shows the banner; paused shows the banner and still allows edits.
- Hints: an empty Family shows the three actions (Invite only for the owner); the "new entries" toast fires once per cycle and never during the first download.
- Flags off: the full existing UI test suite passes unchanged, and no switcher or member UI renders.
- i18n: both catalogs have identical keys, and the guard passes.
- The go-live checklist file exists and is linked from CLAUDE.md.

MANUAL CHECK (Vercel Preview, all three flags on, two accounts in one Family)
1. On the phone, switch to Family. The title, Quick Add and drawer clearly say Family.
2. Add an expense paid by the other member. On the other phone it appears with their chip, and the dashboard card splits the month by member.
3. Move two personal expenses to Family. They disappear from Personal and appear for both members.
4. Set "Open the app in: Family", close and reopen the app: it opens in Family.
5. Check light and dark themes and a narrow phone: the switcher, chips and bulk bar fit and nothing overflows.

OUT OF SCOPE
Settle-up ("who owes whom"), payments and the upgrade screen, more than one Family per user, push notifications, comments on entries, per-member budgets or limits, enabling the flags in production (the checklist only describes it).
```
