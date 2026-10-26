# The sync permission gate covers calls that move data or keys; deleting cloud data and managing devices stay open

- **Status:** Accepted
- **Date:** 2026-10-24
- **Source:** orchestrator run `run_20261024_210606` (encrypted sync end to end; task: "every sync action goes through the run 2 permission gate")
- **Code:** `src/lib/sync/actions.ts`, `src/lib/sync/engine.ts`, `src/lib/cloud/entitlements.ts`

## Context

Sync is free during the beta, and the payments run is meant to add only an upgrade screen and a webhook, so the plan check must already sit at every sync entry point. The task said "every sync action", but a user whose plan lapses (or whose beta access ends) still needs to delete their cloud data and remove a lost device. The server already leaves `delete_cloud_data` and the device-management functions ungated ([2026-10-23-encrypted-sync-server-opaque-keys-plan-permissions](2026-10-23-encrypted-sync-server-opaque-keys-plan-permissions.md)).

## Decision

The client asks the server for a fresh status and checks `hasFeature(status, 'sync')` before `registerDevice`, `createVault`, `getVault` (for linking and restore), `updateVaultHeader`, `pushRecords` and `pullRecords`. `actions.ts` does this at the start of each such action (signed in, then fresh status, else `SyncActionError('sync_not_included')`), and the engine does it at the start of every cycle. Delete cloud data, turning sync off, and listing, renaming and removing devices are not gated.

## Alternatives considered

- **Gating everything.** A user on a lapsed plan could not delete their cloud data or remove a lost device, which the server also allows.

## Consequences

- The payments run needs no change to the client flow: changing the plan's features is enough.
- A new sync action that moves data or keys must be gated the same way (recorded in `CLAUDE.md` as "never push without the gate").
- Local data is always kept when the gate refuses; only data movement stops.
