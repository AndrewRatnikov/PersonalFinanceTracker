# Encrypted sync server: opaque record keys, server-ordered pulls, plan-based permissions with a beta switch

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** orchestrator run `run_20261023_212635` (encrypted sync server, plans and permissions layer; the task fixed the record format, the seq ordering and the plan model, and the run filled the gaps named below)
- **Code:** `supabase/migrations/20261023000000_sync_server.sql`, `src/lib/cloud/recordCrypto.ts`, `src/lib/cloud/api.ts`, `src/lib/cloud/entitlements.ts`, `src/lib/cloud/types.ts`, `src/lib/vault.ts`

## Context

Multi-device sync stores user data on a server that must not be able to read it. After [2026-10-22-sync-ready-local-data](2026-10-22-sync-ready-local-data.md) the local records carry tombstones and `updatedAt`, so the next step was the server and the wire format that a later run (the sync engine) will use. Three things needed fixing together because the client and the SQL depend on each other:

- what the server sees of a record, and how devices address the same record;
- how pulls are ordered so a cursor never skips a row;
- where permissions and limits live, given that sync is free during the beta and paid later.

The vault DEK is a non-extractable AES-GCM key (`docs/free-tier-spec.md` §4.1), and WebCrypto will not use it as HKDF input, so the sync keys needed a derivation path that does not export the DEK.

## Decision

**Record format (shared with the sync engine run).** A synced record is `{record_key, ciphertext, iv, enc_v, updated_at_ms}`. Two keys are derived from the DEK with HKDF-SHA256, empty salt, info `minima-sync-index-v1` (K_index, HMAC) and `minima-sync-data-v1` (K_data, AES-GCM). `record_key` is base64url(HMAC-SHA256(K_index, `${type}:${id}`)), 43 characters, so the server learns neither type nor id. The record JSON is encrypted with AES-GCM, a random 12-byte IV, and `record_key` as additional data, which stops the server swapping ciphertexts between keys. `enc_v` is 1; `decryptSyncRecord` rejects other versions and checks that the record inside matches its `record_key`. Only `updated_at_ms` is in the clear. An empty salt is fine for a uniformly random 256-bit input (RFC 5869) and avoids storing extra state in the vault header.

**Key access (`getSyncKeys`).** `vault.ts` exports `getSyncKeys()`. `importDek` also imports the same raw bytes as non-extractable HKDF material and stores it in a `WeakMap` keyed by the in-use DEK. This covers create, v1 migration, every unlock and the backup-adopting restore. After `lockVault` the DEK is gone, so `getSyncKeys` fails. Only K_index and K_data leave `vault.ts`; the DEK stays non-extractable and is never exported.

**Ordering.** Each vault row has `last_seq`. `push_records` locks the user's rows and assigns `seq` from it, one increment per accepted record, in the request order. `pull_records` pages by `seq` (`has_more`, `last_seq`). A write is accepted only if its `updated_at_ms` is strictly greater than the stored one; otherwise the result is `stale` and carries the current row. The server copy therefore wins exact ties, and the sync engine must accept a `stale` reply on an equal time even where the local `sameTimeWinner` would pick the local copy. Backup merge keeps `sameTimeWinner`; this refines the equal-time rule only for server sync.

**Permissions.** All of it is decided in SQL. `effective_plan()` returns a valid non-`free` entitlement's plan (`active` with no end or a future end, or `past_due` until the period ends); otherwise `beta` while `app_config.sync_free_for_all` is true; otherwise `free`. `free` is the floor plan: a `free` entitlement (the row `register_device` creates when someone joins during the beta) never overrides the beta switch. `has_feature(p_feature)` is the only permission check, and limits (`max_records`, `max_bytes`, ...) live only in `plans.features`. The client reads the result through `useSyncStatus`, `hasFeature(status, feature)` and `<FeatureGate>` in `src/lib/cloud/entitlements.ts`, and never looks at a plan id. `get_sync_status` returns `granted_by` (`entitlement` | `free_for_all` | `default`) so the UI can pick its wording without plan ids. Device management (list, rename, remove) works without sync; push and pull still refuse a removed device.

## Alternatives considered

- **Plaintext type/id columns:** the server would learn record kinds and ids. Rejected.
- **Random server-side ids:** devices could not address the same record without a lookup table.
- **A random HKDF salt kept in the vault header:** changes the header format and every device needs it.
- **Making the DEK extractable:** any script in the page could read the raw key.
- **Exposing the HKDF base key from `vault.ts`:** it can derive any key, broader than the two sync keys.
- **A separate sync key wrapped in the vault header:** header format change.
- **Deriving at unlock inside `unlockLocalDb`:** misses the restore path, which only holds a `CryptoKey`, and widens `localDb`'s API.
- **Client clocks or `server_updated_at` as the cursor:** not gap-free in commit order.
- **A global sequence:** leaks activity volume across users.
- **Tie-breaking on the server:** it cannot see the content.
- **Literal "an active entitlement always wins":** the beta-join `free`/active row would revoke sync at the first device registration. Creating that row as `canceled` was also rejected, since it misstates the row.
- **Client-side checks or limits in code:** moving to payments would need a client rewrite.

## Consequences

- Moving from beta to payments is a config change (turn `sync_free_for_all` off, optionally run a grandfathering statement from the recorded join dates) plus a webhook that upserts `entitlements`. No client change.
- The server can see write times, record counts, sizes and which device wrote. It cannot see types, ids or content.
- Changing the key derivation, the `record_key` formula or the AAD means a new `enc_v` and a migration of every stored record. Treat the format as an external contract.
- `getSyncKeys` keeps HKDF material for the in-use DEK in memory for as long as the vault is unlocked.
- The equal-time rule differs between backup merge (`sameTimeWinner`) and server sync (server wins); the sync engine must handle `stale` replies accordingly.
