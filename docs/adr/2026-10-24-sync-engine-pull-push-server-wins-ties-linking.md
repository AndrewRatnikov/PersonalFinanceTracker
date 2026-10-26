# Sync engine: pull then push, server-ordered cursors, server wins exact ties, linking flows

- **Status:** Accepted
- **Date:** 2026-10-24
- **Source:** orchestrator run `run_20261024_210606` (encrypted sync end to end; the ADR title was requested in the task)
- **Code:** `src/lib/sync/engine.ts`, `src/lib/sync/actions.ts`, `src/lib/sync/syncMeta.ts`, `src/lib/vault.ts`, `src/lib/localDb.ts`, `src/components/vault/SyncRestoreScreen.tsx`, `src/components/settings/SyncLinkDialog.tsx`

## Context

Run 1 ([2026-10-22-sync-ready-local-data](2026-10-22-sync-ready-local-data.md)) gave the local store tombstones, `rev` and a merge rule. Run 2 ([2026-10-23-encrypted-sync-server-opaque-keys-plan-permissions](2026-10-23-encrypted-sync-server-opaque-keys-plan-permissions.md)) added the server: opaque record keys, `pull_records` ordered by a per-user `seq`, and `push_records`, which answers `stale` with the current row when the server copy is not strictly older. This run connects them. Several points were not fixed by either: when the permission check happens, what the cursors mean after a crash, who wins an exact timestamp tie, and how a second device joins a vault that already exists in the cloud without risking local data.

## Decision

**Cycle.** Every cycle (in `engine.ts`) starts with a fresh `get_sync_status` and `hasFeature(status, 'sync')`. The same call supplies the vault reference and `header_rev`. Then:
1. Pull page by page from `pullCursor`. Each page goes through `applyIncomingRecords`, and only then is `pullCursor` saved as the last applied row's `seq`. Re-applying a page after a crash is harmless because merge is idempotent.
2. Push `listChangedRecords(pushedRev)` in batches of at most 500 records and 1 MiB of ciphertext (`MAX_RECORDS_PER_PUSH`, `MAX_PUSH_CIPHERTEXT_CHARS`). `pushedRev` is set to `snapshot.maxRev` only after every batch succeeded.
3. Each `stale` reply is decrypted and applied with the new `preferIncomingOnTie` option of `applyIncomingRecords`, so on an exact timestamp tie the server copy wins on every device. The local `sameTimeWinner` is not used for these.
4. A row that cannot be decrypted or is invalid is skipped, counted and reported in `lastError`. If `applyIncomingRecords` rejects a whole batch, the engine falls back to applying records one by one. This is the skip-and-report option ADR 2026-10-22 asked to revisit, used at engine level only. Locking the vault during an apply halts the cycle without advancing the cursor.

**First push.** Turning sync on sets `pushedRev: -1` (`actions.ts`), not 0, so `listChangedRecords` also returns records with no `rev` (written before run 1, the migrated settings record). Otherwise they would never reach the server.

**Failure mapping.** The server losing this device's vault or device row (`status.vault` null or another `vault_id`, `no_vault`, `device_not_registered`, `vault_mismatch`) is one state, `cloud-deleted`, with "Upload again" running the turn-on flow. `vault-mismatch` is kept for a cloud header that wraps another DEK. A device removed from another device gets a new device id (`resetDeviceId()`) and registers again when turn-on or restore meets `device_removed`.

**Linking a second device.**
- *Fresh restore:* `vault.adoptCloudVault(header, secret)` (local vault state must be `none`) checks the secret with this device's brute-force counter and writes nothing until it passes. Then the device registers, does the full pull, and only afterwards runs the normal `onUnlocked({ isNewVault: false })`. With the recovery key, the DEK is re-wrapped under a new password inside `SyncRestoreScreen` and the new header is pushed as a pending header change.
- *"Join and keep this device's entries":* `vault.joinCloudVault` verifies the cloud password, then `localDb.rekeyLiveData` re-encrypts the live records under the cloud DEK and writes the cloud header, the records (same ids, `updatedAt` kept, fresh revs, tombstones dropped) and `meta:sync` (`pushedRev` = the rev before the re-stamp, `pullCursor` 0) in a single `setMany`. The next cycle pulls everything and pushes what is still newer locally. Other tabs are sent `lock`.
- *"Replace cloud data":* type `DELETE` (`REPLACE_CONFIRMATION`), then `delete_cloud_data`, `create_vault` and a full snapshot push (`pushedRev: -1`).

**Header changes.** `vault.subscribeHeaderChanges` fires on password change, new recovery key and recovery reset. The engine sets the additive `meta:sync.headerPending` flag, and the next cycle pushes the header with the expected `headerRev`, before it would adopt a newer cloud header. On `header_conflict` it fetches the cloud header, which must wrap the same DEK, and retries once with the cloud rev. The last writer wins for the whole header. A device that sees a higher `header_rev` adopts the cloud header only if it wraps the same DEK.

## Alternatives considered

- **Reading the React Query `['sync-status']` cache for the gate.** It can be up to 5 minutes old, so a revoked plan would keep pushing.
- **Push before pull.** More `stale` round trips.
- **Advancing `pushedRev` per batch.** An interrupted push could skip records whose rev lies between batches.
- **Local `sameTimeWinner` for server ties.** Devices would diverge.
- **Task order for "Join and keep": wipe, pull, re-insert.** Between wipe and re-insert the entries exist only in memory, so a crash or closed tab loses them. The single-transaction re-key reaches the same end state without that window, and a failure before the commit leaves the old vault unlockable.
- **Writing the cloud header first and reusing `RecoverScreen`.** It needs a local header, so a wrong key would leave a foreign header and no data.
- **Running `prepareUnlockedVault` before the pull.** It would create duplicate default income categories.
- **Pushing headers only from the Security tab, fetching `get_vault` every cycle, or merging headers field by field.** The first loses changes made offline, signed out or from the recovery screen; the second adds a call every 60 s; the third cannot know which part the other device changed.
- **A state per server error code.** The user's choices are the same.
- **Un-removing a device on the server.** A server change, and a removal must stick for the old id.

## Consequences

- A cycle costs one extra `get_sync_status` call, in exchange for the server's own decision gating every cycle.
- Both cursors are crash-safe and idempotent. Clock skew still decides newest-wins (run 1 rule); only exact ties go to the server.
- Whole-header last writer wins: if device A changes the password while B regenerates the recovery key, B's new recovery key may stop opening the cloud header. Rare, documented in spec §19.
- "Join and keep" can leave duplicate default categories (same names, different ids), as a backup merge does (ADR 2026-10-08). Quarantined blobs stay encrypted under the old DEK.
- Deleting an account leaves `meta:sync` enabled with the old user id; signing in again shows `other-account` with "Turn off sync".
- Revisit if skip-and-report proves too lenient for corrupted rows, or if header merging becomes needed.
