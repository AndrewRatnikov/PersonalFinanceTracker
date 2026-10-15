# Main currency with stored per-entry conversion (NBU)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Source:** orchestrator run `run_20261015_072433` (main currency and per-entry NBU conversion)
- **Code:** `src/lib/rates/nbu.ts`, `src/lib/rates/index.ts`, `src/lib/conversion.ts`, `src/lib/money.ts`, `src/lib/localDb.ts`, `src/components/ConversionRunner.tsx`, `src/components/settings/GeneralTab.tsx`
- **Supersedes:** [2026-09-30-one-currency-at-a-time-no-conversion](2026-09-30-one-currency-at-a-time-no-conversion.md)

## Context

Totals were computed one currency at a time and other currencies were listed as "Not included" (see the superseded ADR). The user asked for one comparable total across UAH, USD and EUR. That ADR rejected conversion because it needs a rate source and a network call. This run accepts that call, limited to sending a date.

## Decision

- Settings hold a `mainCurrency` (default UAH). Each expense and income record gets an optional, unrounded `conversion` into it, computed from official NBU rates for the entry's local date. The typed amount and currency stay the source of truth. Rounding happens only when displaying.
- Rates come from a provider behind one swap point, `rateProvider` in `src/lib/rates/index.ts`. The NBU implementation is `createNbuProvider` in `src/lib/rates/nbu.ts`.
- `src/lib/conversion.ts` converts in the background: it reads pending records, fetches each needed date once, and writes back only the `conversion` field. `ConversionRunner` mounts `startAutoConversion`. localDb emits `onConversionNeeded` after entry writes, restore and vault unlock, and runs coalesce. The converter's own writes (`applyEntryConversions`, `convertBudgets`) don't retrigger it.
- Every total (dashboard, Analytics, budgets, recurring) sums `mainAmountOf()`: the stored conversion, else the amount when the entry's currency is the main one, else pending. Pending entries are left out and counted ("N entries waiting for exchange rates").
- Changing the main currency (Settings -> General) converts budgets at today's rate and writes `mainCurrency` together with `budgets` in one `setMany` inside `localDb.convertBudgets`. `updateCurrencySettings` only changes `fetchExchangeRates`.
- Converter writes change only `conversion`, never `updatedAt`, so derived data never wins a backup merge over a real edit on another device ([2026-10-08-backup-restore-rules](2026-10-08-backup-restore-rules.md) is unchanged). After a merge or restore, the converter fixes any mismatch.

### NBU behaviour (probed with curl on 2026-10-15)

- Endpoint: `GET https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&date=YYYYMMDD`, about 45 rows `{ r030, txt, rate, cc, exchangedate: 'DD.MM.YYYY', special }`, rates in UAH per unit.
- Weekends and holidays do return rates, with `exchangedate` equal to the requested date (Sat 2026-10-10 and Sun 2026-10-11 both gave USD 44.8526; 2026-01-01 and 2026-08-24 also returned rates).
- Future dates and very old dates (1990-01-01) return `200 []`. This is why the provider steps back.
- CORS: GET and an OPTIONS preflight both return `access-control-allow-origin: *`.
- Cloudflare sets a `__cf_bm` cookie, so requests use `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. Only the date leaves the device.
- No documented rate limit.

### Provider limits

- A date that returns no usable table steps back one day. At most 7 dates are requested per lookup (`NBU_MAX_LOOKBACK_DAYS`: the date and the 6 days before). A day counts only if it has a positive rate for every currency in `CURRENCIES`, otherwise a cross rate would be missing.
- At most 3 requests at once (`NBU_MAX_CONCURRENT`). Each request is tried 3 times (`NBU_MAX_TRIES`) on 429, 5xx or network errors, with exponential backoff starting at 500 ms.
- No cache in the provider. The converter fetches each date once per run.

## Alternatives considered

- **Convert at read time from a persistent rates table.** Lost: out of scope, and totals would change silently whenever rates were re-fetched.
- **Keep one-currency-at-a-time totals.** Lost: the user wanted one comparable total.
- **A server proxy for rates.** Lost: out of scope. `src/lib/rates/index.ts` is where it would go.
- **Widen `AppSettings` with the currency fields.** Lost: it breaks typed test fixtures, and `updateAppSettings` could change the main currency without converting budgets.
- **Count only the stored conversion in totals.** Lost: right after the upgrade every existing UAH entry would show as pending until the converter ran, although the conversion is identity.
- **Call `requestConversion` from every mutation's `onSuccess`.** Lost: easy to miss a path (CSV import, recurring generation, other tabs). Having localDb import conversion.ts was also ruled out: it creates an import cycle.
- **Bump `updatedAt` on conversion writes.** Lost: it would make background conversions win merges over real edits.
- **8 dates (the date plus 7 step-backs).** Lost: no practical difference, since NBU publishes daily. 7 is unambiguous in tests.

## Consequences

- Totals are stable, work offline once converted, and are reproducible. Past entries keep the rate of their own date even if rates change later.
- Entries whose date has no published rates yet (today before publication, or a device clock ahead) step back to the latest published day. Entries that can't be converted stay pending and are excluded from totals until rates arrive. With `fetchExchangeRates` off, the Settings -> General link explains why.
- The app now makes a network request to bank.gov.ua, carrying only a date. The landing page says so.
- Because `mainAmountOf` treats main-currency entries as converted, those entries show no pending flash after upgrade, while the converter still writes their identity conversions.
- **Not yet verified:** the manual browser check (CORS from the real origin, request headers and the network panel) is still pending. The CORS finding comes from curl only. If the browser blocks the call, replace the provider in `src/lib/rates/index.ts` (for example, behind a server function).
- Revisit if NBU adds a rate limit or changes the response shape, or if rounding or conversion at the entry's date turns out to confuse users.
