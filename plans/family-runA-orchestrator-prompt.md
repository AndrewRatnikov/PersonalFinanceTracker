# Orchestrator prompt: Family budget run A of 4 — local data for spaces

Starts from `main` after the three sync runs are merged.

## Agreed product decisions

- **Two spaces at most:** Personal and one Family space. Each entry lives in exactly one of them.
- **A global switch** in the menu (Personal | Family) decides what the whole app shows: dashboard, transactions, income, recurring, budgets, analytics. There is no combined "All" view. Some people will use only Family, so the app remembers the last chosen space per device.
- **Shared pot:** "we spend together, we track together". "Who owes whom" may come later.
- **Every member can add, edit and delete every Family entry.** The owner manages members and can delete the space.
- **Up to 6 members** in the beta. Free during the beta; later "create a Family space" becomes a plan feature, and joining stays free.
- **End-to-end encrypted:** the Family data is encrypted with its own space key, which every member holds. The server only stores ciphertext.

## Runs

| Run | What | Visible? |
|---|---|---|
| **A (this one)** | Local data can belong to Personal or Family: space-aware storage, space key, member key pair, per-space sync API | No |
| B | Server: spaces, members, invites, wrapped space keys, membership-based access, plan feature and limits | No |
| C | Sharing: create Family, invite link + owner approval, join, members screen, remove with key replacement, leave, delete, sync engine per space | Behind a flag |
| D | Family UX: space switcher, "Paid by", by-member analytics, family budgets, "Move to Family", copy | Behind a flag |

```text
Prepare MinimaSpend's local data layer for a shared Family space next to the user's personal data. This run adds NO network code and NO visible UI: the existing personal data and every screen must work exactly as today. Later runs add the server, invitations and the UI. Where this prompt is silent, follow existing localDb patterns and record a CONTRACT_GAP. Read docs/adr/ (especially the sync ADRs) and spec §17–19 first.

PRODUCT RULES (for context)
- A user has a Personal space (all existing data) and at most one Family space.
- A global switch will choose which space the whole app shows. There is no combined view.
- Every Family member can edit every Family entry.
- Family data is encrypted with a random space key (SK), never with a member's DEK.

1. SPACES MODEL
   - SpaceId = 'personal' | string (uuid for a Family space).
   - Personal keeps its CURRENT storage keys, unchanged (expenses_YYYY_MM, income, categories, incomeCategories, budgets, recurring, syncedSettings, meta:sync). There is no migration of existing data.
   - A Family space uses the same data keys with the prefix `space:<spaceId>:` (e.g. `space:<id>:expenses_2026_10`, `space:<id>:syncedSettings`) and its own plaintext `space:<spaceId>:meta:sync` { localRev, …sync fields }.
     - Family records are encrypted with that space's SK (AES-GCM, the same record format as personal keys).
     - Per-space syncedSettings means each space has its own main currency and rates switch.
   - Records in a Family space gain optional fields:
     - createdBy (memberId)
     - paidBy (memberId, expenses and income only)
     - updatedBy (memberId, set on every write)
     memberId is the Supabase user id; it is null/absent while no account is linked (local tests). Personal records never carry them.
   - A new Family-only single record `spaceInfo` { id: 'space', name, createdAt, updatedAt, rev } and a list key `memberProfiles` [{ id: memberId, displayName, color, updatedAt, rev, deletedAt? }]. Both are encrypted with SK and sync like other records.

2. KEYS
   - Member identity key pair: ensureIdentityKeyPair() creates an ECDH P-256 key pair with WebCrypto (extractable private JWK) only when first needed.
     - It is stored in a new encrypted PERSONAL data key `identity` { id: 'identity', publicKeyJwk, privateKeyJwk, createdAt, updatedAt, rev }, so it syncs to the user's other devices through personal sync.
     - getIdentityPublicKey() returns the public JWK.
   - Space keys: a new encrypted PERSONAL data key `spaceKeys`, an array of { id: spaceId, keyVersion, key (raw 256-bit, base64), name, role: 'owner' | 'member', joinedAt, updatedAt, rev, deletedAt? }.
     - Synced with personal data, so the user's other devices get the Family space automatically.
     - Only the newest keyVersion per space is used for writing. Older versions are kept for reading records not yet re-encrypted.
   - Pure crypto helpers in src/lib/spaces/spaceCrypto.ts:
     - generateSpaceKey()
     - wrapSpaceKeyForPublicKey(sk, recipientPublicJwk) / unwrapSpaceKey(wrapped, myPrivateJwk): ECIES style, with an ephemeral ECDH P-256 key, HKDF-SHA256 (info "minima-space-key-wrap-v1") and AES-GCM; output { v: 1, epk, iv, ct }
     - wrapSpaceKeyWithSecret(sk, inviteSecret) / unwrapSpaceKeyWithSecret: HKDF from a 32-byte random secret, for invite links in run C
     - deriveSyncKeys must accept any 256-bit root key (DEK or SK), so the run 2/3 record format works per space with keys derived from that space's SK
   - On lock and on "Remove data", all in-memory space keys and identity keys are dropped, exactly like the DEK.

3. SPACE-AWARE localDb
   - Every data function (reads, writes, recurring processing, conversion helpers, listChangedRecords, applyIncomingRecords, compactTombstones, CSV, suggestions, repeat-last, analytics inputs) takes an explicit space, either via a small scoped API, spaceDb(spaceId), or a required/optional { spaceId } argument. Choose one, apply it consistently, and document it.
   - The default is 'personal', so existing callers and tests keep working unchanged.
   - Key resolution and encryption go through one place: keyFor(spaceId, baseKey) and cryptoFor(spaceId). A Family space whose SK is missing or locked raises a typed SpaceLockedError (never falls back to the DEK).
   - Write locks include the space-prefixed keys and the right meta:sync key. The localRev / rev rules from run 1 apply per space: a Family write bumps only that space's localRev.
   - Family writes stamp updatedBy / createdBy with the current memberId when one is known (getCurrentMemberId() reads the account session; it may return null). paidBy defaults to createdBy on create.
   - Space-wide background work must cover every space the device holds a key for, not just the active one:
     - recurring generation (occurrence ids stay deterministic; a recurring item lives in one space)
     - conversion (each space converts to its own main currency)
     - the syncedSettings migration (personal only)
     - the Data problem screen and quarantine (labels name the space)
   - React Query keys include the spaceId so personal and Family caches never mix. The multi-tab channel carries the spaceId.
   - New spaces API (no UI yet): listLocalSpaces(), createLocalSpace({ name }) (generates SK and spaceId, writes the spaceKeys entry, spaceInfo, default categories and income categories in the current language, and syncedSettings with the personal main currency, as one setMany per key group), forgetLocalSpace(spaceId) (removes the space's keys and its spaceKeys entry; used later by leave / removed), getActiveSpaceId() / setActiveSpaceId() persisted per device in localStorage `minima_active_space` (falls back to 'personal' if the space is unknown).
   - A SpaceProvider + useActiveSpace() hook that existing data hooks read. In this run it always resolves to 'personal' unless a test sets it. Nothing renders a switcher yet.

4. SYNC API PER SPACE
   - listChangedRecords(spaceId, sinceRev) and applyIncomingRecords(spaceId, records, options) work for both spaces. SyncRecord gains no new fields; the type union adds 'spaceInfo' | 'memberProfile' for Family and 'identity' | 'spaceKey' for personal.
   - The personal sync engine from run 3 keeps working unchanged for personal data, and now also carries identity and spaceKeys. Test that a second device of the same user receives the space key through personal sync and can read Family data written by the first device.
   - Do NOT add Family streams to the engine yet (run C).

5. BACKUP, CSV, REMOVE DATA
   - Backup (.minima, version stays 1, additive): the personal payload as today plus identity and spaceKeys, and an optional `spaces` object { [spaceId]: { spaceInfo, memberProfiles, categories, expenses, income, budgets, incomeCategories, recurring, settings } } with tombstones and without rev.
   - Restore: a space in the backup is restored only if its key is present (in the backup's spaceKeys or locally); otherwise it is skipped and reported in the restore summary. Old backups restore unchanged.
   - CSV export and import work on the active space only, and the file name includes the space name.
   - "Remove data from this device" removes every space's keys and the active-space choice.

CONSTRAINTS
- No network code, no Supabase changes, no visible UI changes. ENABLE_SPACES (VITE_ENABLE_SPACES, default off) is added to featureFlags for later runs and is not used by UI yet.
- No new runtime dependencies. Do not change the meta:vault header, personal key names, personal encryption or the backup version.
- Every existing test passes without changes, except where a function signature gained the space argument (call sites updated mechanically).
- Performance: personal flows are not slower. Opening the app with a 20,000-record Family space plus a 20,000-record personal store stays within the existing test timeouts.
- Follow .claude/rules/testing.md. tsc --noEmit, npm run lint (0 warnings) and npm test must all pass.
- Docs:
  - ADR "Spaces: personal plus one Family space, per-space key, member identity keys"
  - spec section "20. Spaces (groundwork)"
  - CLAUDE.md: how to make a function space-aware, the keyFor / cryptoFor rule, "never encrypt Family data with the DEK", React Query keys with spaceId

ACCEPTANCE (each must be a test)
- Isolation:
  - writing an expense to Family creates only `space:<id>:expenses_YYYY_MM`, encrypted so that the DEK can't decrypt it and the SK can
  - personal lists, totals and analytics are unchanged by Family writes, and the other way round
- Revs: a Family write bumps only that space's localRev; a personal write only the personal one. listChangedRecords(spaceId, n) returns only that space's records.
- Locked space: with the SK absent, Family reads and writes raise SpaceLockedError, and personal still works.
- Member fields: on a Family create, createdBy = updatedBy = paidBy = the current memberId; an edit by another memberId changes updatedBy only; personal records never get these fields.
- Crypto:
  - wrap and unwrap of an SK for a public key round-trips; another private key fails
  - wrap and unwrap with an invite secret round-trips; a wrong secret fails
  - deriveSyncKeys(SK) gives keys different from deriveSyncKeys(DEK)
- Identity: ensureIdentityKeyPair is idempotent and synced as a personal record; the public key comes out as JWK.
- Two devices of one user (run 3 harness): device 1 creates a local space and writes Family expenses; after personal sync, device 2 has the spaceKeys entry and can decrypt Family records applied via applyIncomingRecords('space-id', …).
- Background work: recurring items in Family generate Family entries with deterministic ids, and conversion uses the Family main currency, both while the active space is personal.
- Active space: setActiveSpaceId persists; an unknown id falls back to personal; React Query caches for the two spaces never mix (hook test).
- Backup: a round trip with a Family space restores it; a backup without the space key skips the space and reports it; a backup made before this run restores; rev never appears.
- Remove data clears everything, including space keys and minima_active_space.
- With ENABLE_SPACES off, every existing UI test passes unchanged.

OUT OF SCOPE
Server tables, invitations, membership, key rotation on removal (run B/C), the Family sync stream (run C), the space switcher and all Family UI (run D), payments, settle-up.
```
