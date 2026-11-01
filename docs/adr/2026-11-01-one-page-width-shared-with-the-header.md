# One page width shared with the header

- **Status:** Accepted
- **Date:** 2026-11-01
- **Source:** orchestrator run `run_20261101_160957` (one shared page width and desktop layouts; the task asked for a single width source, the SpaceBanner inclusion was the Architect's call)
- **Code:** `src/components/PageContainer.tsx`, `src/components/Header.tsx`, `src/components/space/SpaceBanner.tsx`, `src/test/pageWidthGuard.test.ts`

## Context

Each route set its own wrapper width and padding, so page content and the header bar did not share left and right edges on wide screens. The task asked for one page width, owned in one place, with the header matching it.

## Decision

`src/components/PageContainer.tsx` is the only source of page width, gutter and default top spacing. `PageContainer` takes `width?: 'full' | 'reading'` (default `'full'`) and renders one `<div data-page-container={width}>` with `max-w-6xl` (or `max-w-2xl` for `reading`), `mx-auto px-4 md:px-8` and `pt-6`, merged with the caller's `className` by `cn`.

The component also exports `PAGE_FRAME_CLASS` (`max-w-6xl mx-auto px-4 md:px-8`, the full width plus the gutter). `Header` (both its bars) and `SpaceBanner` use that constant, so their edges equal the content edges. Tests assert that the constant equals the full width plus gutter token for token and that the header carries every token.

A `className` on `PageContainer` may set vertical spacing and layout (for example `py-4 md:py-8`, `flex flex-col gap-8`), never `max-w-*`, `px-*` or `mx-*`. `src/test/pageWidthGuard.test.ts` enforces this: no route under `src/routes` (except login and join, which keep their small centred cards) sets its own `max-w-*` on the outermost page element. Every in-app route and `NotFoundPage` render `PageContainer`; legal pages use `width="reading"`.

## Alternatives considered

- **Header renders `PageContainer` itself.** Rejected: the header bar needs `h-16 flex` and no `pt-6`, so the component would need an escape hatch.
- **A Tailwind `@utility page-frame` in `src/styles.css`.** Rejected: jsdom tests could not see the real tokens, and a guard could not tell it from a hand-written width.

## Consequences

Changing the page width is a one-line edit in `PageContainer.tsx`, and the header and banner follow. `PAGE_FRAME_CLASS` duplicates the width and gutter tokens as a literal (Tailwind scans source for literals), so the equality test is what keeps it honest. Inner cards and forms may still use their own `max-w-*` (forms up to `max-w-2xl`). A page that needs a different width has to become a new `PageWidth` value rather than override the class.
