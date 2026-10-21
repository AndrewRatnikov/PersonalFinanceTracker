# Orchestrator prompt: Ukrainian interface

Starts from `main` at fc327f7 (faster entry + drawer merged).

```text
Translate MinimaSpend into Ukrainian, with English kept as the second language. Ukrainian is the default for Ukrainian-language browsers, and the user can switch in Settings, on the landing page and on the unlock screen. Every user-visible string, number, date and plural must be correct in both languages. Where this prompt is silent, choose the simplest behaviour and record a CONTRACT_GAP.

CONTEXT
- Every UI string is hard-coded English in JSX: about 190 text nodes, toasts, aria-labels, placeholders and titles across src/components and src/routes. Some strings are built in lib code, e.g.:
  - src/lib/recurrence.ts describeFrequency: "Every month on the 31st", MONTH_NAMES, ordinal()
  - src/lib/money.ts pendingLabel
  - src/lib/conversion.ts CHANGE_ERROR_MESSAGES
  - vault/backup/import error messages that reach the UI
- Formatting today:
  - money.ts formatAmount uses toLocaleString(undefined, …), so the device locale decides
  - formatShortMoney is locale-free
  - dates use dayjs .format('MMM DD') etc. in ~8 files (TransactionsTable, IncomeTable, RecentActivityList, RecurringDashboardSection, RecurringRow, localAnalytics, analyticsUtils, analytics.tsx)
- <html lang="en"> is hard-coded in src/routes/__root.tsx. The app is SSR'd online and boots from a prerendered shell offline.
- Default categories (src/lib/localDb.ts DEFAULT_CATEGORIES, and the income defaults) are English and are written into a new vault.
- localStorage keys use the `minima_` prefix, and "Remove data" deletes all of them.
- Testing rule: this machine resolves uk-UA. Never hard-code separators in assertions.

1. I18N CORE (no new runtime dependencies)
   - src/i18n/messages/en.ts is the source catalog: a nested `as const` object grouped by area (common, nav, landing, vault, dashboard, transactions, drawer, income, recurring, analytics, settings, backup, errors, toasts).
   - src/i18n/messages/uk.ts is typed so it must have exactly the same keys. A missing or extra key is a type error.
   - src/i18n/index.ts:
     - type Lang = 'uk' | 'en'
     - t(key, params?) with {name} interpolation
     - plural(key, count) using Intl.PluralRules(lang) categories. Ukrainian needs one / few / many / other, e.g. 1 запис, 2 записи, 5 записів, 1,5 запису. English uses one / other.
     - a React context + useT() hook
     - getLang() / setLang() for non-React code
   - Keys are typed: t('dashboard.title') must autocomplete, and an unknown key is a type error.

2. LANGUAGE CHOICE AND PERSISTENCE
   - Resolution order:
     1. the stored choice
     2. otherwise 'uk' if any navigator.languages entry starts with 'uk'
     3. otherwise 'en'
     Do not map 'ru' to Ukrainian; it falls back to 'en'.
   - Store the choice in localStorage `minima_lang` AND a cookie `minima_lang` (path=/, SameSite=Lax, 1 year, not HttpOnly), so SSR renders the right language with no flash:
     - the server reads the cookie, then Accept-Language, using the same rules
     - <html lang> is set to 'uk' or 'en'
     - the offline shell resolves on the client before first paint (no English flash)
   - Switchers:
     - Settings → General → "Мова / Language" (native <select>, data-testid="settings-language")
     - a compact UK | EN toggle in the landing page header (data-testid="landing-language")
     - the same toggle on the vault screens (create / unlock / recover), so language can be chosen before unlock
     Switching updates the UI immediately without a reload, and updates <html lang>.
   - "Remove data" already clears minima_* keys. Also clear the cookie, so language goes back to automatic detection.

3. FORMATTING (one module, src/i18n/format.ts, replacing scattered calls)
   - formatAmount and formatMoney follow the UI language, not the device locale:
     - uk-UA: "1 234,50" (narrow no-break space)
     - en-US: "1,234.50"
   - Currency display:
     - Ukrainian shows UAH as "грн" ("830,40 грн") and keeps USD and EUR as codes ("20,00 USD")
     - English keeps codes everywhere ("830.40 UAH")
     Use it in every amount display, including "≈" conversions, chart tooltips and axis ticks, and toasts.
   - formatShortMoney becomes language-aware the same way ("65 грн" / "65 UAH").
   - Dates:
     - Intl.DateTimeFormat (or dayjs with the 'uk' locale loaded) through helpers formatDay ("14 жовт." / "Oct 14"), formatMonth ("жовтень 2026" / "October 2026"), formatShortMonth for chart axes, and formatFullDate
     - Replace every dayjs .format('MMM …') used for display
     - Keep machine formats (YYYY-MM-DD for storage, CSV, URLs) untouched
   - describeFrequency gets proper Ukrainian grammar, e.g.:
     - "Щомісяця, 31-го" / "Кожні 2 тижні" / "Щороку, 1 березня" / "Щодня" / "Кожні 3 дні"
     - English stays as today
     Write it as language-specific functions, not string concatenation in one template.
   - Amount inputs keep accepting both "," and "." in both languages.

4. TRANSLATE EVERYTHING USER-VISIBLE
   - All JSX text, toasts, aria-labels, placeholders, titles, alt texts, confirm dialogs, empty states, validation messages (zod schema messages via t()), chart labels and legends, tooltips, banners (backup reminder, recovery key, install hint, offline), the landing page (including <title> and meta description per language), the vault screens, the Data problem screen, and errors shown to the user (vault, backup, import, conversion, recurring).
   - Errors thrown from lib code carry a stable `code`, and the UI maps code → t(). Lib code must not import React or depend on the current language, except through format helpers that read getLang().
   - Not translated:
     - user data (category names, descriptions)
     - CSV headers and file names
     - the backup file format
     - console logs
     - code, ADRs and docs
     - the brand name "MinimaSpend"
     - the manifest

5. DEFAULT CATEGORIES FOR NEW VAULTS
   - provisionDefaultCategories and the income defaults use the current language when a vault is created:
     - uk expense: Їжа 🍔, Транспорт 🚌, Оренда 🏠, Кава ☕, Розваги 🎬, Сервери 🖥️
     - uk income: Зарплата 💼, Фриланс 💻, Подарунки 🎁, Інвестиції 📈, Повернення ↩️, Інше 🪙
   - Existing vaults' categories are user data and are never renamed.

6. TERMINOLOGY (use consistently; record the glossary in docs/i18n/glossary.md)
   - Expense → Витрата; Expenses → Витрати
   - Income → Дохід / Доходи
   - Transaction(s) → Операція / Операції (nav: "Операції"); Add transaction → Додати операцію
   - Quick Add → Швидке додавання
   - Category → Категорія; Budget → Бюджет; Left to spend → Залишилось витратити
   - Recurring → Регулярні платежі; Subscription → Підписка; Upcoming → Найближчі; Due → До сплати
   - Analytics → Аналітика; Dashboard / Home → Головна; Settings → Налаштування
   - Main currency → Основна валюта; Exchange rate → Курс; "rate pending" → "очікує курсу"; NBU → НБУ
   - Encryption password → Пароль шифрування; Recovery key → Ключ відновлення
   - Lock → Заблокувати; Unlock → Розблокувати
   - Backup → Резервна копія; Restore → Відновити; Remove data from this device → Видалити дані з цього пристрою
   - Use the formal-neutral imperative ("Додайте", "Введіть") consistently, and Ukrainian quotation marks «…» in prose.

7. REVIEW SUPPORT
   - Generate docs/i18n/uk-review.md, a table key | English | Ukrainian for every message, produced by a script (npm run i18n:review), so a native speaker can review it in one place.
   - The PR description links it and lists any phrases you were unsure about.

8. GUARD AGAINST NEW UNTRANSLATED TEXT
   - Add a test using the TypeScript compiler API (typescript is already a dev dependency) that scans src/**/*.tsx (excluding tests and src/components/ui) and fails on:
     - JSX text containing letters
     - string literals in aria-label / placeholder / title / alt attributes
     - string literals passed to toast.*
   - Allowlist only: "MinimaSpend", currency codes, emoji and punctuation-only strings.

CONSTRAINTS
- No new runtime dependencies. A dayjs locale import ('dayjs/locale/uk') is fine.
- Do not change stored data, the meta:vault header, the backup format or CSV columns.
- SSR, the offline shell and hydration must not mismatch, and there must be no flash of the wrong language: test the SSR render with cookie=uk and with Accept-Language uk.
- Follow .claude/rules/testing.md: set the language explicitly in tests, and use format helpers in assertions. Existing tests may be updated to pin 'en'. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass.
- Docs:
  - CLAUDE.md: how to add a string, the formatting rules, the guard test
  - an ADR "Custom typed i18n catalog, language via cookie + localStorage"
  - a short section "16. Languages" in docs/free-tier-spec.md

ACCEPTANCE (each must be a test)
- en.ts and uk.ts have identical key sets (type check plus a runtime test). t() interpolates. An unknown key fails the type check.
- plural('records', n) in Ukrainian: 1 → "1 запис", 2 → "2 записи", 5 → "5 записів", 21 → "21 запис", 1.5 → "1,5 запису".
- Language resolution:
  - stored 'en' beats an Ukrainian browser
  - navigator ['uk-UA', 'en'] → 'uk'
  - ['ru-RU'] → 'en'
  - the cookie and localStorage are both written on switch
  - "Remove data" clears both
- SSR: a request with cookie minima_lang=uk renders <html lang="uk"> and Ukrainian landing text. Accept-Language: uk-UA without a cookie does the same, and no cookie with en renders English.
- Switching in Settings → General, on the landing toggle and on the unlock screen updates visible text immediately and sets <html lang>.
- Formatting:
  - formatMoney(1234.5, 'UAH') is "1 234,50 грн" in uk and "1,234.50 UAH" in en
  - formatMoney(20, 'USD') is "20,00 USD" in uk
  - formatDay is "14 жовт." in uk and "Oct 14" in en
  - chart tooltips use the same helpers
- describeFrequency (uk):
  - monthly from the 31st → "Щомісяця, 31-го"
  - every 2 weeks → "Кожні 2 тижні"
  - yearly from 2026-03-01 → "Щороку, 1 березня"
  - every 5 days → "Кожні 5 днів"
- New vault in uk gets the Ukrainian default expense and income categories. An existing vault's categories are unchanged after switching language.
- Error codes:
  - wrong password shows "Неправильний пароль" in uk
  - an offline main-currency change shows the Ukrainian message
  - a zod validation message appears in Ukrainian
- Key screens render in Ukrainian with no leftover English words from a list of the most common UI words ("Save", "Cancel", "Add", "Delete", "Settings", "Income", "Expenses"): landing, create vault, unlock, dashboard, Transactions with the drawer open, Income, Recurring, Analytics, Settings tabs.
- The guard test fails on a sample component containing `<p>Hello</p>` and passes on the real codebase.
- docs/i18n/uk-review.md is generated and lists every key.

MANUAL CHECK (document in the PR)
- On a phone-sized viewport, check Ukrainian text in narrow places: buttons, tabs, chart axes, the drawer and table headers. Nothing may be cut off or overflow.
- Check the landing page in both languages, light and dark.

OUT OF SCOPE
Other languages, translating user data, a localised manifest or separate URLs per language (/uk/…), right-to-left support.
```
