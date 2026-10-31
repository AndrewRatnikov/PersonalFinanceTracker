# Family sharing flows: key bundle with fixed index key, approval with safety code, rotation and re-encryption, read-only after removal

- **Status:** Accepted
- **Date:** 2026-10-31
- **Source:** orchestrator run `run_20261030_212632` (Family sharing flows; the user's task fixed the bundle, the stream, the safety code and the read-only rule, and asked for this ADR)
- **Code:** `src/lib/spaces/spaceCrypto.ts`, `src/lib/spaces/types.ts`, `src/lib/sync/familyStream.ts`, `src/lib/sync/familyActions.ts`, `src/lib/sync/familyMeta.ts`, `src/lib/sync/engine.ts`, `src/lib/localDb.ts`, `src/components/settings/FamilyTab.tsx`, `src/components/JoinPage.tsx`
- **Supersedes:** `docs/free-tier-spec.md` §21 (Records: Family records use the §18 record format), in part

## Context

The Family server ([2026-10-29-family-space-server-invite-approval-key-rotation](2026-10-29-family-space-server-invite-approval-key-rotation.md)) and the local spaces layer ([2026-10-28-spaces-personal-plus-family-space-key-identity](2026-10-28-spaces-personal-plus-family-space-key-identity.md)) had no client between them. This run adds it: create, invite, join, approve, remove, rotate, leave, transfer, delete, plus the Family sync stream.

Rotation replaces the space key. If record keys were derived from that key, every re-encrypted row would get a new key and become a new row. The server reveals no membership events through `get_my_space`, so the owner's device cannot read "who left". It also returns null both for a removed member and for a deleted space. The task asked for no server changes.

## Decision

**Key bundle.** What the owner wraps for a member is `{ v: 1, keyVersion, sk, indexKey }` (`wrapSpaceKeyBundleForPublicKey`, `unwrapSpaceKeyBundle`). `indexKey` is 32 random bytes made once with the space and never rotated. Record keys come from HKDF(`indexKey`, `minima-space-index-v1`) (`SPACE_INDEX_INFO`), so they are identical in every key version. The data key is HKDF(`sk`, `minima-sync-data-v1`) per version, and the AES-GCM additional data is `record_key:keyVersion`. Personal sync and its format are unchanged. The `spaceKeys` entry gains additive fields (`indexKey`, `status`, `wrappedFor`), and `BACKUP_VERSION` stays 1.

**Approval with a safety code.** The invite carries no key. The joiner calls `request_join`, and the owner approves by wrapping the bundle for the joiner's public key. Both sides show `safetyCode(publicJwk)`: the first 6 bytes of SHA-256 of the canonical JWK (`crv`, `kty`, `x`, `y`), as `XXXX-XXXX-XXXX`, so the owner can compare it with the joiner by phone or in person before approving.

**Family stream.** An injected `FamilyStream` runs after the personal part of the sync cycle, under the same lock, triggers and backoff, with its own state and meta (`space:<id>:meta:sync`). The `SyncEngine` interface is unchanged, and without the dependency the engine behaves as before. `pushedRev` defaults to 0, and only `createFamily` sets -1, so joiners and second devices do not re-upload what they pulled.

**Rotation.** The owner's device rotates when (a) it removed a member itself (`rotationPendingFrom` in Family meta) or (b) the wrap set on its `spaceKeys` entry (`wrappedFor { keyVersion, userIds }`) names a user who is no longer an active member in `get_my_space`. Case (b) covers a member who left, was removed from another owner device, or deleted the account, and it syncs to the owner's other devices through the personal stream. The new `sk` keeps the same `indexKey`, and older versions stay in the keyring for reading. Until `rotate_space_key` succeeds the space is `rotation-pending`: pushes wait and the rotation retries each cycle.

**Re-encryption.** After a successful rotation, in the same cycle, the device pulls (the server now rejects old-version pushes with `key_outdated`, so one pull sees every old row) and then pushes the full local snapshot, live rows and tombstones, at the new version. Because record keys are stable, the rows are overwritten in place.

**Read-only after losing access.** The loss is a share `status` on the personal `spaceKeys` entry: `active`, `removed`, `left`, `space-gone`, or absent for a local-only space. It syncs to the user's other devices, the keyring marks the space `readOnly`, every Family write raises `SpaceReadOnlyError` (`src/lib/localDb.ts`), and the stream stops. The copy stays readable, backed up and exportable until the user removes it from the device. When `get_my_space` is null, a one-row pull probe tells the cases apart through the server codes `space_gone` and `not_space_member`. If the probe succeeds the state is `error` (`unknown`), and nothing is guessed.

## Alternatives considered

- **Index key derived from each `sk`.** Record keys would change on every rotation and re-encrypted rows would become new rows.
- **Personal enc_v 1 AAD without the version.** A server could replay a row under another `key_version`. Binding the version into the AAD prevents this.
- **A second sync engine for Family.** It would need its own lock, triggers and backoff, and the task asked for one cycle.
- **Folding Family state into `SyncState` / `SyncEngine`.** It breaks the run 3 test fakes that type every engine member, and it mixes two error domains.
- **A server function or column exposing events, or querying `space_events` through PostgREST.** A server change that is not needed, and the app's server access is RPC-only.
- **Rotating whenever the wrap set is unknown.** Every ownership transfer or crash would cause a full re-encryption.
- **Re-encrypting only locally known rows before the rotation.** Rows another member pushed just before the rotation would stay on the old version.
- **A per-device read-only flag in Family meta.** The user's second phone would keep writing.
- **Deleting the local copy after removal.** The task asks for a read-only copy.

## Consequences

- Record keys are stable across rotations, and re-encryption is idempotent. The cost is that `indexKey` is never rotated: a removed member keeps it, so they can compute the record keys of ids they already knew, and nothing else. Their data key is useless for new versions.
- The owner's rotation decision depends on the wrap set. An owner who restores from a backup without `wrappedFor` and does not rotate for an old leaver gets the set rebuilt from the current active members, so a leaver from before that point is not detected.
- A removed member keeps what was already on their devices. That is accepted and is shown in the remove confirmation.
- The safety code only helps if people compare it. The flow shows it and advises comparing, but the owner can approve without checking.
- Joiners need their own personal sync, because the Family push and pull need a registered device (the `register_device` gap from run B stays open; every beta account has `sync`). This is listed in `docs/free-tier-spec.md` §22.
- If a Family ever needs more than one owner device to rotate concurrently, or the server starts exposing membership events, revisit the wrap-set rule.
