# Orchestrator prompt: Family budget run B of 4 — server for the Family space

Starts from `main` once run A (local data for spaces) is merged.

| Run | What | Visible? |
|---|---|---|
| A | Local data for Personal + Family, space key, member key pair | No — done |
| **B (this one)** | Server: Family spaces, members, invite links, owner approval, wrapped space keys, key replacement, Family records, plan feature and limits | No |
| C | Sharing flows and the Family sync stream | Behind a flag |
| D | Family UX: switcher, "Paid by", analytics by member, family budgets, "Move to Family" | Behind a flag |

```text
Build the Supabase side of the shared Family space: membership, invitations with owner approval, delivery of the space key to approved members, key replacement after a member is removed, and storage of Family records as ciphertext with server-ordered pulls. Nothing in the app uses it yet: run C adds the flows and the sync stream. Sharing is free in the beta through the existing plan switch, and the permission model must already support a paid "family plan" where only the owner pays. Where this prompt is silent, choose the simplest secure option and record a CONTRACT_GAP. Read the run 2 and run 3 sync ADRs, docs/db.md and the run A ADR first.

PRODUCT RULES
- A user is in at most one Family space (as owner or member), plus their own Personal data.
- Up to 6 members including the owner (from plan features, never hard-coded).
- Every active member may add, edit and delete every Family record.
- Only the owner approves, rejects or removes members, creates or revokes invites, replaces the space key, transfers ownership and deletes the space. A member can leave at any time.
- The server never sees the space key (SK), the space name, or any Family amount, category or description.

1. KEY DELIVERY (decided; write it in the ADR)
   - The invite link carries NO key. It is /join#<inviteId>.<secret>, where the part after # never reaches the server.
     - The server stores token_hash = SHA-256 of HKDF-SHA256(secret, info "minima-invite-token-v1").
     - The client proves possession by sending that HKDF token. The server can't derive anything else from it.
   - The joiner requests to join with their identity public key (run A ensureIdentityKeyPair).
   - The owner's device approves by wrapping the current SK for that public key (run A wrapSpaceKeyForPublicKey) and uploading it. A pending or rejected user never receives the key.
   - Run A's wrapSpaceKeyWithSecret stays unused. Keep it and mark it "reserved" in a comment.
   - Removal: the server revokes the member at once. The owner's device then replaces the SK: it generates a new SK, wraps it for every remaining active member's public key and uploads all the wraps in one call, which raises key_version. Clients re-encrypt their records under the new version (run C).

2. DATABASE (one idempotent migration: supabase/migrations/20261029000000_family_spaces.sql; extend supabase/tests/sync_server_checks.sql or add family_spaces_checks.sql; update docs/db.md)
   Plans: upsert the new features into the existing seeds, without touching other keys:
   - free: shared_spaces false
   - beta: shared_spaces true, max_members 6, max_space_records 100000, max_space_bytes 104857600
   - sync: shared_spaces false
   - a new non-public plan 'family': the sync features plus shared_spaces true and the same limits
   Tables (RLS on; user ids reference auth.users ON DELETE CASCADE):
   - spaces(id uuid pk (client-generated, = run A spaceId), owner_id, key_version int not null default 1, last_seq bigint default 0, record_count int default 0, total_bytes bigint default 0, created_at, updated_at)
   - space_members(space_id → spaces on delete cascade, user_id, role check in ('owner','member'), status check in ('pending','active'), public_key jsonb not null (JWK, max 2 KB), requested_at, joined_at, invite_id null; pk (space_id, user_id))
     - a partial unique index on (user_id), so a user has at most one pending-or-active membership
     - removed, left and rejected members are deleted rows. Removal history goes in space_events (below).
   - space_invites(id uuid pk, space_id → spaces cascade, created_by, token_hash text not null, expires_at (default now() + 48 h, max 7 days), used_by null, used_at null, revoked_at null, created_at)
   - space_keys(space_id → spaces cascade, user_id, key_version int, wrapped_key jsonb not null (run A format { v, epk, iv, ct }, max 2 KB), created_at; pk (space_id, user_id, key_version))
   - space_records(space_id → spaces cascade, record_key text (same check as sync_records), key_version int not null, ciphertext text (max 65536 chars), iv text, enc_v smallint, updated_at_ms bigint, author_id uuid, device_id uuid, seq bigint not null, size int not null, server_updated_at timestamptz default now(); pk (space_id, record_key); index (space_id, seq))
   - space_events(id bigserial pk, space_id → spaces cascade, kind text check in ('created','invite_created','invite_revoked','join_requested','approved','rejected','removed','left','key_rotated','ownership_transferred'), actor_id, subject_id null, created_at). Members can read their own space's events (the "activity" list for run C/D).
   Access:
   - No direct table privileges for anon. Authenticated users get SELECT only through RLS "is an active member of this space" on spaces, space_members (including other members' public keys), space_events and their own space_keys rows.
   - No table can be written directly. space_records and space_invites are reached only through functions.
   - Every function is SECURITY DEFINER with `set search_path = ''` and auth.uid(), raises when it is null, and is granted EXECUTE to authenticated only.
   - Errors follow run 2: `MINIMA:<code>` with the new codes not_space_member, not_space_owner, already_in_space, invite_invalid (one code for not-found, expired, used, revoked or a wrong token, so it can't be probed), member_limit, wrong_key_version, key_outdated, members_mismatch, space_paused, space_gone, cannot_remove_owner, owner_must_transfer_or_delete, plus the existing device_*, batch_too_large, quota_exceeded and invalid_input.
   Permissions:
   - Add internal (not granted) effective_plan_for(p_user uuid) and has_feature_for(p_user, p_feature). Refactor run 2's effective_plan() / has_feature() to call them, with identical behaviour; the run 2 tests must still pass.
   - Space access is decided by the OWNER's plan: has_feature_for(owner_id, 'shared_spaces'). Members need no plan of their own for the Family stream (family plan: the owner pays). Their personal sync still uses their own plan.
   - If the owner loses the feature, the space is "paused": push and pull raise space_paused. get_my_space, leave_space, delete_space and transfer_ownership still work.
   Functions:
   - get_my_space() → null or { space_id, role, status, key_version, owner_id, members: [{ user_id, email, role, status, public_key, requested_at, joined_at }], my_keys: [{ key_version, wrapped_key }] (only for active members), open_invites (owner only: id, expires_at), paused, limits (owner's plan features), last_seq, record_count, total_bytes }.
     - A pending user sees only their own pending status (no members list, no keys).
     - Emails are shown to members of the same space only. State this in the privacy policy.
   - create_space(p_space_id, p_public_key, p_wrapped_key_for_self):
     - requires has_feature_for(caller, 'shared_spaces') and no existing membership (already_in_space)
     - creates the space with the caller as active owner, space_keys version 1 for the caller, and the 'created' event
   - create_invite(p_space_id, p_token_hash, p_expires_in_hours default 48): owner only; at most 5 open invites per space; returns { invite_id, expires_at }.
   - revoke_invite(p_invite_id): owner only.
   - get_invite(p_invite_id, p_token) → { space_id, owner_email, members_count, expires_at }.
     - only a valid, unused, unexpired, unrevoked invite with a matching token; any other case is invite_invalid
     - used by the join screen to show "Join <owner email>'s Family"
   - request_join(p_invite_id, p_token, p_public_key):
     - validates as above
     - the caller must not be in any space (already_in_space)
     - active + pending members must be < max_members (member_limit)
     - inserts a pending member, marks the invite used (single use, even if the request is later rejected), and adds the 'join_requested' event
   - approve_member(p_space_id, p_user_id, p_key_version, p_wrapped_key):
     - owner only; the target must be pending; p_key_version must equal spaces.key_version (wrong_key_version)
     - re-checks max_members
     - sets the member active, inserts the space_keys row, adds the 'approved' event
   - reject_member(p_space_id, p_user_id): owner only; deletes the pending row; 'rejected' event.
   - remove_member(p_space_id, p_user_id):
     - owner only; the owner can't remove themselves (cannot_remove_owner)
     - deletes the member row and all of their space_keys rows; 'removed' event
     - their devices are refused at once on push and pull. Rotation is a separate call by the owner's device.
   - rotate_space_key(p_space_id, p_new_version, p_wraps jsonb [{ user_id, wrapped_key }]):
     - owner only; p_new_version must be key_version + 1 (wrong_key_version)
     - p_wraps must cover exactly the current active members, including the owner (members_mismatch)
     - inserts the new space_keys rows, sets key_version, 'key_rotated' event, all in one transaction
     - old space_keys rows are kept, so active members can still read records not yet re-encrypted
   - leave_space(): a member (not the owner, owner_must_transfer_or_delete) deletes their row and space_keys; 'left' event.
   - transfer_ownership(p_space_id, p_user_id): owner only; the target must be an active member; the roles swap; 'ownership_transferred' event.
   - delete_space(p_space_id): owner only; deletes the space (cascades to members, invites, keys, records, events). Members then get space_gone / null from get_my_space.
   - push_space_records(p_space_id, p_device_id, p_key_version, p_records):
     - the caller must be an active member, with a registered, non-removed device (the run 2 devices table)
     - the space must not be paused
     - p_key_version must equal spaces.key_version (key_outdated, with the current version in the message)
     - the same limits as run 2 (500 records, 1 MB) and the owner's plan quotas max_space_records / max_space_bytes
     - locks the spaces row (FOR UPDATE) so seq order equals commit order
     - writes when incoming updated_at_ms > stored, OR when updated_at_ms = stored AND p_key_version > the stored key_version (a re-encryption after rotation). Anything else is 'stale' with the stored row returned, exactly like run 2.
     - author_id = auth.uid(); returns { results, last_seq } in the run 2 shape
   - pull_space_records(p_space_id, p_device_id, p_since, p_limit default 500, max 1000): active member, device check, not paused. Rows ordered by seq, with has_more, last_seq and the current key_version.
   - delete_own_account (run 2, unchanged):
     - for an owner, the cascade deletes the space (owner_id FK)
     - for a member, the membership and keys disappear and the 'left' event is written by a trigger before the delete (or record a CONTRACT_GAP if that isn't possible). The owner's device rotates in run C.
   - get_sync_status (run 2) gains space: { space_id, role, status, paused } | null.

3. SQL TESTS (PGlite harness from run 2; also the manual check script)
   Cover every acceptance item below with several users (owner, two members, an outsider). Apply the migration twice; the run 2 tests must keep passing unchanged.

4. TYPED CLIENT (src/lib/cloud/spacesApi.ts)
   - createSpacesApi(rpc) with getMySpace, createSpace, createInvite, revokeInvite, getInvite, requestJoin, approveMember, rejectMember, removeMember, rotateSpaceKey, leaveSpace, transferOwnership, deleteSpace, pushSpaceRecords, pullSpaceRecords.
     - runtime-validated results, errors mapped to CloudError codes
     - not used by the app yet
   - Invite helpers in src/lib/spaces/invite.ts:
     - createInviteSecret() (32 random bytes)
     - inviteToken(secret) (HKDF, base64url) and inviteTokenHash(token) (SHA-256, hex)
     - buildInviteUrl(origin, inviteId, secret) → `${origin}/join#${inviteId}.${secretB64url}`
     - parseInviteFragment(hash) → { inviteId, secret } | null
     - pure functions with tests; the secret never appears in a query string or a server call
   - End-to-end client tests against the PGlite harness, including a full scenario written only with client calls and run A crypto:
     1. the owner creates a space
     2. an invite is created
     3. member B gets the invite and requests to join
     4. the owner approves by wrapping the SK for B's public key
     5. B unwraps the SK from my_keys and decrypts a record pushed by the owner
     6. the owner removes B and rotates the key; B's pull is refused; C (still a member) unwraps the new key and reads records re-pushed under version 2

5. PRIVACY POLICY UPDATE
   - In /privacy (uk and en), add a "Family space" part:
     - the server knows which accounts share a Family space, their roles and emails (visible to the other members), who wrote each encrypted record and when
     - Family content is encrypted with a key only members hold
     - a removed member keeps what was already on their devices but gets nothing new
     - deleting the space removes it from the server
   - Update "Last updated". No other UI changes.

CONSTRAINTS
- No app flows, no sync-engine changes, no UI except the privacy text. Nothing calls the new functions outside tests.
- No new runtime dependencies. No service-role key in the client. No secrets committed.
- Don't change run 2 behaviour (only the documented internal refactor of has_feature).
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test (including PGlite) must all pass.
- Docs:
  - ADR "Family space server: invite token without key, owner approval with key wrap, key rotation on removal, owner-plan permissions"
  - docs/db.md: tables, functions, permission model, family plan switch, manual steps
  - spec section "21. Family space server"
  - CLAUDE.md: the spaces API and "the invite secret never leaves the URL fragment"

MANUAL STEPS (docs/db.md and the PR)
1. Run supabase/migrations/20261029000000_family_spaces.sql in the Supabase SQL editor, then the check script (it must finish without errors).
2. No env changes in this run.

ACCEPTANCE (each must be a test)
- Migration: idempotent; RLS is on for every new table; anon can execute nothing; the plan seeds gained the new features while keeping the old keys; run 2 tests pass.
- One space per user: create_space while already a member or pending → already_in_space; request_join likewise.
- Invites:
  - expired, used, revoked, unknown or wrong-token all return the same invite_invalid
  - an invite works only once, even after a rejection
  - the 6th open invite → error
  - a non-owner can't create or revoke invites
- Join: a pending user sees no members, no keys and no records (table selects and functions). approve_member with a wrong key_version → wrong_key_version. The member limit is enforced at request and at approve (with 6 active, the next request → member_limit).
- Isolation: an outsider and a pending user can't read spaces, members, keys, events or records; a member can't read another member's space_keys; space A's members can't touch space B.
- Roles: a member can't approve, reject, remove, rotate, transfer or delete (not_space_owner); the owner can't remove themselves or leave (owner_must_transfer_or_delete); transfer then leave works.
- Removal and rotation:
  - after remove_member, the removed user's push and pull fail and their space_keys rows are gone
  - rotate with a wrap missing for an active member, or an extra non-member → members_mismatch
  - a valid rotation raises key_version
  - push with the old version → key_outdated
  - re-pushing an equal updated_at_ms with the new key_version is accepted; an equal one with the same version is stale
- Records:
  - seq increases strictly per space
  - pull paging works
  - an older or equal updated_at_ms is stale with the current row
  - author_id is the caller
  - batch and quota limits come from the OWNER's plan (a member whose own plan is 'free' can still push while the owner has 'beta')
- Paused: with sync_free_for_all false and no owner entitlement, push and pull → space_paused, while get_my_space, leave, transfer and delete still work; a 'family' entitlement for the owner restores access.
- Deletion: delete_space removes everything for that space; deleting the owner's auth user deletes the space; deleting a member's auth user removes their membership and keys.
- Client: every spacesApi function works against the harness; the full owner/B/C scenario above passes; invite helpers round-trip and parseInviteFragment rejects malformed input; errors map to CloudError codes.
- Privacy page: the Family section renders in uk and en.

OUT OF SCOPE
Create, invite, join and members screens, approval UI, client-side rotation and re-encryption, the Family sync stream (run C); the space switcher and Family UX (run D); payments; settle-up; more than one space per user.
```
