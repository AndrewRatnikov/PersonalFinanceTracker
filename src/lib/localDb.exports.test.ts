// No CONTRACT_GAPs. Public surface of the localDb barrel (split into src/lib/db/).
// Runtime names: captured from today's single file; the stub ENABLE_SUPABASE_SYNC is
// the one removal. Types: checked by `tsc --noEmit` through the type-only import.

import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  AdoptSpaceKeyInput,
  AppliedIncomingRecord,
  ApplyIncomingOptions,
  ApplyIncomingResult,
  ChangedRecords,
  ConversionStorageGroup,
  CopyCategoriesResult,
  EntryConversionUpdate,
  MoveRecordType,
  MoveRecordsInput,
  MoveRecordsResult,
  RekeyResult,
  SpaceCrypto,
  SpaceDb,
  SpaceEntryPatch,
} from '@/lib/localDb'

const EXPECTED_RUNTIME_EXPORTS = [
  'DecryptError',
  'IDENTITY_KEY',
  'MEMBER_PROFILES_KEY',
  'MOVE_RECORDS_MAX',
  'SETTINGS_DEFAULT_UPDATED_AT',
  'SPACE_INFO_KEY',
  'SPACE_KEYS_KEY',
  'SYNCED_SETTINGS_KEY',
  'SYNC_META_KEY',
  'SpaceReadOnlyError',
  'addCategory',
  'addExpense',
  'addIncome',
  'addIncomeCategory',
  'addRecurring',
  'addRepeatingExpense',
  'addRepeatingIncome',
  'adoptSpaceKey',
  'applyEntryConversions',
  'applyIncomingRecords',
  'clearLocalDb',
  'compactTombstones',
  'confirmRecurringOccurrence',
  'convertBudgets',
  'copyCategoriesFromSpace',
  'createLocalSpace',
  'cryptoFor',
  'dedupeOccurrences',
  'deleteBudget',
  'deleteCategory',
  'deleteExpense',
  'deleteIncome',
  'deleteIncomeCategory',
  'deleteRecurring',
  'ensureIdentityKeyPair',
  'ensureIncomeCategories',
  'ensureSpaceIndexKey',
  'expenseChunkKey',
  'forgetLocalSpace',
  'getAllBudgets',
  'getAllCategories',
  'getAllExpenses',
  'getAllIncome',
  'getAllIncomeCategories',
  'getAllRecurring',
  'getDueRecurring',
  'getExpensesForRange',
  'getIdentityPublicKey',
  'getLocalDbKey',
  'getLocalRev',
  'getLocalStore',
  'getMemberProfiles',
  'getSpaceInfo',
  'getSpaceKeyEntry',
  'hasLocalData',
  'isSpaceReadOnlyError',
  'listChangedRecords',
  'listLocalSpaces',
  'listSpaceKeyEntries',
  'migrateSyncedSettings',
  'moveRecords',
  'notifyLocalChange',
  'onConversionNeeded',
  'onLocalChange',
  'onSpaceLocalChange',
  'prepareUnlockedVault',
  'processDueRecurring',
  'provisionDefaultCategories',
  'quarantineKey',
  'readEntriesForConversion',
  'readSyncedSettings',
  'rekeyLiveData',
  'requestEntryConversion',
  'setRecurringPaused',
  'skipRecurringOccurrence',
  'spaceDb',
  'syncMetaEntry',
  'undeleteExpense',
  'unlockLocalDb',
  'updateCategory',
  'updateExpense',
  'updateIncomeCategory',
  'updateRecurring',
  'updateSpaceEntry',
  'updateSpaceInfo',
  'updateSyncedSettings',
  'upsertBudget',
  'upsertMemberProfile',
  'wipeLocalDbKey',
]

const keys = Object.keys(await import('@/lib/localDb')).sort()

describe('localDb barrel exports', () => {
  it('exports exactly the captured runtime names (ENABLE_SUPABASE_SYNC aside)', () => {
    expect(EXPECTED_RUNTIME_EXPORTS).toHaveLength(89)
    expect(new Set(EXPECTED_RUNTIME_EXPORTS).size).toBe(89)
    expect(keys.filter((k) => k !== 'ENABLE_SUPABASE_SYNC')).toEqual(
      [...EXPECTED_RUNTIME_EXPORTS].sort(),
    )
  })

  it('no longer exports the dead ENABLE_SUPABASE_SYNC stub', () => {
    expect(keys).not.toContain('ENABLE_SUPABASE_SYNC')
  })

  it('keeps every public type exported under its name', () => {
    expectTypeOf<AdoptSpaceKeyInput>().not.toBeNever()
    expectTypeOf<AppliedIncomingRecord>().not.toBeNever()
    expectTypeOf<ApplyIncomingOptions>().not.toBeNever()
    expectTypeOf<ApplyIncomingResult>().not.toBeNever()
    expectTypeOf<ChangedRecords>().not.toBeNever()
    expectTypeOf<ConversionStorageGroup>().not.toBeNever()
    expectTypeOf<CopyCategoriesResult>().not.toBeNever()
    expectTypeOf<EntryConversionUpdate>().not.toBeNever()
    expectTypeOf<MoveRecordType>().not.toBeNever()
    expectTypeOf<MoveRecordsInput>().not.toBeNever()
    expectTypeOf<MoveRecordsResult>().not.toBeNever()
    expectTypeOf<RekeyResult>().not.toBeNever()
    expectTypeOf<SpaceCrypto>().not.toBeNever()
    expectTypeOf<SpaceDb>().not.toBeNever()
    expectTypeOf<SpaceEntryPatch>().not.toBeNever()
  })
})
