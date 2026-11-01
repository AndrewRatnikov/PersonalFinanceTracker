# Settings is a grouped list on phones and a sidebar on desktop, both driven by the `?tab=` param

- **Status:** Accepted
- **Date:** 2026-11-01
- **Source:** orchestrator run `run_20261101_145216` (settings layout and shared chart colours; the layout task came from the user)
- **Code:** `src/routes/settings.tsx`, `src/components/settings/SettingsNav.tsx`, `src/lib/settingsSections.ts`, `src/lib/useIsDesktop.ts`

## Context

Settings had eight tabs (General, Categories, Budget, Security, Data, Account, Sync, Family) in one Radix Tabs row that overflowed on phones. Many links already point at `/settings?tab=<id>`: the login redirect, the header cloud icon, the Family badge and join flow.

## Decision

- `src/lib/settingsSections.ts` is the registry of section ids, groups, icons, label keys and visibility rules. The route passes in the feature flags.
- `useIsDesktop` (matchMedia `(min-width: 768px)`, Tailwind `md`) picks one layout, and only that layout is rendered.
- Desktop shows a sidebar, with General selected when `?tab=` is absent. Phone shows the grouped list at `/settings` and a single section with a back arrow when `?tab=` is set.
- `?tab=` and its `validateSearch` are unchanged. Only the selected section is mounted, as with Tabs.
- Phone taps on a list item push `?tab=<id>`. Desktop clicks replace it. The phone back arrow calls `navigate({ search: {}, replace: true })`.

## Alternatives considered

- CSS-only responsive, with both layouts mounted and one hidden by `md:hidden`: rejected. At `/settings` the phone shows the list and desktop shows General, so both would mount. That breaks "only the selected section is mounted", doubles data loading, and jsdom cannot tell which layout is visible.
- Nested routes `/settings/$section`: rejected, because they break every `?tab=` deep link and the login redirect.
- Tabs with horizontal scroll: rejected by the task.
- Back arrow with `history.back()`: rejected, because a deep link from elsewhere would leave the app, and telling "came from the list" apart needs extra history state.
- Back arrow pushing `/settings`: rejected, because the phone back button would then return to the section.

## Consequences

- All existing deep links keep working. Tests choose the layout by mocking matchMedia.
- The first render depends on matchMedia. The hook handles environments without it.
- The back arrow uses `replace`, so it works on direct deep links. After list, section, arrow, history holds a duplicate list entry. The user can't see it, but the phone back button passes through it.
- A new section is added in `settingsSections.ts`. Its visibility rule lives there too.
