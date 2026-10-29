# A backup restore is one transaction, with explicit replace and merge rules

- **Status:** Superseded by [2026-10-28-spaces-personal-plus-family-space-key-identity](2026-10-28-spaces-personal-plus-family-space-key-identity.md)
- **Date:** 2026-10-08, extended 2026-10-10
- **Source:** orchestrator runs `run_20261008_080410` (Phase 4, Backup, CONTRACT_GAPs 3–10) and `run_20261010_092310` (orphaned-device restore)
- **Code:** `src/lib/backup.ts` (`restoreBackup`, `openHeaderWithSecret` in `vault.ts`)
- **Spec:** `docs/free-tier-spec.md` §7.3. This ADR records the choices the spec left open.

## Context

Spec §7.3 defines replace and merge and asks for "one transaction", but leaves several cases open: ties, keys the backup doesn't cover, unreadable local data, and which secret to try first.

## Decision

- **Nothing is written until the payload has decrypted and validated.** Then everything (data keys, `meta:settings`, and `meta:vault` when a backup's vault is adopted) goes into a **single `setMany`**.
- **Replace:**
  - Local data keys the backup doesn't cover are overwritten with an encrypted `[]` rather than deleted, so the restore stays one `setMany`.
  - An undecryptable local blob is first copied, unchanged, to `quarantine:<key>:<ISO>` in the same transaction.
  - `autoLockMinutes` and `backupReminderDays` are restored.
- **Merge:**
  - Upsert by `id`. The backup wins only when its `updatedAt` is strictly newer.
  - On an equal timestamp, local wins (different content counts as a conflict).
  - A missing `updatedAt` falls back to `createdAt`.
  - Same-name categories with different ids are **not** de-duplicated.
  - A merge that changes nothing writes nothing.
  - A merge that hits an undecryptable local key fails with `DecryptError` and writes nothing.
- **Secrets:** a secret that parses as a recovery key is tried as one first, then as a password. Checking a backup's secret does **not** touch the device's brute-force counter, because it is checked against the file, not the device.
- **Settings:** `lastBackupAt` is never taken from the file. A restore that writes sets `lastDataChangeAt`. Merge leaves settings alone.
- **Orphaned device (2026-10-10):** treated like a fresh device. The backup's header is adopted, replace is forced, and every existing blob is copied unchanged to `quarantine:*` in the same `setMany`. Nothing is deleted, and a failed commit leaves the store byte-identical.

## Consequences

- A failed or interrupted restore never leaves a half-restored store.
- After merging a backup from another device, the user may see duplicate default categories (same name, different id).
- Locked and v1 devices are rejected as restore targets.
