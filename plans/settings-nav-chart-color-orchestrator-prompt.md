# Orchestrator prompt: Grouped Settings navigation + one chart colour

Starts from `main` at b971f3d (run D merged).

```text
Fix two UI issues. (1) Settings has 8 tabs (General, Categories, Budget, Security, Data, Account, Sync, Family) that overflow and overlap on phones. Replace the tab row with a grouped settings page: a list on phones, a sidebar on desktop. (2) The bar charts use different colours: the dashboard monthly chart uses var(--primary) (black in light mode, light grey in dark mode), while the Analytics charts hard-code violet #6366f1. Make every bar chart use one shared violet chart token. UI only: no data, sync or server changes. Where this prompt is silent, follow existing patterns and record a CONTRACT_GAP.

CONTEXT
- src/routes/settings.tsx renders Radix Tabs with SETTINGS_TABS and validateSearch for `?tab=<id>` (default 'general').
  - The Account tab shows only when accounts are visible.
  - Sync and Family show only behind their flags (ENABLE_SYNC / ENABLE_SPACES with accounts visible).
  - Since run D, General (main currency part), Categories and Budget edit the ACTIVE space and show "Settings for <space name>". Language, auto-lock and "Open the app in" in General are device-wide.
- Existing deep links that must keep working: /settings?tab=account (login redirect), ?tab=sync (header cloud icon), ?tab=family (badge, join flow, empty Family dashboard), ?tab=data, ?tab=security and any others found in the code.
- Charts:
  - src/components/index/DashboardStats.tsx: Bar fill and tooltip use var(--primary)
  - src/components/analytics/TimelineBarChart.tsx: fill "#6366f1"
  - src/components/analytics/BudgetVarianceBarChart.tsx: planned bar "#6366f1"; actual bars '#ef4444' / '#22c55e'
  - src/components/analytics/MemberBreakdown.tsx: member colours (keep them; they identify people)
  - Theme tokens live in src/styles.css (:root and .dark).
- Testing rules: .claude/rules/testing.md. jsdom has no real layout, so control which layout renders with a matchMedia mock or a useIsDesktop hook that tests can set.

1. SETTINGS STRUCTURE
   Three groups, always in this order. Hidden items are omitted, and an empty group is hidden.
   - "Budget" (when a Family exists on this device, the header reads "Budget · <active space name>"): General, Categories, Budget
   - "This device": Security, Data
   - "Account & cloud": Account, Sync, Family
   Each item has an icon (reuse the current tab icons), a label and a one-line description in muted text, for example "Main currency, language, auto-lock", "Password, recovery key, auto-lock", "Backup, restore, CSV". Write good short descriptions for all 8 in both languages.
   Status indicators on items:
   - Sync shows the current sync state dot (synced / syncing / offline / problem), the same source as the header icon
   - Family shows the pending-requests badge (moved from the tab)
   The General section keeps its device-wide part (language, auto-lock, "Open the app in"). Do not move fields between sections in this run.

2. PHONE LAYOUT (below the `md` breakpoint)
   - /settings without `tab`: a full-width list of the groups and items (data-testid="settings-index", items data-testid="settings-item-<id>"). Each item is a row with at least 44 px height, an icon, label, description and a chevron.
   - Tapping an item navigates to /settings?tab=<id> (push, not replace), so the phone's back button returns to the list. The section page shows a header with a back arrow (data-testid="settings-back", aria-label "Back to settings") and the section title, then the section's existing content unchanged.
   - Opening a deep link directly (/settings?tab=sync) shows that section with the back arrow. Back goes to /settings, even when there is no history entry.

3. DESKTOP LAYOUT (`md` and up)
   - A two-column layout: on the left, a sticky sidebar (about 240–280 px) with the same groups and items, the current one highlighted with aria-current="page"; on the right, the selected section.
   - /settings without `tab` shows General. Clicking an item updates `?tab=` with history replace (no back-button spam on desktop). No back arrow on desktop.
   - Keyboard: the sidebar is a nav landmark (aria-label "Settings sections"). Items are links or buttons reachable with Tab, with a visible focus ring.

4. ROUTING AND COMPATIBILITY
   - Keep the `?tab=<id>` param and every existing id, so all current deep links and the login redirect keep working unchanged.
   - An unknown or hidden id (for example tab=family with the flag off, or tab=account when accounts are hidden) falls back:
     - phone: to the list
     - desktop: to General
   - Rendering mounts only the selected section (as Tabs did), so sections keep their current data loading.
   - Remove the Radix Tabs usage from settings.tsx. Keep src/components/ui/tabs.tsx if other places use it.
   - The space switcher, flags and section visibility rules stay exactly as they are.

5. CHART COLOUR TOKEN
   - Add tokens in src/styles.css for light and dark, and register them in the Tailwind theme block like the existing chart tokens:
     - --chart-accent: violet; keep #6366f1 in light, and pick a lighter violet in dark (around #818cf8) that has at least 3:1 contrast against the dark card background
     - --chart-positive and --chart-negative: replacing '#22c55e' / '#ef4444', with dark variants that keep 3:1 contrast
   - Use var(--chart-accent) for:
     - the DashboardStats bar and its tooltip value colour
     - TimelineBarChart bars
     - the BudgetVarianceBarChart planned bar
   - Use var(--chart-positive) / var(--chart-negative) for the variance actual bars.
   - Check every other chart, bar and progress element in the app (budget progress bars, the Family dashboard card, analytics). Anything that should be the accent colour uses the token. Member colours stay as they are.
   - Add a guard test: no hex colour literal (#rgb / #rrggbb) and no var(--primary) as a fill in src/components/analytics/** and src/components/index/DashboardStats.tsx. MemberBreakdown is allowed to use member colours from data.

6. STRINGS
   - New strings (group titles, item descriptions, "Back to settings", "Settings sections") go in en and uk.
   - Glossary: This device → Цей пристрій, Account & cloud → Обліковий запис і хмара. Keep the existing section names.
   - The untranslated-text guard must pass.

CONSTRAINTS
- UI only. No changes to localDb, sync, server, flags or stored settings.
- No new runtime dependencies. Use existing components (Button, Card, lucide icons) and theme tokens only; no hard-coded colours.
- Works in light and dark themes, from 320 px phone width to wide desktop, with no horizontal page scroll and nothing overlapping. Long Ukrainian labels wrap instead of overflowing.
- Follow .claude/rules/testing.md. Existing settings tests that click tabs are updated to the new navigation (same testids for section content where possible). tsc --noEmit, npm run lint (0 warnings, including test files) and npm test must all pass. Also fix the 11 existing lint warnings in src/i18n/ssr.test.tsx, src/lib/localDb.rev.test.ts and src/test/sql/familyHarness.ts.
- Docs:
  - short ADR "Settings as grouped list (phone) and sidebar (desktop)"
  - CLAUDE.md: where settings sections are registered and how to add one; the chart colour tokens rule

ACCEPTANCE (each must be a test)
- Phone:
  - /settings shows the index with the three groups; items hidden by flags or accounts are absent, and an empty group is absent
  - tapping Data navigates to ?tab=data with push and shows Data content plus the back arrow
  - back returns to the list
  - a direct /settings?tab=sync shows Sync with the back arrow
- Desktop:
  - /settings shows the sidebar plus General, with General marked aria-current="page"
  - clicking Security replaces the URL with ?tab=security and shows Security content
  - no back arrow
- Compatibility:
  - every existing deep link (account, sync, family, data, security, general, categories, budget) opens the right section
  - tab=family with ENABLE_SPACES off and tab=account with accounts hidden fall back as specified
  - the login redirect to /settings?tab=account still lands on Account
- Indicators: the Family item shows the pending-requests badge count; the Sync item shows the state from a mocked sync state.
- Space header: with a Family present and active, the Budget group header reads "Budget · <Family name>"; without a Family it reads "Budget".
- Charts:
  - DashboardStats, TimelineBarChart and BudgetVarianceBarChart render bars whose fill is var(--chart-accent) (variance actual bars: var(--chart-positive) / var(--chart-negative))
  - the guard test fails on a sample with fill="#123456" and passes on the codebase
- Accessibility: the sidebar has role navigation with the label; index items are links or buttons with accessible names including the label.
- i18n: both catalogs have identical keys, and the guard passes. Lint reports 0 warnings.

MANUAL CHECK (document in the PR)
- Phone (about 360 px), light and dark: the settings list, opening each section, the back button and back arrow, long Ukrainian labels.
- Desktop: the sidebar and sections; the dashboard and Analytics bars are the same violet in both themes, and readable in dark.

OUT OF SCOPE
Moving fields between sections, new settings, search in settings, other visual redesign, removing the feature flags.
```
