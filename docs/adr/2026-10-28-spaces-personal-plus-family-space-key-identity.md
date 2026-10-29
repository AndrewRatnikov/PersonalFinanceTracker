# Spaces: personal plus one Family space, per-space key, member identity keys

- **Status:** Accepted
- **Date:** 2026-10-28
- **Source:** orchestrator run `run_20261028_212133` (Spaces groundwork, run A of the Family plan: local data layer only, no network code, no visible UI; the task asked for this ADR and its title)
- **Code:** `src/lib/spaces/types.ts`, `src/lib/spaces/spaceCrypto.ts`, `src/lib/spaces/keyring.ts`, `src/lib/spaces/spaceDb.ts`, `src/lib/localDb.ts`, `src/lib/backup.ts`, `src/lib/featureFlags.ts`
- **Supersedes:** [2026-10-08-backup-restore-rules](2026-10-08-backup-restore-rules.md) (in part: the replace rule no longer applies to the `identity` and `spaceKeys` records)

## Context

A shared Family space is planned. Its data must be readable by several people, so it cannot be encrypted with the personal DEK. The local data layer had to learn about spaces before any server or invite code exists, without changing a byte of existing personal data and without breaking the many tests that factory-mock `@/lib/localDb` and assert exact call arguments (vitest fails `toHaveBeenCalledWith` on a trailing `undefined` argument). Backup restore also had to be defined for key material: the older restore rule says keys the backup does not cover become `[]` and local-only records become tombstones, which would destroy access to Family data if applied to space keys.

## Decision

**Model (D1).** Personal keeps every storage key and the DEK. A Family space uses the same IndexedDB store with keys `space:<id>:<baseKey>` (`keyFor`, `parseSpaceStorageKey` in `types.ts`), encrypted with its own random 256-bit space key (SK). The SK and a per-user member identity (ECDH P-256 key pair) are stored as encrypted personal records, `spaceKeys` and `identity`, so they reach the user's other devices through the existing personal sync. SK wrapping for a public key is ECIES-style (ephemeral ECDH P-256, HKDF-SHA256, info `minima-space-key-wrap-v1`); wrapping for an invite secret uses HKDF info `minima-space-key-invite-v1` with an empty salt. `ENABLE_SPACES` (`VITE_ENABLE_SPACES`) gates the feature. Family writes stamp `createdBy` / `updatedBy` / `paidBy`; a null member id leaves them absent; personal never gets them.

**Handle (D2).** Data functions are reached through `spaceDb(spaceId)`, whose members keep today's signatures. The top-level `localDb` exports are the personal handle, and `dbFor('personal')` returns the module namespace, so mocked functions are still the ones called. Modules above `localDb` take an optional `{ spaceId }` and resolve `dbFor(spaceId)`; for personal, `spaceArgs` and `withSpaceOption` add nothing, so personal calls keep exactly today's arguments. `listChangedRecords` / `applyIncomingRecords` also accept a leading `spaceId` overload because the sync engine will address streams by id. A missing space key throws `SpaceLockedError`; there is no fallback to the DEK.

**Key versions (D3).** `spaceKeys` holds one record per space (`id = spaceId`) with the newest `keyVersion` / `key` and older versions in `previousKeys`. Reads try the newest key first, then older ones. Rotation is not part of this run.

**Restore (D4).** In `restoreBackup`: an existing local `identity` is never replaced; `spaceKeys` is merged in both replace and merge modes, never emptied or tombstoned; a backed-up space is restored only when its key is available, otherwise its id is listed in the optional `RestoreSummary.skippedSpaces` (also used for an invalid id or an unimportable merged key); local spaces absent from the backup are left alone. An unreadable local `spaceKeys` throws `DecryptError('spaceKeys')` in both modes and is never quarantined. The summary field is present only when non-empty, so existing summaries and payloads are unchanged.

## Alternatives considered

- A separate IndexedDB database per space: wipe, quarantine, backup and the orphan check all assume one store.
- Encrypting Family data with a key derived from the DEK: other members cannot hold it.
- Storing the SK wrapped only for the identity key: a second device of the same user would need the identity first, and the task asks for personal sync of `spaceKeys`.
- A `{ spaceId }` argument on every `localDb` function: several functions have optional middle parameters (`processDueRecurring(today?)`, `addRecurring(input, opts)`), and 38 test files that mock `@/lib/localDb` plus UI tests with exact-argument assertions would break.
- One array element per (space, version) with the same `id`: collides in `mergeRecord` and in the sync `record_key` (HMAC of `type:id`). A per-version id contradicts `id: spaceId`; a version tag inside each blob would change the record format.
- Applying the old replace rule to `identity` / `spaceKeys`: restoring an old backup would destroy access to Family data and to the identity registered with other members.

## Consequences

- Personal data is byte-identical and needs no migration; existing callers, mocks and tests are untouched.
- Every later space-aware function must follow the handle pattern and use `keyFor` / `cryptoFor` rather than building storage keys by hand.
- A failed AES-GCM attempt happens only for records not yet re-encrypted after a key change.
- Restore never removes key material, so a restore can leave extra spaces or keys behind. That is accepted: losing a key is irreversible, keeping one is harmless.
- Known gaps for later runs: an incoming `spaceKey` tombstone makes a device drop the space while its blobs stay unreadable until purged; if two devices create identities before first sync, newest wins and one is lost; key rotation; the network, invite and member-management layers.
