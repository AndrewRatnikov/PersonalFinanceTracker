# Custom typed i18n catalog, language via cookie + localStorage

- **Status:** Accepted
- **Date:** 2026-10-21
- **Source:** orchestrator run `run_20261021_071241` (Ukrainian i18n for MinimaSpend; no new runtime dependencies, per the task)
- **Code:** `src/i18n/core.ts`, `src/i18n/messages/en.ts`, `src/i18n/messages/uk.ts`, `src/i18n/resolve.ts`, `src/i18n/server.ts`, `src/i18n/react.tsx`, `src/routes/__root.tsx`, `scripts/untranslatedText.ts`

## Context

MinimaSpend needed Ukrainian next to English. The task forbade new runtime dependencies. The app renders on the server (TanStack Start) and also ships a prerendered offline SPA shell (see [2026-10-08-offline-navigations-fall-back-to-spa-shell](2026-10-08-offline-navigations-fall-back-to-spa-shell.md)). The shell is built once and has no request, so it cannot know the language. The server must render the right language on first paint, and hydration must match it.

## Decision

- **Catalog:** a nested `as const` English catalog (`src/i18n/messages/en.ts`) is the source of truth. The Ukrainian catalog (`messages/uk.ts`) is typed to have exactly the same keys, so a missing key is a compile error. `src/i18n/core.ts` is React-free (`t`, `plural`, `getLang`, `setLang`) so `src/lib` can use it. `src/i18n/react.tsx` holds `I18nProvider` and `useT()`.
- **Storage:** the choice is stored in `localStorage` and in a cookie, both named `minima_lang` (cookie max-age one year).
- **Server:** the root route `loader` in `src/routes/__root.tsx` calls `getRequestLang()` (`src/i18n/server.ts`, a `createIsomorphicFn`). On the server it reads the `minima_lang` cookie, then `Accept-Language` (any `uk*` tag gives `uk`; Russian never maps to Ukrainian), else `en`. It returns `null` for the prerendered shell. Loader data is dehydrated, so hydration uses the server's language. The server import is dynamic, so jsdom tests never load server code.
- **Offline shell:** with `lang: null`, `<body>` is `visibility: hidden` until a layout effect in `I18nProvider` resolves the language on the client (stored choice, then `navigator.languages`) and re-renders, before first paint.
- **Stored vs. cookie conflict:** the stored choice wins on the client. If it differs from the server's language, the client switches once on mount and re-writes the cookie.
- **Guard:** `scripts/untranslatedText.ts` (TypeScript compiler API, run from a test) fails on new untranslated JSX text.

## Alternatives considered

- An i18n library: rejected, the task forbids new runtime dependencies.
- Per-language URLs: out of scope for the task.
- An inline `<head>` script that sets `<html lang>`: cannot change English text already rendered in the shell and would cause hydration mismatches.
- Reading the cookie in `beforeLoad`: it already short-circuits on the server for its redirect logic, so the loader is used instead.

## Consequences

- Compile-time key safety and no flash or hydration mismatch on SSR and on the shell, with zero dependencies.
- The offline shell shows a blank page for the moment before the language resolves.
- If the cookie is cleared but `localStorage` is kept, a returning user sees one flash of the Accept-Language language.
- Other open tabs are not told about a switch; each picks it up on its next load.
- `I18nProvider` sets module-level language during render. This is safe on the server only because no formatted user data is rendered there; revisit if the server ever renders vault data.
- Lib code stays React-free: errors carry stable codes mapped in the UI, and lib text helpers read text through `src/i18n/core.ts`. Adding a third language means one new catalog file plus the `Lang` union.
