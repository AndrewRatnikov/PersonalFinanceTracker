// Layer 8 of src/lib/db: the space handle (SpaceDb, spaceDb).

import { ctxFor } from './context'
import { getLocalRevIn } from './revs'
import { readSyncedSettingsIn, updateSyncedSettingsIn } from './settings'
import {
  addExpenseIn,
  deleteExpenseIn,
  getAllExpensesIn,
  getExpensesForRangeIn,
  undeleteExpenseIn,
  updateExpenseIn,
} from './expenses'
import {
  addCategoryIn,
  addIncomeCategoryIn,
  deleteCategoryIn,
  deleteIncomeCategoryIn,
  ensureIncomeCategoriesIn,
  getAllCategoriesIn,
  getAllIncomeCategoriesIn,
  provisionDefaultCategoriesIn,
  updateCategoryIn,
  updateIncomeCategoryIn,
} from './categories'
import { addIncomeIn, deleteIncomeIn, getAllIncomeIn } from './income'
import { deleteBudgetIn, getAllBudgetsIn, upsertBudgetIn } from './budgets'
import {
  applyEntryConversionsIn,
  convertBudgetsIn,
  readEntriesForConversionIn,
} from './entryConversion'
import {
  getAllRecurringIn,
  getDueRecurringIn,
  processDueRecurringIn,
} from './recurringOccurrences'
import {
  addRecurringIn,
  addRepeatingExpenseIn,
  addRepeatingIncomeIn,
  confirmRecurringOccurrenceIn,
  deleteRecurringIn,
  setRecurringPausedIn,
  skipRecurringOccurrenceIn,
  updateRecurringIn,
} from './recurring'
import {
  compactTombstonesIn,
  dedupeOccurrencesIn,
  listChangedRecordsIn,
} from './sync'
import { applyIncomingRecordsIn } from './syncApply'
import type { SpaceId } from '../spaces/types'
import type { SyncRecord } from '../syncRecords'
import type { SpaceCtx } from './context'
import type {
  ApplyIncomingOptions,
  ApplyIncomingResult,
  ChangedRecords,
} from './sync'
import type {
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  addRecurring,
  addRepeatingExpense,
  addRepeatingIncome,
  applyEntryConversions,
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
} from './personal'

// The data functions of one space, with exactly the signatures of the
// same-named top-level (personal) exports.
export interface SpaceDb {
  getLocalRev: () => Promise<number>
  readSyncedSettings: typeof readSyncedSettings
  updateSyncedSettings: typeof updateSyncedSettings
  getExpensesForRange: typeof getExpensesForRange
  getAllExpenses: typeof getAllExpenses
  addExpense: typeof addExpense
  deleteExpense: typeof deleteExpense
  undeleteExpense: typeof undeleteExpense
  updateExpense: typeof updateExpense
  getAllCategories: typeof getAllCategories
  addCategory: typeof addCategory
  updateCategory: typeof updateCategory
  deleteCategory: typeof deleteCategory
  provisionDefaultCategories: typeof provisionDefaultCategories
  getAllIncomeCategories: typeof getAllIncomeCategories
  addIncomeCategory: typeof addIncomeCategory
  updateIncomeCategory: typeof updateIncomeCategory
  deleteIncomeCategory: typeof deleteIncomeCategory
  ensureIncomeCategories: typeof ensureIncomeCategories
  getAllIncome: typeof getAllIncome
  addIncome: typeof addIncome
  deleteIncome: typeof deleteIncome
  getAllBudgets: typeof getAllBudgets
  upsertBudget: typeof upsertBudget
  deleteBudget: typeof deleteBudget
  readEntriesForConversion: typeof readEntriesForConversion
  applyEntryConversions: typeof applyEntryConversions
  convertBudgets: typeof convertBudgets
  getAllRecurring: typeof getAllRecurring
  getDueRecurring: typeof getDueRecurring
  processDueRecurring: typeof processDueRecurring
  addRecurring: typeof addRecurring
  updateRecurring: typeof updateRecurring
  setRecurringPaused: typeof setRecurringPaused
  deleteRecurring: typeof deleteRecurring
  confirmRecurringOccurrence: typeof confirmRecurringOccurrence
  skipRecurringOccurrence: typeof skipRecurringOccurrence
  addRepeatingExpense: typeof addRepeatingExpense
  addRepeatingIncome: typeof addRepeatingIncome
  listChangedRecords: (sinceRev: number) => Promise<ChangedRecords>
  applyIncomingRecords: (
    records: Array<SyncRecord>,
    options?: ApplyIncomingOptions,
  ) => Promise<ApplyIncomingResult>
  compactTombstones: typeof compactTombstones
  dedupeOccurrences: typeof dedupeOccurrences
}

function buildSpaceDb(ctx: SpaceCtx): SpaceDb {
  return {
    getLocalRev: () => getLocalRevIn(ctx),
    readSyncedSettings: () => readSyncedSettingsIn(ctx),
    updateSyncedSettings: (patch) => updateSyncedSettingsIn(ctx, patch),
    getExpensesForRange: (from, to) => getExpensesForRangeIn(ctx, from, to),
    getAllExpenses: () => getAllExpensesIn(ctx),
    addExpense: (input) => addExpenseIn(ctx, input),
    deleteExpense: (id, createdAt) => deleteExpenseIn(ctx, id, createdAt),
    undeleteExpense: (id, createdAt) => undeleteExpenseIn(ctx, id, createdAt),
    updateExpense: (id, createdAt, patch) => updateExpenseIn(ctx, id, createdAt, patch),
    getAllCategories: () => getAllCategoriesIn(ctx),
    addCategory: (input) => addCategoryIn(ctx, input),
    updateCategory: (input) => updateCategoryIn(ctx, input),
    deleteCategory: (id) => deleteCategoryIn(ctx, id),
    provisionDefaultCategories: (lang) => provisionDefaultCategoriesIn(ctx, lang),
    getAllIncomeCategories: () => getAllIncomeCategoriesIn(ctx),
    addIncomeCategory: (input) => addIncomeCategoryIn(ctx, input),
    updateIncomeCategory: (input) => updateIncomeCategoryIn(ctx, input),
    deleteIncomeCategory: (id) => deleteIncomeCategoryIn(ctx, id),
    ensureIncomeCategories: (lang) => ensureIncomeCategoriesIn(ctx, lang),
    getAllIncome: () => getAllIncomeIn(ctx),
    addIncome: (input) => addIncomeIn(ctx, input),
    deleteIncome: (id) => deleteIncomeIn(ctx, id),
    getAllBudgets: () => getAllBudgetsIn(ctx),
    upsertBudget: (input) => upsertBudgetIn(ctx, input),
    deleteBudget: (id) => deleteBudgetIn(ctx, id),
    readEntriesForConversion: () => readEntriesForConversionIn(ctx),
    applyEntryConversions: (key, main, updates) =>
      applyEntryConversionsIn(ctx, key, main, updates),
    convertBudgets: (target, rateFor, options) =>
      convertBudgetsIn(ctx, target, rateFor, options),
    getAllRecurring: () => getAllRecurringIn(ctx),
    getDueRecurring: (today) => getDueRecurringIn(ctx, today),
    processDueRecurring: (today) => processDueRecurringIn(ctx, today),
    addRecurring: (input, options) => addRecurringIn(ctx, input, options),
    updateRecurring: (id, patch) => updateRecurringIn(ctx, id, patch),
    setRecurringPaused: (id, paused, today) => setRecurringPausedIn(ctx, id, paused, today),
    deleteRecurring: (id) => deleteRecurringIn(ctx, id),
    confirmRecurringOccurrence: (itemId, date, overrides) =>
      confirmRecurringOccurrenceIn(ctx, itemId, date, overrides),
    skipRecurringOccurrence: (itemId, date) => skipRecurringOccurrenceIn(ctx, itemId, date),
    addRepeatingExpense: (input, unit) => addRepeatingExpenseIn(ctx, input, unit),
    addRepeatingIncome: (input, unit) => addRepeatingIncomeIn(ctx, input, unit),
    listChangedRecords: (sinceRev) => listChangedRecordsIn(ctx, sinceRev),
    applyIncomingRecords: (records, options) => applyIncomingRecordsIn(ctx, records, options),
    compactTombstones: (olderThan, options) => compactTombstonesIn(ctx, olderThan, options),
    dedupeOccurrences: (ids) => dedupeOccurrencesIn(ctx, ids),
  }
}

const handles = new Map<string, SpaceDb>()

// The data handle of a space: the same object for the same id every time.
// spaceDb('personal') behaves exactly like the top-level functions. A bad
// Family id throws TypeError.
export function spaceDb(spaceId: SpaceId): SpaceDb {
  let handle = handles.get(spaceId)
  if (!handle) {
    handle = buildSpaceDb(ctxFor(spaceId))
    handles.set(spaceId, handle)
  }
  return handle
}
