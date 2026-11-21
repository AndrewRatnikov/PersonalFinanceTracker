// The public data API. The code lives in src/lib/db/, one file per domain, in
// layers (lowest first; a file imports only from its own or a lower layer, with
// no import cycles):
//   0 context: store, vault DEK, space context, keyring loader, cryptoFor
//   1 records, revs, storage: liveness, the meta:sync counter, encrypted writes
//   2 events: commit hook (lastDataChangeAt, conversion trigger)
//   3 settings, maintenance: synced settings, quarantine
//   4 expenses, categories, income, budgets, entryConversion
//   5 recurringOccurrences, recurring
//   6 lifecycle, sync, syncApply, rekey, spaces, move
//   7 personal: the Personal space's top-level functions
//   8 handles: SpaceDb / spaceDb(spaceId)
// src/lib/db/layout.test.ts enforces the layers and a 700-line limit per file.
//
// Callers import '@/lib/localDb' only, never a db file. Db files never import
// this barrel: a test mock of '@/lib/localDb' must only affect callers outside
// the folder. A new data function goes into the matching domain file as
// xIn(ctx, ...), its Personal wrapper into db/personal.ts, the member into
// db/handles.ts, and its re-export here. Re-exporting db/context also runs its
// setKeyringLoader(loadKeyring) on import.

export { DecryptError } from './dataErrors'
export { SpaceReadOnlyError, isSpaceReadOnlyError } from './spaces/types'
export {
  IDENTITY_KEY,
  MEMBER_PROFILES_KEY,
  SETTINGS_DEFAULT_UPDATED_AT,
  SPACE_INFO_KEY,
  SPACE_KEYS_KEY,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  clearLocalDb,
  cryptoFor,
  getLocalDbKey,
  getLocalStore,
  unlockLocalDb,
  wipeLocalDbKey,
} from './db/context'
export type { SpaceCrypto } from './db/context'
export { syncMetaEntry } from './db/revs'
export {
  expenseChunkKey,
  notifyLocalChange,
  onLocalChange,
  onSpaceLocalChange,
} from './db/storage'
export { onConversionNeeded, requestEntryConversion } from './db/events'
export { migrateSyncedSettings } from './db/settings'
export { hasLocalData, quarantineKey } from './db/maintenance'
export type {
  ConversionStorageGroup,
  EntryConversionUpdate,
} from './db/entryConversion'
export { prepareUnlockedVault } from './db/lifecycle'
export type {
  AppliedIncomingRecord,
  ApplyIncomingOptions,
  ApplyIncomingResult,
  ChangedRecords,
} from './db/sync'
export { rekeyLiveData } from './db/rekey'
export type { RekeyResult } from './db/rekey'
export {
  adoptSpaceKey,
  createLocalSpace,
  ensureIdentityKeyPair,
  ensureSpaceIndexKey,
  forgetLocalSpace,
  getIdentityPublicKey,
  getMemberProfiles,
  getSpaceInfo,
  getSpaceKeyEntry,
  listLocalSpaces,
  listSpaceKeyEntries,
  updateSpaceEntry,
  updateSpaceInfo,
  upsertMemberProfile,
} from './db/spaces'
export type { AdoptSpaceKeyInput, SpaceEntryPatch } from './db/spaces'
export {
  MOVE_RECORDS_MAX,
  copyCategoriesFromSpace,
  moveRecords,
} from './db/move'
export type {
  CopyCategoriesResult,
  MoveRecordType,
  MoveRecordsInput,
  MoveRecordsResult,
} from './db/move'
export {
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  addRecurring,
  addRepeatingExpense,
  addRepeatingIncome,
  applyEntryConversions,
  applyIncomingRecords,
  compactTombstones,
  confirmRecurringOccurrence,
  convertBudgets,
  dedupeOccurrences,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  deleteIncomeCategory,
  deleteRecurring,
  ensureIncomeCategories,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getDueRecurring,
  getExpensesForRange,
  getLocalRev,
  listChangedRecords,
  processDueRecurring,
  provisionDefaultCategories,
  readEntriesForConversion,
  readSyncedSettings,
  setRecurringPaused,
  skipRecurringOccurrence,
  undeleteExpense,
  updateCategory,
  updateExpense,
  updateIncomeCategory,
  updateRecurring,
  updateSyncedSettings,
  upsertBudget,
} from './db/personal'
export { spaceDb } from './db/handles'
export type { SpaceDb } from './db/handles'
