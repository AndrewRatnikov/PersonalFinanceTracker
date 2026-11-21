// Layer 7 of src/lib/db: the Personal space's top-level functions.

import { PERSONAL_CTX, ctxFor } from './context'
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
import type {
  BudgetEntry,
  Category,
  CreateCategoryInput,
  CreateExpenseInput,
  CreateIncomeInput,
  CreateRecurringInput,
  Currency,
  Expense,
  IncomeEntry,
  RecurringItem,
  RecurringOccurrence,
  SyncedSettingsRecord,
  UpdateCategoryInput,
  UpdateExpenseInput,
  UpdateRecurringInput,
  UpsertBudgetInput,
} from '../domain'
import type { SpaceId } from '../spaces/types'
import type { SyncRecord } from '../syncRecords'
import type { Lang } from '../../i18n/lang'
import type {
  ConversionStorageGroup,
  EntryConversionUpdate,
} from './entryConversion'
import type { OccurrenceOverrides } from './recurringOccurrences'
import type { QuickRepeatUnit } from './recurring'
import type {
  ApplyIncomingOptions,
  ApplyIncomingResult,
  ChangedRecords,
} from './sync'

// ── Personal exports and the space handle ─────────────────────────────────────
//
// The top-level functions below are the Personal space and keep their
// signatures. spaceDb(id) gives the same members for any space.

const P_CTX = PERSONAL_CTX

export async function getLocalRev(): Promise<number> {
  return getLocalRevIn(P_CTX)
}
export function readSyncedSettings(): Promise<SyncedSettingsRecord> {
  return readSyncedSettingsIn(P_CTX)
}
export function updateSyncedSettings(patch: { fetchExchangeRates?: boolean }): Promise<void> {
  return updateSyncedSettingsIn(P_CTX, patch)
}
export function getExpensesForRange(from: string, to: string): Promise<Array<Expense>> {
  return getExpensesForRangeIn(P_CTX, from, to)
}
export function getAllExpenses(): Promise<Array<Expense>> {
  return getAllExpensesIn(P_CTX)
}
export function addExpense(input: CreateExpenseInput): Promise<Expense> {
  return addExpenseIn(P_CTX, input)
}
export function deleteExpense(id: string, createdAt: string): Promise<void> {
  return deleteExpenseIn(P_CTX, id, createdAt)
}
export function undeleteExpense(id: string, createdAt: string): Promise<Expense> {
  return undeleteExpenseIn(P_CTX, id, createdAt)
}
export function updateExpense(
  id: string,
  originalCreatedAt: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  return updateExpenseIn(P_CTX, id, originalCreatedAt, patch)
}
export function getAllCategories(): Promise<Array<Category>> {
  return getAllCategoriesIn(P_CTX)
}
export function addCategory(input: CreateCategoryInput): Promise<Category> {
  return addCategoryIn(P_CTX, input)
}
export function updateCategory(input: UpdateCategoryInput): Promise<Category> {
  return updateCategoryIn(P_CTX, input)
}
export function deleteCategory(id: string): Promise<void> {
  return deleteCategoryIn(P_CTX, id)
}
export function provisionDefaultCategories(lang?: Lang): Promise<void> {
  return provisionDefaultCategoriesIn(P_CTX, lang)
}
export function getAllIncomeCategories(): Promise<Array<Category>> {
  return getAllIncomeCategoriesIn(P_CTX)
}
export function addIncomeCategory(input: CreateCategoryInput): Promise<Category> {
  return addIncomeCategoryIn(P_CTX, input)
}
export function updateIncomeCategory(input: UpdateCategoryInput): Promise<Category> {
  return updateIncomeCategoryIn(P_CTX, input)
}
export function deleteIncomeCategory(id: string): Promise<void> {
  return deleteIncomeCategoryIn(P_CTX, id)
}
export function ensureIncomeCategories(lang?: Lang): Promise<boolean> {
  return ensureIncomeCategoriesIn(P_CTX, lang)
}
export function getAllIncome(): Promise<Array<IncomeEntry>> {
  return getAllIncomeIn(P_CTX)
}
export function addIncome(input: CreateIncomeInput): Promise<IncomeEntry> {
  return addIncomeIn(P_CTX, input)
}
export function deleteIncome(id: string): Promise<void> {
  return deleteIncomeIn(P_CTX, id)
}
export function getAllBudgets(): Promise<
  Array<BudgetEntry & { categoryName: string; categoryIcon: string | null }>
> {
  return getAllBudgetsIn(P_CTX)
}
export function upsertBudget(input: UpsertBudgetInput): Promise<BudgetEntry> {
  return upsertBudgetIn(P_CTX, input)
}
export function deleteBudget(id: string): Promise<void> {
  return deleteBudgetIn(P_CTX, id)
}
export function readEntriesForConversion(): Promise<Array<ConversionStorageGroup>> {
  return readEntriesForConversionIn(P_CTX)
}
export function applyEntryConversions(
  storageKey: string,
  mainCurrency: Currency,
  updates: Array<EntryConversionUpdate>,
): Promise<number> {
  return applyEntryConversionsIn(P_CTX, storageKey, mainCurrency, updates)
}
export function convertBudgets(
  target: Currency,
  rateFor: (from: Currency) => number,
  options: { setMainCurrency: boolean },
): Promise<number> {
  return convertBudgetsIn(P_CTX, target, rateFor, options)
}
export function getAllRecurring(): Promise<Array<RecurringItem>> {
  return getAllRecurringIn(P_CTX)
}
export function getDueRecurring(today?: string): Promise<Array<RecurringOccurrence>> {
  return getDueRecurringIn(P_CTX, today)
}
export function processDueRecurring(
  today?: string,
): Promise<{ created: number; itemsTouched: number }> {
  return processDueRecurringIn(P_CTX, today)
}
export function addRecurring(
  input: CreateRecurringInput,
  options: { createThroughToday: boolean; today?: string },
): Promise<RecurringItem> {
  return addRecurringIn(P_CTX, input, options)
}
export function updateRecurring(id: string, patch: UpdateRecurringInput): Promise<RecurringItem> {
  return updateRecurringIn(P_CTX, id, patch)
}
export function setRecurringPaused(
  id: string,
  paused: boolean,
  today?: string,
): Promise<RecurringItem> {
  return setRecurringPausedIn(P_CTX, id, paused, today)
}
export function deleteRecurring(id: string): Promise<void> {
  return deleteRecurringIn(P_CTX, id)
}
export function confirmRecurringOccurrence(
  itemId: string,
  date: string,
  overrides?: OccurrenceOverrides,
): Promise<void> {
  return confirmRecurringOccurrenceIn(P_CTX, itemId, date, overrides)
}
export function skipRecurringOccurrence(itemId: string, date: string): Promise<void> {
  return skipRecurringOccurrenceIn(P_CTX, itemId, date)
}
export function addRepeatingExpense(
  input: CreateExpenseInput,
  unit: QuickRepeatUnit,
): Promise<Expense> {
  return addRepeatingExpenseIn(P_CTX, input, unit)
}
export function addRepeatingIncome(
  input: CreateIncomeInput,
  unit: QuickRepeatUnit,
): Promise<IncomeEntry> {
  return addRepeatingIncomeIn(P_CTX, input, unit)
}

// The sync API also takes a leading spaceId; the one-argument forms are
// personal (the sync engine and its ports use them unchanged).
export function listChangedRecords(sinceRev: number): Promise<ChangedRecords>
export function listChangedRecords(spaceId: SpaceId, sinceRev: number): Promise<ChangedRecords>
export function listChangedRecords(
  first: SpaceId | number,
  second?: number,
): Promise<ChangedRecords> {
  if (typeof first === 'string') {
    return listChangedRecordsIn(ctxFor(first), second ?? -1)
  }
  return listChangedRecordsIn(P_CTX, first)
}

export function applyIncomingRecords(
  records: Array<SyncRecord>,
  options?: ApplyIncomingOptions,
): Promise<ApplyIncomingResult>
export function applyIncomingRecords(
  spaceId: SpaceId,
  records: Array<SyncRecord>,
  options?: ApplyIncomingOptions,
): Promise<ApplyIncomingResult>
export function applyIncomingRecords(
  first: SpaceId | Array<SyncRecord>,
  second?: Array<SyncRecord> | ApplyIncomingOptions,
  third?: ApplyIncomingOptions,
): Promise<ApplyIncomingResult> {
  if (typeof first === 'string') {
    return applyIncomingRecordsIn(ctxFor(first), second as Array<SyncRecord>, third)
  }
  return applyIncomingRecordsIn(P_CTX, first, second as ApplyIncomingOptions | undefined)
}

export function compactTombstones(
  olderThan: string,
  options?: { maxRev?: number },
): Promise<number> {
  return compactTombstonesIn(P_CTX, olderThan, options)
}
export function dedupeOccurrences(recurringIds: Array<string>): Promise<number> {
  return dedupeOccurrencesIn(P_CTX, recurringIds)
}
