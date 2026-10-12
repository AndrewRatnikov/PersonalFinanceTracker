# The vault is usable before the recovery key is saved; an unconfirmed key is tracked and confirmed with a full random group

- **Status:** Accepted
- **Date:** 2026-10-07, revised 2026-10-10
- **Source:** orchestrator runs `run_20261007_220444` (Phase 2, vault v2) and `run_20261010_092310` (Phase 6, validation fixes, issues 3 and 4)
- **Code:** `src/lib/vault.ts`, `src/lib/appSettings.ts` (`recoveryKeyConfirmed`), `src/components/vault/RecoveryKeySaveStep.tsx` (`pickConfirmationGroup`), Dashboard `RecoveryKeyBanner`, Settings → Security
- **Spec:** `docs/free-tier-spec.md` §2.1 step 3, §4.3

## Context

The recovery key (160 bits, `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX`) is the only way back in after a forgotten password, and it is never stored. Phase 2 had to decide when the vault becomes usable relative to the "I've saved my key" step. It chose the simplest option, recorded as CONTRACT_GAP 4: `createVault` writes `meta:vault` and unlocks immediately, and the save step follows.

Validation on 2026-10-10 found two problems:

- Closing the tab during the save step left a vault whose key the user had never seen, and nothing ever prompted them again.
- The confirmation asked for the last group, which is only 2 characters, so it proved little.

## Decision

- **Keep the vault usable immediately**, but record a plaintext `recoveryKeyConfirmed: false` in `meta:settings`, written in the same transaction as every operation that produces a new key: create, the v1 migration, and regenerate. Only confirming the save step sets it to `true`. A missing field means confirmed, so older vaults don't nag. Only this boolean is stored, never the key or anything derived from it.
- While it is `false`, the Dashboard shows a persistent banner ("Create a new recovery key" → `/settings?tab=security`) and the Security card shows a warning. Regenerating and confirming clears it.
- **Confirmation asks for one full 5-character group**, picked at random from groups 1–6 when the step mounts ("Type group N of your key"), never the 2-character tail. Case and surrounding spaces are ignored.
- The v1 legacy localStorage keys are removed only after the migrated user confirms the new key (`clearLegacyKeys()` from the UI), not inside `unlockWithPassword`.
- A restore that adopts a backup's vault (fresh or orphaned device) removes the flag, because the key belongs to the backup and a stale `false` would nag about a vault that no longer exists.

## Alternatives considered

- **Don't commit the vault until the key is confirmed.** Not chosen. Closing the tab would lose the vault (and a migration), which is worse than an unconfirmed key that can be regenerated.
- **Store the key so it can be shown again.** Rejected: it would defeat the key's purpose.

## Consequences

- No vault can end up with a recovery key that was silently never shown: the user is reminded until they generate and confirm a new one.
- If the app closes during a migrated user's save step, the stale v1 keys remain. They are harmless because `meta:vault` wins.
