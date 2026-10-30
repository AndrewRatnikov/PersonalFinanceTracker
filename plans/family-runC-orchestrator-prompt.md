# Orchestrator prompt: Family budget run C of 4 — sharing flows and Family sync

Starts from `main` once run B (Family server) is merged and its SQL has been applied in Supabase.

| Run | What | Visible? |
|---|---|---|
| A | Local data for Personal + Family, space key, member key pair | done |
| B | Server: spaces, members, invites, approval, wrapped keys, rotation, Family records | done |
| **C (this one)** | Create Family, invite link, join, owner approval with safety code, members screen, remove / leave / transfer / delete, key replacement and re-encryption, Family sync stream | Behind flags |
| D | Space switcher, "Paid by", analytics by member, family budgets, "Move to Family", copy | Behind flags |

```text
Make the Family space work between real people. An owner creates a Family, sends an invite link, approves the person who opens it, and from then on the Family data syncs between all members' devices, encrypted with the space key. Removing a member cuts them off and replaces the key. This run adds the flows, the Settings → Family screen and the Family sync stream. The space switcher and everyday Family screens come in run D, so Family data must still never appear in personal views. Where this prompt is silent, choose the simplest behaviour that never loses data and never gives a non-member the key, and record a CONTRACT_GAP. Read the ADRs of sync runs 1–3 and Family runs A–B, and spec §17–21, first.

CONTEXT
- Run A:
  - space-aware localDb (`space:<id>:` keys, per-space meta:sync and syncedSettings)
  - createLocalSpace / forgetLocalSpace / listLocalSpaces / active space
  - personal data keys `identity` (ECDH P-256 key pair) and `spaceKeys` (synced through personal sync)
  - spaceCrypto (generateSpaceKey, wrapSpaceKeyForPublicKey / unwrapSpaceKey)
  - deriveSyncKeys(root key)
  - createdBy / updatedBy / paidBy; memberProfiles and spaceInfo records
  - ENABLE_SPACES flag
- Run B:
  - get_my_space, create_space, create_invite, revoke_invite, get_invite, request_join, approve_member, reject_member, remove_member, rotate_space_key, leave_space, transfer_ownership, delete_space, push_space_records, pull_space_records
  - owner-plan permissions and pausing
  - error codes
  - src/lib/cloud/spacesApi.ts; src/lib/spaces/invite.ts (secret, token, hash, URL with #fragment)
  - PGlite harness
- Run 3: the sync engine (pull then push, cursors, server wins exact ties, useSyncState, Settings → Sync, the multi-device harness).

1. SPACE KEY BUNDLE (fixes record keys across rotation; write it in the ADR)
   - Record keys must stay the same when the space key is replaced, otherwise re-encrypted records would become new rows.
   - A Family therefore has two secrets:
     - indexKey: 32 random bytes created once with the space and never rotated
     - sk: the per-version data key
   - What is wrapped for a member is a bundle { v: 1, keyVersion, sk, indexKey }. Extend the run A wrap helpers to wrap a bundle (the same ECIES scheme over the encoded bundle) if they only take 32 bytes.
   - The spaceKeys entry gains indexKey (additive).
   - record_key = HMAC-SHA256(HKDF(indexKey, "minima-space-index-v1"), `${type}:${id}`)
   - data key = HKDF(sk, "minima-sync-data-v1"), with AES-GCM additional data = record_key + ':' + keyVersion
   - Personal sync is unchanged. A removed member still knows indexKey and so learns only the record keys of ids they already had. Document this.

2. FAMILY SYNC STREAM (extend the run 3 engine)
   - One cycle runs the personal stream, then the Family stream when this device holds a spaceKeys entry for an active space.
     - Same lock, triggers, backoff and preconditions as run 3. A Family error never blocks personal sync, and the other way round.
     - The Family stream uses pull_space_records / push_space_records and the space's own meta:sync (pushedRev, pullCursor, keyVersion, state, lastError).
   - Pull: decrypt each row with the stored key for that row's key_version.
     - A row whose version this device doesn't have yet first triggers a get_my_space refresh (which may bring a newer wrap). If the key is still missing, the row is skipped and reported, and the cursor is not advanced past it (it is retried on the next cycle).
     - Apply through applyIncomingRecords(spaceId, …).
   - Push: encrypt with the current keyVersion.
     - On key_outdated: refresh get_my_space, unwrap the newest bundle from my_keys, store it in spaceKeys (personal write, so the user's other devices get it), and retry the batch once.
     - Stale results are handled as in run 3 (server wins ties).
   - get_my_space is refreshed at the start of each Family cycle (cheap), and its result drives the states below and approval notifications.
   - Family states in useSyncState(spaceId): 'syncing' | 'synced' | 'offline' | 'paused' (space_paused) | 'pending-approval' | 'removed' (not_space_member after having been active) | 'space-gone' | 'rotation-pending' | 'error'.
   - A device of an already-approved user (for example their second phone) gets the bundle through personal sync (spaceKeys) and starts the Family stream automatically after registering the device. No second approval is needed. Test this.

3. CREATE A FAMILY (Settings → Family tab, shown when ENABLE_SPACES + ENABLE_SYNC + accounts are visible)
   - Preconditions: signed in, sync on for this device (otherwise "Turn on sync first" with a button to Settings → Sync), and the plan has shared_spaces (from get_sync_status limits). Otherwise "Family isn't included in your plan".
   - The form takes a name (default "Family" in the current language). On submit:
     1. createLocalSpace (run A) plus a new indexKey
     2. ensureIdentityKeyPair
     3. wrap the bundle for one's own public key
     4. create_space
     5. write one's own memberProfile ({ displayName from the email's local part, color })
     6. push the initial Family records (spaceInfo, default categories, settings, profile)
   - A failure after create_space leaves a usable state: retry finishes the push, and nothing is duplicated (ids are deterministic or idempotent).
   - Already in a space (already_in_space): show the existing membership instead.

4. INVITE (owner)
   - "Invite member":
     1. createInviteSecret → inviteToken → inviteTokenHash
     2. create_invite
     3. show the link from buildInviteUrl with "Copy" and native "Share" (navigator.share when available), plus a line: "Anyone with this link can ask to join. You approve every request. The link works once and expires in 48 hours."
   - The secret exists only in that link: never stored, never logged, never sent to the server or analytics.
   - "Open invites" list: expiry and Revoke. The member count against max_members is shown, and "Invite" is disabled at the limit.

5. JOIN (new route /join; reads location.hash on the client only)
   - On load: parseInviteFragment; remove the fragment from the address bar with history.replaceState; keep { inviteId, secret } in sessionStorage `minima_pending_invite` with a 1-hour expiry, so it survives the vault unlock and the Google sign-in redirect; clear it as soon as it is used or abandoned. A malformed fragment shows "This invite link is invalid".
   - Steps, each resuming the flow after it completes:
     1. Unlocked vault. With no vault on this device, offer "Create your encrypted space" (the normal first-run flow) or "Restore with sync" (run 3), then come back.
     2. Signed in (to /login?redirect=/join).
     3. Sync on for this device (turn on in place).
   - Then get_invite shows "Join <owner email>'s Family · N members · expires …". invite_invalid shows "This invite expired or was already used. Ask for a new link."
   - "Ask to join": ensureIdentityKeyPair, then request_join, then the 'pending-approval' state.
     - Show "Your safety code: XXXX-XXXX-XXXX": the first 6 bytes of SHA-256 of the canonical public JWK, grouped. Advise comparing it with the owner by phone or in person.
     - The Family tab shows "Waiting for <owner email> to approve".
   - On approval (detected at the next cycle):
     1. unwrap the bundle from my_keys
     2. store the spaceKeys entry with role 'member'
     3. write one's own memberProfile
     4. full Family pull with progress
     5. toast "You joined <space name>"
   - Errors: already_in_space ("You're already in a Family"), member_limit, and paused, each with plain text in both languages.

6. APPROVE / REJECT (owner)
   - When get_my_space shows pending members:
     - a badge on Settings → Family
     - a toast once per new request ("<email> asks to join your Family")
     - in the tab, each request shows the email, the time and the same safety code computed from their public key, with a hint to compare it
   - "Approve": wrap the current bundle for their public key, then approve_member. On wrong_key_version, refresh and retry once.
   - "Reject": reject_member.

7. MEMBERS, REMOVE, LEAVE, TRANSFER, DELETE
   - The members list shows display name (from memberProfiles, falling back to the email), email, role, joined date and a "You" marker. "Your name in Family" is editable (updates one's own memberProfile). The space name is editable by any member (spaceInfo).
   - Remove (owner, confirm dialog: "They keep what was already on their devices but get nothing new"):
     1. remove_member
     2. rotation: a new sk (same indexKey), version + 1, a bundle wrapped for every remaining active member's public key from get_my_space, then rotate_space_key
     3. store the new spaceKeys entry (keeping the old versions for reading)
     4. re-encryption: re-push every Family record (live and tombstones) with the new keyVersion, in batches with progress
     - The server accepts these as equal-updated_at_ms re-encryptions (run B rule).
     - Until rotation succeeds the space is 'rotation-pending': Family pushes wait, and rotation retries every cycle. members_mismatch triggers a refresh and a retry.
     - The owner's device also rotates automatically when it sees a member who left or whose account was deleted (a member set smaller than the current wraps, or a 'left' event since the last rotation).
   - Leave (member): confirm, then leave_space.
   - Transfer ownership (owner): pick an active member, confirm, then transfer_ownership. Now the old owner can leave.
   - Delete Family (owner):
     1. offer "Download backup first"
     2. type the space name to confirm
     3. delete_space, then forgetLocalSpace on this device (the spaceKeys entry is tombstoned, so the user's other devices forget it too after personal sync)
   - Removed, left, or space gone, on the affected member's devices:
     - the space becomes READ-ONLY locally: Family writes raise SpaceReadOnlyError (add it in localDb, keyed by a local status on the spaceKeys entry)
     - the Family stream stops
     - the tab shows "You're no longer in <name>. You can keep a read-only copy on this device or remove it."
     - "Remove from this device" calls forgetLocalSpace and tombstones the spaceKeys entry

8. PAUSED
   - space_paused shows "Family sync is paused: the owner's plan doesn't include it. Changes are kept and will sync when it's back."
   - Local Family edits continue and queue.

9. UI AND STRINGS
   - All new UI goes in the Settings → Family tab and /join only. No switcher, no Family data in dashboards (run D).
   - The tab also shows: the Family sync state, last sync, the entry count, and the plan line with member limits.
   - All strings go in uk and en, and the glossary: Family → Сім'я, Invite → Запросити, Ask to join → Попросити приєднатися, Approve → Схвалити, Reject → Відхилити, Safety code → Код безпеки, Leave → Вийти, Transfer ownership → Передати права власника, Owner → Власник, Member → Учасник. The untranslated-text guard must pass.
   - /join with the flags off shows "Not available".

CONSTRAINTS
- Flags: everything requires ENABLE_SPACES + ENABLE_SYNC + accounts visible. All flags stay off in production. With the flags off, no space function is called and no Family UI renders.
- No new runtime dependencies. No server changes unless truly needed: then an additive migration plus the check script, listed as a manual step.
- No change to personal sync behaviour, local encryption or the backup version.
- Never log secrets, keys, bundles or plaintext. The invite secret never appears in a query string, a server call, storage other than the short-lived sessionStorage entry, or an error message.
- Rotation and re-encryption of 20,000 Family records must stay responsive, with progress shown.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test (including PGlite) must all pass.
- Docs:
  - ADR "Family sharing flows: key bundle with fixed index key, approval with safety code, rotation and re-encryption, read-only after removal"
  - spec section "22. Family sharing"
  - CLAUDE.md: the Family stream, rotation rules, how to simulate several users and devices

ACCEPTANCE (each must be a test; multi-user scenarios on the PGlite harness with owner O, member B with devices B1 and B2, member C, newcomer D and outsider X)
- Create: O creates "Family". The server has the space and O as owner, the initial records are ciphertext only (no name, category or amount in any column), and a retry after an injected failure doesn't duplicate anything.
- Invite and join:
  - O's invite link contains the secret only after #
  - no server call or sessionStorage entry after use contains it
  - B1 opens /join, the pending invite survives a simulated sign-in redirect, and B asks to join
  - B sees no Family data while pending
  - O and B compute the same safety code
  - O approves; B1 unwraps the bundle and pulls everything O wrote
  - B2 (same user) gets the key via personal sync and syncs Family without a new approval
- Invite errors: a used, expired, revoked or wrong-secret link shows the same "expired or used" message; already_in_space and member_limit show their messages.
- Merging:
  - O and B1 edit the same Family expense offline, and after sync all devices have the newer edit
  - delete vs edit follows newest wins
  - a Family recurring item generating on O and B1 offline gives exactly one entry everywhere
  - createdBy / updatedBy / paidBy are correct per author
- Removal and rotation:
  - O removes C; C's next cycle → 'removed', the local Family copy is read-only (a write raises SpaceReadOnlyError), and "Remove from this device" forgets it
  - O rotates to version 2 and re-encrypts; after it completes every server row has key_version 2
  - B1's push gets key_outdated, adopts version 2 and succeeds
  - C can't pull anything
  - a rotation that fails offline leaves 'rotation-pending' with pushes waiting, and succeeds on the next cycle
- Late join: D joins after the rotation; rows still on version 1 during an unfinished re-encryption are skipped without advancing the cursor; after the re-encryption D has every record.
- Leave and delete:
  - B leaves → O's device rotates automatically
  - O transfers ownership to B and then can leave
  - B deletes the Family → all members see 'space-gone' with a read-only copy, and the server has nothing for the space
- Paused: the owner's plan loses shared_spaces → Family 'paused', personal sync continues, local Family edits queue and sync after access returns.
- Isolation: Family records never appear in personal lists, totals, analytics, CSV or the personal sync stream, and personal records never go into the Family stream.
- Many records: rotation and re-encryption of 20,000 Family records completes within the test timeout, with progress events.
- UI (jsdom, mocked APIs):
  - the Settings → Family tab renders every state (not signed in, sync off, not in plan, create, owner with invites and requests, member, pending, removed, paused, rotation-pending) in uk and en
  - the invite dialog has Copy and Share
  - the delete confirm requires the space name
  - /join with flags off shows "Not available"
- i18n: both catalogs have identical keys, and the guard passes.

MANUAL CHECK (Vercel Preview with VITE_ENABLE_ACCOUNTS, VITE_ENABLE_SYNC and VITE_ENABLE_SPACES set to true; two Google accounts)
1. Account 1 creates a Family and shares the invite link to account 2's phone.
2. Account 2 opens the link, unlocks or creates a vault, signs in and asks to join. Both compare the safety code, and account 1 approves.
3. Settings → Family shows the same member list and entry count on both phones.
4. Account 1 removes account 2. Account 2's phone shows "You're no longer in…" with a read-only copy.
5. In the Supabase table editor, space_records contains only opaque keys and ciphertext.

OUT OF SCOPE
The space switcher, Family entries in Dashboard, Transactions, Income, Recurring, Budgets and Analytics, "Paid by" UI, analytics by member, "Move to Family", landing copy (all run D); payments and the upgrade screen; settle-up; QR codes; push notifications; more than one Family per user.
```
