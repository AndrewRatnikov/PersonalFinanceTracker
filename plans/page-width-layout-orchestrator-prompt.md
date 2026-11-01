# Orchestrator prompt: One page width (1152 px) and desktop layouts that use it

Starts from `main` after the grouped Settings navigation + chart colour run is merged.

```text
Make every app page use the same width as the header on desktop (max 1152 px, same side padding), and rework the pages that are currently narrow so they use the space well instead of stretching. Phones must look the same as today. UI only. Where this prompt is silent, follow existing patterns and record a CONTRACT_GAP.

CONTEXT (current state)
- Header: `px-4 md:px-8 max-w-6xl mx-auto` (1152 px).
- Transactions and Income: `p-4 md:p-8 max-w-6xl mx-auto` (1152 px).
- Settings: `max-w-xl md:max-w-5xl` (576 / 1024 px) with the new sidebar; `px-4 sm:px-6`.
- Recurring: `max-w-3xl` (768 px), `p-4 md:p-8`.
- Dashboard (src/routes/index.tsx), Analytics and Profile: `max-w-xl` (576 px), `px-4 sm:px-6`.
- Terms / Privacy: `max-w-2xl` (672 px). Join: `max-w-md`. Login: `max-w-sm`.
- So there are four different app widths and two padding styles, and content edges don't line up with the header.
- Testing rules: .claude/rules/testing.md (jsdom has no layout, so test classes and structure, not pixels).

1. ONE PAGE CONTAINER
   - Create src/components/PageContainer.tsx: the single source of the page width and side padding, matching the header exactly (max-w-6xl, mx-auto, px-4 md:px-8), plus the existing top and bottom spacing.
     - prop `width?: 'full' | 'reading'`: 'full' (default) is 1152 px; 'reading' is 672 px (max-w-2xl) for text pages
   - The Header uses the same container (or the same shared class constant), so their edges always line up.
   - Every app route uses PageContainer instead of its own max-w / padding: Dashboard, Transactions, Income, Recurring, Analytics, Settings, Profile, Terms and Privacy ('reading'), and any other in-app page found.
   - Unchanged: Login and Join keep their small centred cards (max-w-sm / max-w-md), and the Landing page keeps its own layout.
   - Add a guard test: no route file under src/routes (except login and join) and no page-level wrapper sets its own `max-w-*` on the outermost page element. Page width comes only from PageContainer. Inner elements (cards, forms, prose) may still use max-w.

2. DASHBOARD (desktop layout, lg and up; phone order unchanged)
   - At lg (1024 px) and up, a 3-column grid (CSS grid, gap matching the current card spacing):
     - main area, 2 columns wide: Quick Add with the Repeat-last chips; the monthly spending chart; Recent activity
     - side column, 1 column wide: the summary stats ("Spent this month", income, "Left to spend" / budget card); the Family by-member card when in Family; upcoming recurring
   - Banners (conversion pending, backup reminder, read-only / paused Family, empty-Family actions) stay full width above the grid.
   - Between md and lg: use 2 equal columns or keep a single column, whichever avoids cramped cards. Document the choice.
   - Below md: exactly the current single-column order.
   - Charts must resize with their container (ResponsiveContainer) and keep a sensible height (no 1100 px wide, 150 px tall charts).

3. ANALYTICS (desktop layout)
   - Full width: the filters bar (date range, member filter) and the summary numbers row.
   - From lg: charts in a 2-column grid: the category donut next to the 12-month timeline; the budget-vs-actual chart next to the income breakdown; the Family "By member" section next to the remaining card, or full width when there is no partner card. Each card gets equal height in its row.
   - Below lg: the current single column, same order.

4. RECURRING (desktop layout)
   - The page goes full width. The upcoming / due section spans the full width at the top.
   - From lg: the list of recurring items becomes a 2-column grid of the existing row cards, or a table-like list with aligned columns (name, amount, frequency, next date, actions), whichever fits the current RecurringRow better. Document the choice.
   - Forms and drawers stay as they are.

5. SETTINGS
   - The page uses the full container: the sidebar (from the previous run) on the left, the section on the right.
   - The section content (forms, cards, lists) stops at about 672 px (max-w-2xl) and is left-aligned next to the sidebar, so inputs never stretch across 900 px.
   - Phone list and back navigation unchanged.

6. TRANSACTIONS, INCOME, PROFILE, LEGAL
   - Transactions and Income: switch to PageContainer. Nothing should visibly change except the padding now matching the header exactly.
   - Profile: PageContainer, with the profile card centred at about 576 px.
   - Terms and Privacy: PageContainer width="reading" (672 px, centred).

CONSTRAINTS
- UI only: no data, sync, routing or behaviour changes. No new runtime dependencies. Theme tokens only, and light and dark must both look right.
- Phones (below md) must look the same as before for every page. Existing UI tests keep passing; update only class or structure assertions that are intentionally changed.
- No horizontal page scroll at any width from 320 px to 2560 px. On very wide screens the content stays 1152 px and centred.
- The drawer, the dialogs and the space switcher are unaffected.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass.
- Docs:
  - CLAUDE.md: "Every page uses PageContainer; full width is 1152 px; use 'reading' for text pages; inner forms max 672 px"
  - a short ADR "One page width shared with the header"

ACCEPTANCE (each must be a test)
- PageContainer renders max-w-6xl with the header's padding classes by default, and max-w-2xl with width="reading".
- Header and PageContainer use the same width and padding (shared constant or identical classes, asserted).
- Each route (Dashboard, Transactions, Income, Recurring, Analytics, Settings, Profile, Terms, Privacy) renders inside PageContainer. Terms and Privacy use 'reading'. Login and Join do not use it.
- The guard test fails on a sample route whose outer element has max-w-xl, and passes on the codebase.
- Dashboard:
  - the grid container has the lg 3-column classes
  - the main and side areas contain the specified sections in order
  - in DOM order (which phones follow) the sections keep their previous order
- Analytics: the chart grid has lg 2-column classes, and the filters and summary sit outside the grid.
- Recurring: the list uses the chosen lg layout classes.
- Settings: the section content wrapper is limited to max-w-2xl on desktop.
- i18n untouched apart from any new labels (both catalogs identical; guard passes). Lint reports 0 warnings.

MANUAL CHECK (document in the PR, with screenshots)
- 1440 px and 1920 px: all pages share the header's left and right edges; Dashboard and Analytics use the width without stretched cards; charts have good proportions.
- 1024 px and 768 px: no cramped cards, no overflow.
- 360 px phone: every page looks as before.
- Light and dark themes.

OUT OF SCOPE
Landing page layout, new dashboard widgets, changes to card content, the drawer, navigation structure.
```
