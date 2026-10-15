# Orchestrator prompt: Main currency + conversion (NBU rates)

Starts from `main` at 412f7dd (recurring transactions merged).

Decisions (2026-10-15):
- Currencies stay UAH / USD / EUR for now.
- Default main currency is UAH.
- Budgets are always in the main currency.
- Analytics loses its currency dropdown and "Not included".
- The Recurring page monthly total is shown "≈" in the main currency at today's rate.
- The manual-rate field is stored now; its UI comes later.
- Rate fetching is on by default, disclosed, and can be switched off.
- Rates come from NBU behind a swappable provider; CORS gets a manual test after implementation.
- Converted values are stored unrounded and rounded only in the UI.
- No persistent rates table.

```text
Add a main currency to MinimaSpend and convert every expense and income entry into it, using official National Bank of Ukraine (NBU) rates for the entry's date. Each entry keeps what the user typed (amount + currency) as the source of truth, plus a stored conversion into the main currency. When the user changes the main currency, all entries are recalculated. Where this prompt is silent, follow the existing patterns in src/lib/localDb.ts and record a CONTRACT_GAP.

CONTEXT
- Currency = 'UAH' | 'USD' | 'EUR' (src/lib/domain.ts). Expense, IncomeEntry, BudgetEntry and RecurringItem each carry `amount` + `currency`.
- Today nothing is converted:
  - dashboardSummary uses a `baseCurrency` (default 'UAH') and lists other currencies as `excluded` / "Not included"
  - Analytics has a currency <select> (analytics-currency-select) and filters to it
  - the Recurring page shows per-currency monthly totals
  - docs/adr/2026-09-30-one-currency-at-a-time-no-conversion.md records that decision; this run replaces it
- Plaintext settings live in `meta:settings` via src/lib/appSettings.ts (getAppSettings / update helpers, APP_SETTINGS_QUERY_KEY).
- Writes:
  - every mutation runs under withWriteLock and then calls afterCommit
  - a localDb helper writes several encrypted keys in ONE setMany transaction
  - prepareUnlockedVault runs after unlock (income categories, then processDueRecurring)
- Several currency selects are hard-coded <SelectItem value="UAH"> lists: SpeedEntryForm, AddIncomeForm, BudgetTab.

DATA MODEL
1. Expense and IncomeEntry gain an optional field:

   conversion?: {
     mainCurrency: Currency   // the main currency this conversion is in
     rate: number             // main-currency units per 1 unit of the entry's currency, unrounded
     mainAmount: number       // amount × rate, UNROUNDED
     rateDate: string         // YYYY-MM-DD of the provider rate actually used (may be earlier than the entry date)
     source: string           // provider id, e.g. 'nbu'; 'identity' when currency === mainCurrency; 'manual' when manualRate was used
   }
   manualRate?: { mainCurrency: Currency; rate: number }   // stored and honoured now; no editing UI in this run

   - An entry is CONVERTED when `conversion?.mainCurrency === settings.mainCurrency`. Otherwise it is PENDING.
   - Existing data needs no upfront migration: every old record is simply pending until the converter runs.
   - When `currency === mainCurrency`, the conversion is identity (rate 1, source 'identity') and never needs the network.
   - When `manualRate.mainCurrency === mainCurrency`, it is used instead of the provider (source 'manual'). After a main-currency change it no longer applies, and the provider rate is used.
2. Settings (meta:settings via appSettings.ts):
   - mainCurrency: Currency, default 'UAH'
   - fetchExchangeRates: boolean, default true
   A missing field means the default.
3. BudgetEntry.currency must always equal the main currency (see step 9).
4. Never round stored values. Round only when displaying: add one helper, e.g. formatMoney(value, currency) → 2 decimals with locale-aware formatting, and use it everywhere amounts are shown.

RATE PROVIDER (easy to replace)
5. New folder src/lib/rates/:
   - types.ts:
       interface RateProvider {
         id: string
         // Rates for the latest published day on or before `date` (YYYY-MM-DD).
         // perBase[c] = units of `base` per 1 unit of c; perBase[base] = 1.
         getRates(date: string): Promise<{ base: Currency; effectiveDate: string; perBase: Partial<Record<Currency, number>> }>
       }
   - crossRate(rates, from, to) = perBase[from] / perBase[to]. It throws a typed RateUnavailableError when either is missing.
   - nbu.ts: createNbuProvider({ fetchJson, baseUrl }), where fetchJson is injectable for tests.
     - URL: `${baseUrl}/NBUStatService/v1/statdirectory/exchange?json&date=YYYYMMDD`, with default baseUrl https://bank.gov.ua.
     - The response is an array of { cc, rate, exchangedate: 'DD.MM.YYYY' }; base = 'UAH'.
     - Only `date` is ever sent. No amounts, ids or other user data.
   - index.ts: the single place that chooses the active provider: `export const rateProvider = createNbuProvider(...)`. Everything else imports from here.
     Document in CLAUDE.md how to swap it, e.g. for a server function on Vercel if NBU blocks browser calls (CORS). That gets tested manually after this run; do NOT build a proxy now.
6. Check NBU behaviour and handle it, recording what you find in the ADR:
   - Does NBU return a rate for weekends and holidays? Whatever the answer, if a date returns no rate for a needed currency, step back one day at a time, up to 7 days, and report the date actually used as effectiveDate.
   - Rate limits and errors: at most 3 concurrent requests; retry 429 / 5xx / network errors with exponential backoff (max 3 tries); on final failure throw RateUnavailableError.
   - Cache rates in memory per date for the lifetime of one conversion run only. No persistent rates table, by design.

CONVERSION ENGINE (src/lib/conversion.ts)
7. convertPending({ signal?, onProgress? }) → { converted, stillPending }:
   - Read settings.mainCurrency.
   - Find every expense and income record that is pending.
   - Identity records (currency === mainCurrency) and valid manualRate records are converted without any network call.
   - For the rest:
     - if fetchExchangeRates is false, leave them pending
     - otherwise group them by the entry's LOCAL calendar date (same rule as the rest of the app) and fetch rates once per date, through the provider
   - Write results in batches per storage key (each expenses_YYYY_MM chunk, and `income`). Under withWriteLock, re-read the records and update ONLY the `conversion` field of records that are still pending and whose amount, currency and createdAt haven't changed since the rates were fetched. A concurrent edit must never be overwritten. Then call afterCommit.
   - Resumable and idempotent: if aborted (signal), offline or failing partway, everything written so far stays valid, and the next run continues.
   - It never throws for a missing rate; affected records just stay pending. A DecryptError still propagates to the Data problem screen as today.
8. Run convertPending:
   - after unlock, in prepareUnlockedVault, AFTER processDueRecurring so generated entries are included
   - after a main-currency change (step 9)
   - on the window `online` event while unlocked
   - after a CSV import and after a backup restore
   - after every addExpense / addIncome / updateExpense / recurring generation or confirmation
   Only one run at a time per tab (coalesce). Cross-tab safety comes from the locks and the "still pending and unchanged" check.
   - Saving never waits for the network. New and edited records are saved immediately: identity-converted when in the main currency, otherwise pending, then converted in the background.
   - Editing amount, currency or date clears `conversion` (unless identity applies).

MAIN CURRENCY CHANGE + BUDGETS
9. changeMainCurrency(next):
   - Refuse with a clear message when offline or when fetchExchangeRates is off, unless no data needs a rate. Budgets need today's rate.
   - In one locked step:
     - convert every budget's monthlyLimit with today's rate, newLimit = limit × crossRate(old → next), stored unrounded, and set budget.currency = next
     - set settings.mainCurrency = next
   - Then run convertPending with progress.
   - Budgets created from now on always use the main currency: remove the currency select from BudgetTab.
   - One-time fix for existing data: any budget whose currency ≠ mainCurrency is converted at today's rate the first time rates are available. Until then it is excluded from comparisons, with a note.

TOTALS AND UI
10. Every total uses conversion.mainAmount of CONVERTED records in the main currency. PENDING records are excluded and counted.
    - Applies to: dashboardSummary (month income/expenses/net, left to spend, pace, budget watch), localAnalytics (category breakdown, income breakdown, timeline, totals, budget variance), the analytics monthly stats, and BudgetSummaryCard.
    - Remove `baseCurrency`, `excluded` / ExcludedCurrencyTotal, formatExcluded, the "Not included" lines and analytics-currency-select. The main currency comes from settings.
    - Wherever a total is shown and pending records exist in that period, show a note, e.g. "2 entries waiting for exchange rates" (data-testid="conversion-pending-note"), with a link to Settings → General when rate fetching is off.
11. Entry display (TransactionsTable, IncomeTable, RecentActivityList):
    - an entry in the main currency shows its amount as today
    - otherwise show the typed value and the converted value, e.g. "20.00 USD ≈ 830.40 UAH", with title "1 USD = 41.52 UAH · NBU · 14 Oct"
    - a pending entry shows "20.00 USD · rate pending"
12. Recurring page: replace the per-currency monthly totals with one "≈" total per kind in the main currency, converting each item's monthlyEquivalent at today's rate.
    - Items already in the main currency are exact.
    - If today's rates are unavailable, fall back to the current per-currency list, with the note "Exchange rates unavailable".
13. Settings → new "General" tab (first tab), data-testid="settings-tab-general":
    - Main currency select (settings-main-currency). Changing it opens a confirm dialog: "Recalculate N entries in EUR. Budgets will be converted at today's NBU rate." It shows progress ("Converting… 120 / 480") and the budgets note when done.
    - "Fetch exchange rates from the National Bank of Ukraine" switch (settings-fetch-rates), with the explanation "Only dates are sent, never amounts. When off, entries in other currencies aren't included in totals."
    - Status line: "All entries converted" or "N entries waiting for exchange rates".
14. Landing page privacy section: add one sentence: exchange rates come from the National Bank of Ukraine, and only dates are sent, never amounts.
15. Replace the hard-coded currency SelectItem lists with CURRENCIES.map(...) (SpeedEntryForm, AddIncomeForm, RecurringForm and any other). The default selected currency for new entries is settings.mainCurrency.

BACKUP, CSV
16. Backup: the records already carry `conversion` / `manualRate` and round-trip unchanged.
    - payload.settings gains optional mainCurrency and fetchExchangeRates. Replace restores them; merge keeps the local values.
    - After any restore, convertPending fixes any mismatch.
    - Backups made before this change restore and become pending.
17. CSV:
    - expenses.csv and income.csv get two trailing columns, main_amount (unrounded) and main_currency, empty when pending.
    - Import ignores those columns: imported records start pending and get converted.
    - budgets.csv keeps its columns, with currency = main currency.
    - Detecting a file's type by its headers must keep working.

CONSTRAINTS
- No new runtime dependencies.
- Do not change the meta:vault header, the encryption, or the backup `version`. Payload changes are additive only.
- Network: the only allowed request is the provider's rate call, and it carries only a date.
- Keep CURRENCIES = UAH / USD / EUR. Adding currencies later must only mean extending the union and list; nothing else may hard-code three currencies.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass. Tests never call the real NBU; inject fetchJson.
- Docs:
  - new ADR "Main currency with stored per-entry conversion (NBU)", recording what you found in step 6
  - mark docs/adr/2026-09-30-one-currency-at-a-time-no-conversion.md as superseded
  - add a section "15. Main currency" to docs/free-tier-spec.md
  - update CLAUDE.md (data model, provider swap point, where conversion runs)

ACCEPTANCE (each must be a test)
- NBU provider:
  - Parses a fixture response into perBase { UAH: 1, USD: 41.52, EUR: 45.10 } with effectiveDate from exchangedate.
  - The request URL contains only the date.
  - A date returning [] steps back to the previous day and reports that effectiveDate.
  - It stops after 7 days with RateUnavailableError.
  - It retries 429 and 5xx up to 3 times and runs at most 3 requests at once.
- crossRate: USD→EUR = 41.52 / 45.10 and EUR→UAH = 45.10, from one NBU response.
- convertPending:
  - With main UAH, a 20 USD expense on 2026-10-14 gets { mainCurrency 'UAH', rate 41.52, mainAmount 830.4, rateDate '2026-10-14', source 'nbu' }. A 100 UAH expense gets identity without any fetch.
  - Running it again makes no fetch and no write.
  - Records on 3 distinct dates cause exactly 3 fetches.
  - Abort it after the first chunk; the next run converts only the rest.
  - An expense edited (amount changed) between the fetch and the write is not overwritten and stays pending.
  - With fetchExchangeRates false: zero fetch calls, and non-main entries stay pending.
  - A manualRate for the current main currency is used with source 'manual' and no fetch.
- Saving never waits for the network: addExpense with the provider hanging resolves immediately with a pending record, which becomes converted after the provider resolves.
- changeMainCurrency('EUR'):
  - budgets are converted at today's rate (unrounded) with currency 'EUR'
  - all entries become pending, then converted to EUR
  - totals never mix UAH and EUR: pending entries are excluded and counted
  - while offline it refuses with a message and changes nothing
- Totals:
  - dashboardSummary and computeRangeAnalytics sum mainAmount of converted records, ignoring pending ones and reporting their count
  - the analytics currency select and "Not included" no longer render
  - budget variance compares in the main currency
- UI:
  - a USD entry renders "20.00 USD ≈ 830.40 UAH"
  - a pending entry renders "rate pending"
  - conversion-pending-note appears when a period has pending entries
  - the Settings General tab changes the main currency through the confirm dialog
- Recurring: the monthly total shows one "≈" value in the main currency, and falls back to per-currency when rates fail. Generated entries get converted after processDueRecurring.
- Backup and CSV:
  - conversion fields round-trip
  - a backup made before this change restores as pending
  - expenses.csv has main_amount and main_currency columns
  - importing an exported file still works and produces pending records
- Stored mainAmount is unrounded (e.g. 33.3333…). The UI shows 33.33.

MANUAL CHECK (document the result in the PR, not automatable)
Run the production build in a real browser:
- Add a USD expense and confirm it converts with the NBU rate.
- In DevTools → Network, confirm the only external request is bank.gov.ua with just the date.
- If the browser blocks the request (CORS), say so clearly in the PR. The provider swap point (src/lib/rates/index.ts) is where a server-function version will go in a follow-up run.

OUT OF SCOPE
Adding more currencies, a persistent rates cache, a UI for editing manual rates, alternative rate providers, a server proxy, paid sync.
```
