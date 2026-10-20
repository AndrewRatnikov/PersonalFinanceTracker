# Orchestrator prompt: Faster entry + "Add transaction" drawer

Starts from `main` at c9c954b.

```text
Make adding and editing expenses fast. The Transactions page gets an "Add transaction" button that opens a drawer. Editing a row opens the same drawer, replacing today's inline row editor. Entry also gets quicker everywhere: description suggestions, one-tap "repeat last", a default currency per category, and a home-screen "Add expense" shortcut. Where this prompt is silent, follow existing patterns and record a CONTRACT_GAP.

CONTEXT
- Expenses can only be added from the dashboard Quick Add (src/components/index/SpeedEntryForm.tsx: amount + Radix currency select, category, description, Repeat <select>).
- Editing is inline in the table: src/components/transactions/TransactionsTable.tsx renders ExpenseRowEditor for `editingId`, and transactions.tsx calls updateExpense(id, originalCreatedAt, patch).
- Available UI: src/components/ui/sheet.tsx (Radix Dialog based, side 'top' | 'right' | 'bottom' | 'left'), plus button, input, label, alert-dialog. No new UI libraries.
- localDb:
  - addExpense / updateExpense / deleteExpense
  - recurring creation from Quick Add's Repeat: the transaction is saved today and an auto item starts today with handledThrough = today
  - conversion runs in the background after every entry write; edits to amount, currency or date clear the conversion
- Category is { id, name, icon?, updatedAt? } (src/lib/domain.ts). The main currency comes from appSettings (useCurrencySettings).
- public/manifest.json has no `shortcuts`.
- Testing rule (.claude/rules/testing.md): Radix Select can't be driven in jsdom. Use native controls or buttons for anything a test must change.

1. EXPENSE DRAWER (new src/components/transactions/ExpenseDrawer.tsx)
   - One component for add and edit: props { mode: 'add' | 'edit'; expense?: Expense; open; onOpenChange; initial?: Partial<draft> }.
   - Layout: Sheet side="bottom" below the `sm` breakpoint (max height 90dvh, scrollable body, Save button kept visible above the on-screen keyboard), side="right" from `sm` up. Title: "Add transaction" / "Edit transaction".
   - Fields, in this order:
     a. Amount: large numeric input (inputMode="decimal"), autofocused on open, accepting "," or "." as the decimal separator.
     b. Currency chooser: a segmented button group with one button per entry in CURRENCIES (data-testid="drawer-currency-<CODE>", aria-pressed). No Radix Select.
     c. Category: a wrapping grid of chips (icon + name) acting as a radio group, keyboard accessible (arrow keys and Enter). data-testid="drawer-category-<id>".
     d. Date: native <input type="date">, default today in add mode. Past dates are allowed; future dates are allowed with a small "future date" hint.
     e. Description: text input with suggestions (step 3).
     f. Repeat (add mode only): native <select> with Don't repeat / Weekly / Monthly / Yearly, the same semantics as Quick Add.
   - Defaults in add mode:
     - currency = the chosen category's defaultCurrency (step 4), else the main currency
     - category = the first category, or the one passed in `initial`
   - When the user picks a category, the currency switches to that category's default, unless the user has already tapped a currency in this drawer session.
   - Buttons:
     - add mode: "Save" (closes) and "Save & add another" (keeps the drawer open, clears amount and description, keeps category, currency and date, refocuses amount)
     - edit mode: "Save" and "Delete" (AlertDialog confirm, then deleteExpense, then close)
     - "Cancel" or Esc closes without saving
     - Enter in the amount or description field saves
   - Validation: createExpenseSchema / updateExpenseSchema, with inline field errors. Saving never waits for the network.
   - Edit mode on a record with recurringId shows a note: "From a recurring item. Changes apply only to this entry."
   - Edit mode on a non-main-currency record shows the stored conversion as read-only info, e.g. "≈ 830.40 UAH · NBU · 14 Oct". Changing amount, currency or date shows "will be recalculated".
   - On success: invalidate ['expenses'] and ['analytics'] (and ['recurring'] when Repeat was set), and show a toast ("Expense saved" / "Transaction updated").

2. TRANSACTIONS PAGE (src/routes/transactions.tsx)
   - Header: a primary button with a plus icon and the text "Add transaction" (data-testid="transactions-add-btn"), next to the category filter. On mobile it also appears as a floating round "+" button (aria-label "Add transaction") at the bottom right, above any safe-area inset.
   - The row edit button opens the drawer in edit mode. Remove ExpenseRowEditor and its inline-edit state, and move or adapt its tests to the drawer. The row delete button stays as it is.
   - The drawer state lives in the URL search params, so the phone's back button closes it and links can open it:
     - `?add=expense` opens add mode; extra optional params `category=<id>`, `amount=<n>`, `currency=<CODE>`, `description=<text>` prefill it
     - `?edit=<expenseId>` opens edit mode for that expense (found in the already-loaded list; if it doesn't exist, show a toast "Transaction not found" and drop the param)
     - closing removes the params with history `replace`
     - validateSearch must type and sanitise these params
   - If the vault is locked when such a URL is opened, the drawer opens right after unlock.

3. DESCRIPTION SUGGESTIONS (drawer, dashboard Quick Add, and the description field of AddIncomeForm for income)
   - A pure function, src/lib/suggestions.ts: suggestDescriptions(entries, { query, categoryId?, limit = 5 }) → Array<{ description, categoryId, amount, currency, lastUsed, count }>.
     - Group by description, trimmed and compared ignoring case; keep the most recent spelling.
     - Rank by score = count weighted by recency (entries in the last 90 days count double), then by lastUsed descending.
     - Filter by a prefix match first, then a substring match on the query (ignoring case and diacritics).
     - When categoryId is given, that category's descriptions rank first.
   - UI: an accessible combobox listbox under the input (role="combobox" / "listbox" / "option", arrow keys, Enter, Esc). Do not use <datalist>, because Safari's is unreliable.
     - It shows up to 5 suggestions when the input is focused (even when empty: the most frequent in the chosen category) or typed in.
     - Each row shows the description plus a muted hint "last: 65 UAH".
     - Picking a suggestion fills the description and, if the form still has its defaults, also the category and currency from that description's most recent entry. It never fills the amount automatically. The hint is enough, and tapping the hint chip fills the amount.
   - Everything is computed in memory from the already-decrypted queries. Nothing new is stored.

4. DEFAULT CURRENCY PER CATEGORY
   - Category and income categories gain an optional `defaultCurrency?: Currency`. It is additive, and records without it behave as today.
   - Settings → Categories: each row (expense and income sections) gets a small native <select> "Currency", with "Main currency" (no value) plus CURRENCIES.
     - It saves through updateCategory / updateIncomeCategory, which must keep the field (and keep the existing name rules).
     - data-testid="category-default-currency-<id>".
   - Applied in the drawer (step 1), in Quick Add (switch currency when the category changes, unless the user changed currency manually), in AddIncomeForm (income category default) and in the RecurringForm category change.
   - Backup: categories already round-trip as raw records. Make sure validatePayload accepts the optional field. CSV categories.csv stays name,icon (the default currency isn't exported).

5. REPEAT LAST (dashboard)
   - Above Quick Add, a row of up to 3 chips (data-testid="repeat-last-chip"):
     - the most recent DISTINCT expenses by (description, category, amount, currency) from the last 60 days
     - entries generated by recurring items are skipped
     - each label reads e.g. "☕ Coffee · 65 UAH"
   - Tapping a chip adds that expense immediately with today's date. A toast "Added Coffee · 65 UAH" offers "Undo" for 5 s, which deletes exactly that record.
   - Long-press, or a small "…" on the chip, opens the drawer prefilled instead (via `/transactions?add=expense&…`, or the drawer directly on the dashboard).
   - Hidden when there are no candidates.

6. QUICK ADD (dashboard SpeedEntryForm)
   - Keep it inline. Add the description suggestions (step 3) and the per-category default currency (step 4).
   - Replace its Radix currency Select with the same segmented currency buttons as the drawer, as one shared component, src/components/CurrencyPicker.tsx, also used by the drawer.

7. HOME-SCREEN SHORTCUT
   - public/manifest.json: add
     "shortcuts": [{ "name": "Add expense", "short_name": "Add", "url": "/transactions?add=expense", "icons": [{ "src": "logo192.png", "sizes": "192x192" }] }]
   - Opening that URL (installed app long-press on Android, or Chrome/Edge on desktop) lands on Transactions with the drawer open, after unlock if locked.
   - The precache and offline check must still pass (the URL works offline through the existing shell fallback).

CONSTRAINTS
- No new runtime dependencies. Use the existing Sheet, Button, Input and AlertDialog components.
- Do not change the meta:vault header, the encryption or the backup `version`. Data changes are additive only (Category.defaultCurrency).
- Keep every existing behaviour: recurring creation from Repeat, background conversion, the per-tab locks and multi-tab sync.
- Accessibility:
  - the drawer traps focus and is labelled by its title
  - every control has a label
  - touch targets are at least 44 px on mobile
  - it works in light and dark themes (use theme tokens, never hard-coded black or white)
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings, including test files) and npm test must all pass.
- Also fix while here: move `shadcn` from dependencies to devDependencies (it's a CLI and the source of all 7 high npm-audit advisories), and fix the 6 existing require-await lint warnings in tests.
- Docs: update CLAUDE.md (drawer, URL params, suggestions, default currency) and add a short ADR "Expense add/edit in one drawer driven by URL params".

ACCEPTANCE (each must be a test)
- Transactions:
  - "Add transaction" opens the drawer in add mode with the amount focused.
  - Saving 65 UAH Coffee creates one expense dated today and closes the drawer.
  - "Save & add another" keeps it open with category, currency and date kept, and amount and description cleared.
- Edit:
  - The row edit button opens the same drawer in edit mode, prefilled.
  - Changing the amount calls updateExpense with the original createdAt.
  - Changing the date to another month moves the record (existing updateExpense behaviour).
  - Delete in the drawer asks first, then deletes.
  - ExpenseRowEditor no longer exists.
- Currency chooser: tapping USD saves currency 'USD'.
  - With category "Server Costs" whose defaultCurrency = 'USD', picking that category switches the chooser to USD.
  - After the user taps EUR first, picking that category keeps EUR.
- URL:
  - `/transactions?add=expense&category=<id>&amount=12.5&currency=EUR` opens the drawer prefilled.
  - `?edit=<id>` opens edit mode.
  - An unknown edit id shows "Transaction not found" and removes the param.
  - Closing removes the params.
  - When locked, the drawer opens after unlock.
- suggestDescriptions:
  - "Coffee" ×5 (recent) ranks above "Coffee beans" ×2.
  - "cof" matches both, prefix matches before substring matches.
  - Case and spacing variants merge.
  - A categoryId boosts that category.
  - Limit 5 holds.
  - Picking a suggestion fills the description, category and currency but not the amount.
  - Keyboard navigation works.
- Repeat last:
  - Up to 3 distinct chips, recurring-generated entries excluded.
  - Tapping adds one expense today.
  - Undo within 5 s deletes exactly that expense.
- Default currency: the category row select saves defaultCurrency, and renaming the category keeps it. A backup round-trip keeps it. A category without it falls back to the main currency.
- Quick Add uses CurrencyPicker, and its suggestions and default currency behave as in the drawer.
- manifest.json contains the "Add expense" shortcut to /transactions?add=expense, and the precache check still passes.
- `npm audit --omit=dev` reports no high-severity issues, and lint reports 0 warnings.

MANUAL CHECK (document in the PR)
On a phone-sized viewport:
- The drawer opens from the bottom, the keyboard doesn't cover Save, and the back button closes the drawer.
- On desktop it opens from the right.
- Light and dark themes both look right.
- Installed as a PWA on Android, long-pressing the icon shows "Add expense" and opens the drawer.

OUT OF SCOPE
Editing income entries (next run: reuse this drawer with a kind switch), search on Transactions, voice or AI entry, receipt photos.
```
