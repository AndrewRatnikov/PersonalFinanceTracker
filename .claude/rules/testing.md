---
paths:
  - "vitest.config.ts"
  - "vite.config.ts"
  - "src/**/*.test.tsx"
  - "src/**/*.test.ts"
---

# Testing gotchas

## Vitest config must stay separate from vite.config.ts

`vite.config.ts` loads `@tanstack/react-start`'s `tanstackStart()` plugin plus
`nitro()` and `vite-plugin-pwa`'s `VitePWA()`. Under Vitest these break module
loading (`ReferenceError: module is not defined` from `node_modules/react/index.js`).

Vitest config lives in its own `vitest.config.ts` at the repo root, with only
`@vitejs/plugin-react`, the `@ -> ./src` alias, `environment: 'jsdom'`, and
`globals: true`. Do not add SSR/PWA/devtools plugins to it, and do not put a
`test` block back into `vite.config.ts` — Vite 8 doesn't recognize `test` as a
config key (`TS2769`), so it also breaks `tsc --noEmit`.

## Locale-dependent assertions

`toLocaleString()` output depends on the host's resolved locale (this machine
resolves `uk-UA`, not `en-US` — `(1234567).toLocaleString()` is `"1 234 567"`,
not `"1,234,567"`). Never hardcode a thousands-separator literal in a test that
asserts on `.toLocaleString()` output; use a local helper instead:

```ts
const fmt = (n: number) => n.toLocaleString()
```
