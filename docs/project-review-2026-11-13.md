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

## Competitor analysis (added 2026-11-16)

Based on public web sources checked on 2026-11-16 (listed at the end). Prices and features change; several sources are vendor blogs or comparison sites, so treat the details as indicative. None of these apps was tested hands-on.

**MinimaSpend's main idea, used as the yardstick:** fast manual entry, private by design (encrypted on the device, no account, no bank credentials), works offline, data is portable, built first for Ukraine (UAH, NBU rates, Ukrainian UI).

### Who the competitors are

| Group | Examples | What they offer | Where MinimaSpend differs |
| --- | --- | --- | --- |
| Local-first, open source | Actual Budget | Envelope budgeting, offline, multi-device sync through a server you run or rent, optional end-to-end encryption, imports QIF/OFX/CSV, optional bank sync in the US/EU/UK | Actual's own docs say data on the device is not encrypted. It needs a server for sync and is a full budgeting system, not a quick tracker. No Ukrainian focus. |
| Free manual trackers | Cashew, Monefy, Pocket Clear | Fast manual entry, free core. Cashew: open source, PWA, biometric lock, savings goals, subscription tracking, Google sign-in and Drive backup. Pocket Clear: Pro at $4.99/month for encrypted sync. | Closest group. Cashew's sync and backup depend on a Google account. MinimaSpend has no biometric unlock, goals or subscription view yet. |
| Paid cloud budgeting | YNAB, Monarch Money, Copilot | Automatic bank import, full household finance. YNAB $109/year, Monarch $99.99/year, no permanent free tier. | Opposite philosophy (cloud, bank credentials, US banks). Not a real alternative for a Ukrainian user, but sets the price ceiling. |
| Shared / family | Goodbudget, Spendee, Honeydue | Goodbudget: manual envelopes, household sync, about $10/month or $80/year. Spendee: shared wallets in Premium, about $4.99/month. Honeydue: free for couples. | None was found to advertise end-to-end encryption for shared data. MinimaSpend's Family space does, but lacks "who owes whom". |
| Ukraine-specific | monobank's built-in statistics, GroshMeister, Saldo, WiseWallet | Automatic import of monobank transactions through its open API; GroshMeister also takes PrivatBank statement files and shows net worth. | The strongest local pressure: for a single-bank monobank user the bank's own statistics are reported to be good enough. These apps win on zero typing; MinimaSpend wins on privacy, multi-bank and cash, and no account. |

### What the market says

1. **Manual entry is the weak point everyone attacks.** Reviews repeat that people quit trackers because logging feels like data entry. Competitors answer with bank sync, or with faster entry (text, voice, photo).
2. **Ukraine is moving toward bank import.** monobank has had an open API for years, and Ukraine's open-banking technical requirements for bank APIs took effect on 1 August 2026. Expect more local apps with automatic import.
3. **"Private" usually means "no bank link", not "encrypted".** Among the apps reviewed, encryption of data on the device itself, with no account at all, was not found elsewhere. That is MinimaSpend's clearest difference, and the landing page should say it in those words.
4. **Paid tiers for sync and sharing sit around $5–10/month** for small apps (Pocket Clear, Spendee, Goodbudget) and about $100/year for the big cloud apps.

### Positioning

> The private expense tracker: encrypted on your device, no account, no bank password. Add an expense in seconds, offline. Sync and share with family only if you choose to, and still end-to-end encrypted.

Do not compete on automation with bank-connected apps or on budgeting depth with YNAB and Actual.

---

## Planned features (revised 2026-11-16)

Each feature is checked against the main idea. This list replaces the earlier "What to add next".

### Now: finish what is built

1. **Ship accounts, then sync, then Family as a beta.** Encrypted multi-device sync and a shared space are what the paid competitors charge for, and they are already built and tested. Follow `docs/release/accounts-sync-family-checklist.md`. Fix the landing copy ("no premium tier", "syncs nothing") first.

### Next: remove the entry friction, without giving up privacy

2. **Biometric / passkey unlock (WebAuthn PRF).** Cashew already has a biometric lock. Typing a password after every auto-lock is MinimaSpend's biggest daily friction. Spec §10 already allows it as a third wrapping of the data key. *Fits: private, faster.*
3. **Bank statement file import (monobank, PrivatBank).** The user downloads a statement from the bank and imports it; parsing and category rules run on the device, and remembered rules ("Сільпо → Food") apply next time. Reuses the CSV import duplicate check. This answers the automatic-import apps with no token, no server and no bank password. *Fits: private, portable, Ukraine-first.*
4. **One-line quick entry.** Type "65 кава" or "120 usd hosting" and get amount, currency, description and a suggested category from your own history, parsed on the device. Builds on the existing description suggestions. The old PRD listed text parsing as out of scope; the market has moved since. *Fits: fast, private. No cloud AI.*
5. **More currencies.** Only UAH, USD and EUR today; the NBU feed already covers PLN, GBP, CHF and others. Small change, matters for anyone who travels or is paid abroad. *Fits: Ukraine-first.*

### Later: small additions that stay minimal

6. **Dashboard insights.** This month against last month, projected month-end total, a warning when a budget is nearly used. Computed locally from existing data.
7. **Subscriptions view.** A filtered view of recurring items with a monthly and yearly total. Cashew has this; MinimaSpend already stores the data.
8. **Family settle-up.** Entries already carry `paidBy`; add a "who owes whom" summary and a "settled" marker. The shared apps reviewed either lack it or lack encryption.
9. **Billing for the paid tier.** Only when the beta ends. Comparable small apps charge about $5–10/month for sync and sharing; the plans table and entitlement checks are ready.

### Needs a decision

- **Direct monobank API import.** The user would paste a personal monobank token and the app would fetch transactions straight from the bank, with no MinimaSpend server. It removes typing completely, but storing a bank token (even encrypted) weakens the "no bank credentials" promise, and it needs a check that the API can be called from a browser at all. Decide after the file import ships and you see how much it is used.

### Deliberately not building

These conflict with the main idea, even though competitors have them:

- **Bank sync through aggregators or stored bank passwords.** Breaks "no bank credentials".
- **Cloud AI categorisation, receipt photo or voice processing on a server.** Sends plaintext spending data off the device.
- **Envelope / zero-based budgeting.** YNAB, Actual and Goodbudget own this; it is not minimal.
- **Net worth, investments, crypto tracking.** A different product (GroshMeister, Monarch).
- **Savings goals and debt tracking.** Reasonable later, but each adds a concept to a tracker whose point is having few. Revisit only if users ask.
- **Ads or anything funded by user data.**

---

## Sources (competitor analysis)

- Actual Budget: https://actualbudget.org/ and https://actualbudget.org/docs/getting-started/sync/
- Actual Budget vs YNAB (July 2026): https://valebyte.com/en/blog/actual-budget-protiv-ynab-samohosting-na-vps/
- Cashew: https://github.com/jameskokoska/Cashew and https://pocketclear.app/blog/pocket-clear-vs-cashew.html
- YNAB and Monarch pricing: https://envelopebudgeting.com/articles/monarch-vs-ynab and https://getfinny.app/blog/monarch-money-pricing-2026
- Manual-entry trackers: https://joingerald.com/learn/financial-wellness/spending-tracker-apps-manual-entry-features and https://pocketclear.app/blog/best-app-to-track-spending.html
- Family apps: https://www.quicken.com/blog/?p=9653 and https://joingerald.com/learn/financial-wellness/costs-daily-spending-apps-large-families
- Ukraine: https://kosht.media/ukrainski-zastosunky-dlia-obliku-finansiv-desiatok-na-vybir-ale-z-synkhronizatsiieiu-vse-sumno/ , https://dev.ua/news/groshmeister-1787216137 , https://mezha.ua/blogs/groshmeister-piv-roku-na-vlasniy-finansoviy-dodatok-ale-nayvazhchim-viyavivsya-ne-kod-315613/ , https://dev.ua/news/zastosunok-obleek-1790331528
