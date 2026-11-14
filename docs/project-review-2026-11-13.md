# Project Review — 2026-11-13

Whole-project review of `main` at `5595ac5`: code, docs, ADRs, tests and git history. Unlike the code reviews in this folder (`code-review-2026-06-23.md`, `code-review-2026-10-05.md`), this one is about the state of the project, not individual bugs.

**Summary:** the app is well engineered. The main problems are around the code, not in it: stale docs, no CI, one oversized module, and three finished features (accounts, sync, Family) that are still switched off.

**Not verified:** the test suite was not run. `node_modules` was missing `fflate` and `@electric-sql/pglite` (run `npm install`). `tsc --noEmit` reported only errors caused by those two missing packages.

---

## What is good

- **Security design.** A random data key is wrapped by both the password and the recovery key, kept non-extractable in memory, with a brute-force delay and auto-lock. The server only ever sees ciphertext and opaque keys.
- **Data-safety discipline.** Undecryptable data is never overwritten (quarantine instead), every write is locked and atomic, deletes are tombstones, and a restore validates everything before writing.
- **Testing.** 277 test files (about 99k lines against 42k of source), including multi-device sync simulations and the real SQL migrations run in PGlite.
- **Guard tests for conventions.** Untranslated text, chart colours, who may call the cloud API, and dependency advisories are all enforced by tests.
- **Code hygiene.** Strict TypeScript, essentially no `any` or lint suppressions outside generated code, one leftover TODO.
- **Decision trail.** 23 ADRs, a full spec, a go-live checklist, and earlier code reviews whose findings are all marked fixed.
- **Product basics.** Works offline, needs no account, typed English and Ukrainian UI, encrypted backups, CSV import/export, recurring items and currency conversion.

---

## What should be updated

Ranked by how much each one costs you today.

### 1. `README.md` is still the TanStack starter template

It says nothing about the real architecture. `docs/prd.md` and `plans/backlog.md` still describe the old Supabase design, and the PRD lists currency conversion as out of scope although it is built.

**Fix:** rewrite the README (what the app is, local-first and encryption in a paragraph, commands, where the spec and ADRs live). Mark the PRD and backlog as historical or delete them; `docs/free-tier-spec.md` is the real source.

### 2. No CI

There is no `.github` folder. Tests, lint, typecheck and `test:precache` run only locally or in the orchestrator.

**Fix:** one GitHub Actions workflow on pull requests: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:precache`.

### 3. `src/lib/localDb.ts` is 4,574 lines

About 214 top-level functions: expenses, categories, income, budgets, recurring, sync hooks, spaces and conversion writes in one file. `src/lib/backup.ts` (1,696 lines) is the next candidate.

**Fix:** split by domain into `src/lib/localDb/` (core store/crypto/lock, then one file per record type, sync, spaces) and keep `localDb.ts` as a re-export so imports and test mocks stay unchanged.

### 4. `CLAUDE.md` is 77 KB

It is loaded into every agent session and will drift from the code as it grows.

**Fix:** move the per-area detail into `.claude/rules/*.md` files scoped by `paths` (the pattern `testing.md` and `dependencies.md` already use) and keep the root file to about a page.

### 5. No real-browser tests

Everything runs in jsdom with a mocked IndexedDB. The riskiest paths (WebCrypto, storage eviction, the service worker, iOS Safari) are untested on real engines.

**Fix:** a small Playwright suite: create vault, add expense, lock/unlock, offline reload, backup and restore. Run it on Chromium and WebKit.

### 6. Landing copy contradicts the roadmap

`src/i18n/messages/en.ts` (and `uk.ts`) promise "no premium tier", "$0 forever" and "it syncs nothing", while the code has plans, entitlements and sync.

**Fix:** reword before turning the flags on. Add it to `docs/release/accounts-sync-family-checklist.md`.

### 7. No error reporting

The go-live checklist says to watch client error reports, but no reporting was found in the code. Once sync is live, failures on users' devices will be invisible.

**Fix:** a minimal, privacy-safe reporter (error name and code only, never record data), or drop that line from the checklist.

### 8. Transactions load every expense into memory

`getAllExpensesIn` reads every month chunk and the page paginates in memory. The TODO at `localDb.ts:1063` already flags this.

**Fix:** page by month chunk (newest first) and load older chunks on demand.

### 9. Smaller items

- `nitro` is pinned to a nightly build (`nitro-nightly@3.0.1-20260402…`); move to a stable release when one exists.
- `@tanstack/react-devtools` and `@tanstack/react-router-devtools` are in `dependencies`; they belong in `devDependencies`.
- The dead `ENABLE_SUPABASE_SYNC` stub is still at the top of `localDb.ts`.
- History is mostly per-file "modify: x" commits; squash orchestrator runs on merge.

---

## What to add next

1. **Ship accounts, then sync, then Family as a beta.** The largest part of the codebase is built and tested but has never met real users. Work through `docs/release/accounts-sync-family-checklist.md`.
2. **Biometric or passkey unlock.** Typing a password after every auto-lock is the main friction for a quick-entry app on a phone. Spec §10 already leaves room for it as a third wrapping of the data key (WebAuthn PRF).
3. **Bank statement import.** A Monobank or PrivatBank CSV import with remembered category rules would cut manual entry without breaking the no-server promise. (No existing support was found, by keyword search only.)
4. **More currencies.** Only UAH, USD and EUR are supported; the NBU feed already in use covers many more.
5. **Dashboard insights.** Month-over-month comparison, a projected month-end total, and a warning when a budget is nearly used.
6. **Family settle-up.** Entries already record `paidBy`, so a "who owes whom" view is a natural next step.
7. **Billing.** The `plans` table and entitlement checks exist, but there is no payment flow. Add one only when the free beta ends.
