# A category's default currency is an optional field on the category record

- **Status:** Accepted
- **Date:** 2026-10-20
- **Source:** orchestrator run `run_20261020_064158` (fast add/edit expense drawer; the task asked for the field, the keep/clear semantics are the Architect's)
- **Code:** `src/lib/domain.ts`, `src/lib/localDb.ts`, `src/lib/categoryCurrency.ts`, `src/components/settings/CategoryRow.tsx`

## Context

Entry forms should preselect a currency by category (for example, a category that is always paid in EUR). The value has to live somewhere that is encrypted like the rest of the user's data, survives backup and restore, and is not wiped by an edit that does not mention it (a rename).

## Decision

`Category` (expense and income categories share the type) gains `defaultCurrency?: Currency`. Absent means "use the main currency".

- `UpdateCategoryInput.defaultCurrency` is `Currency | null | undefined`. In `updateCategory`, `undefined` keeps the stored value, `null` deletes the key (it is never stored as `null`), a currency sets it. `CreateCategoryInput` is unchanged.
- Readers go through `currencyForCategory` / `categoryDefaultCurrency` in `src/lib/categoryCurrency.ts`, which ignore a value that is not a known currency, because a restored backup could hold anything.
- The default applies only to new entries. Edit mode, and a currency passed through `initial` or the URL, count as an explicit currency choice, so editing never changes money fields the user did not touch. Within a drawer session a manually tapped currency is not overridden by a later category change.
- The field is editable per category in Settings (`CategoryRow`).
- It is not written to `categories.csv`, which keeps its `name, icon` columns.

No backup format or version change: the field rides inside the category record.

## Alternatives considered

- **A `categoryId -> currency` map in `meta:settings`.** Stored in plaintext outside the encrypted category records and drifts when a category is deleted. Rejected.
- **Exporting it in `categories.csv`.** The task excluded it, and it would change the CSV columns. Rejected.
- **Applying the default in edit mode.** Re-categorising a stored expense would silently change its currency. Rejected.

## Consequences

- Additive and backward compatible: old categories and old backups work without migration. An older app version restoring a newer backup would ignore the field.
- CSV export and re-import lose the setting, so it is restored only through `.minima` backups.
- Because of `null` versus `undefined`, any new caller of `updateCategory` must pass `null` to clear the default; omitting it keeps it.
