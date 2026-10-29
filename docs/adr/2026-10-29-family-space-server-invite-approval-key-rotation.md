# Family space server: invite token without key, owner approval with key wrap, key rotation on removal, owner-plan permissions

- **Status:** Accepted
- **Date:** 2026-10-29
- **Source:** orchestrator run `run_20261029_165724` (Family space server, Supabase side; the user's task fixed the title and the main design in its spec)
- **Code:** `supabase/migrations/20261029000000_family_spaces.sql`, `src/lib/cloud/spacesApi.ts`, `src/lib/cloud/rpc.ts`, `src/lib/spaces/invite.ts`, `docs/db.md`

## Context

[2026-10-28-spaces-personal-plus-family-space-key-identity](2026-10-28-spaces-personal-plus-family-space-key-identity.md) gave the client a per-space key (SK) and member identity keys, and listed rotation and the invite layer as later work. This run adds the server for one shared Family space. The server must never see the SK, yet it must let a second person join, and it must cut off a removed member. Family data also has to be payable by one person (the owner) for everyone in the space, which the per-user check of [2026-10-23-encrypted-sync-server-opaque-keys-plan-permissions](2026-10-23-encrypted-sync-server-opaque-keys-plan-permissions.md) cannot express. The spec left a few details open (token hash byte form, error form for a stale key, what happens to shared records when a member's account is deleted).

## Decision

**Invite and approval.** The invite link is `/join#<inviteId>.<secret>` and carries no key. The client derives `inviteToken(secret)` (HKDF, base64url string, `src/lib/spaces/invite.ts`) and sends it; the server stores only `sha256(convert_to(token,'UTF8'))` as hex, so the hash is of the UTF-8 bytes of the base64url string, not of the raw 32 bytes. `request_join` registers the joiner's identity public key as a pending member. The owner's device wraps the SK for that key (ECIES, from run A) only in `approve_member`, which stores the wrapped key. A pending or rejected user never receives any key material.

**Removal and rotation.** `remove_member` revokes server access at once. The owner's device then calls `rotate_space_key`, uploading a new SK version wrapped for every remaining active member in one call. `push_space_records` with a stale version raises `MINIMA:key_outdated:<current key_version>`: the current version is in the message (not in `DETAIL`), the existing `MINIMA:([a-z_]+)` mapping still yields the code, and `currentKeyVersionOf(err)` reads the number. `docs/db.md` §9 documents this as the one exception to the "whole message is the code" rule.

**Owner-plan permissions.** `effective_plan_for(user)` and `has_feature_for(user, feature)` decide access from the space owner's plan; `has_feature` now delegates to `has_feature_for`. Limits `max_members` (6), `max_space_records` and `max_space_bytes` are plan features of the owner. When the owner loses `shared_spaces`, growth actions (`create_invite`, `get_invite`, `request_join`, `approve_member`) and data movement (`push_space_records`, `pull_space_records`) raise `space_paused`. Security and exit actions (`get_my_space`, `revoke_invite`, `reject_member`, `remove_member`, `rotate_space_key`, `leave_space`, `transfer_ownership`, `delete_space`) keep working.

**Records and account deletion.** Family records and events keep `author_id`, `actor_id` and `subject_id` as plain uuids without a foreign key to `auth.users`. A `before delete on auth.users` trigger (`space_member_left_on_user_delete`) writes a `left` event for a non-owner member. The shared data and its history belong to the space and are removed with it.

**Module layout.** `CloudError` and the rpc types moved to `src/lib/cloud/rpc.ts` (re-exported by `api.ts`) so `spacesApi.ts` does not import `api.ts`, which a run 3 guard test forbids.

## Alternatives considered

- Wrap the SK with the invite secret (run A's `wrapSpaceKeyWithSecret`). Rejected: anyone holding the link, or a rejected joiner, would get the key, and the owner would have no approval step. The helper stays as an unused, reserved function.
- Re-wrap the key on the server on removal. Impossible: the server never sees the SK.
- Hash the raw HKDF bytes. Rejected: it needs base64url decoding in SQL and gains nothing; both forms are one-to-one.
- `key_outdated` version in Postgres `DETAIL`. Rejected: the spec asks for the message, and the client test rpc path drops `details`.
- Check each member's own plan. Rejected: a family plan paid only by the owner would be impossible.
- Pause every space function when the owner's plan lapses. Rejected: the owner could then not remove a member or rotate the key while paused (run 3 rule: deleting and managing are never locked behind a plan).
- `ON DELETE CASCADE` on author ids. Rejected: deleting one account would delete every Family record that person wrote and the `left` event itself. `ON DELETE SET NULL` was rejected because the event would no longer say who left.

## Consequences

- A leaked link alone gives nothing; the server holds no key it could decrypt with. The approval and the rotation depend on the owner's device being online, so a removed member keeps access to data already pulled and to old versions until rotation completes.
- The server knows which user wrote each Family record (documented in the privacy text, `/privacy` "Family space").
- Known gap: `push/pull_space_records` need a registered run 2 device, and `register_device` requires the caller's own `sync` feature. A member without personal sync under a paid family plan cannot register a device; run C must solve this (documented in `docs/db.md` §9). The client must also gate Family data movement on `get_my_space().paused`.
- Records accept `enc_v = 1` only; another format needs a new migration.
- Re-running the run 2 migration resets plan features, `effective_plan()`, `has_feature()` and `get_sync_status()` to run 2's until the family migration runs again.
- Revisit if the token hash form or the `key_outdated` message format needs to change: both are wire formats shared with the client.
