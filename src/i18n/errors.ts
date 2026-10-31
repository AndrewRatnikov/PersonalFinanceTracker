// Turns errors into text in the UI language. Errors are recognised by
// `name` + `code` (duck typing), so this module never imports vault.ts,
// backup.ts, conversion.ts or localDb.ts (they open IndexedDB at import).

import { isMessageKey, plural, t } from './core'
import type { MessageKey, MessageParams, PluralKey } from './core'
import type { AppErrorCode } from '../lib/appErrors'

const VALIDATION_PREFIX = 'errors.validation.'

// A zod issue message is a catalog key (errors.validation.*); anything else is
// shown as is.
export function validationMessage(message: string): string {
  if (message.startsWith(VALIDATION_PREFIX) && isMessageKey(message)) return t(message)
  return message
}

type ErrorLike = Error & { code?: unknown; [field: string]: unknown }

const VAULT_KEYS: Record<string, MessageKey> = {
  'incorrect-password': 'errors.vault.incorrectPassword',
  'incorrect-recovery-key': 'errors.vault.incorrectRecoveryKey',
  damaged: 'errors.vault.damaged',
  throttled: 'errors.vault.throttled',
  'invalid-state': 'errors.vault.invalidState',
}

// invalid-state covers three situations; the English message tells them apart.
const VAULT_INVALID_STATE_KEYS: Record<string, MessageKey> = {
  'No vault on this device': 'errors.vault.noVault',
  'This device already has data that is not in a new vault': 'errors.vault.dataExists',
}

const BACKUP_KEYS: Record<string, MessageKey> = {
  'invalid-file': 'errors.backup.invalidFile',
  'unsupported-version': 'errors.backup.unsupportedVersion',
  'wrong-secret': 'errors.backup.wrongSecret',
  damaged: 'errors.backup.damaged',
  'invalid-state': 'errors.backup.invalidState',
}

const MAIN_CURRENCY_KEYS: Record<string, MessageKey> = {
  offline: 'errors.mainCurrency.offline',
  'rates-off': 'errors.mainCurrency.ratesOff',
  'rates-unavailable': 'errors.mainCurrency.ratesUnavailable',
}

const APP_KEYS: Record<Exclude<AppErrorCode, 'validation'>, MessageKey | { plural: PluralKey }> = {
  'category-name-required': 'errors.app.categoryNameRequired',
  'category-exists': 'errors.app.categoryExists',
  'category-not-found': 'errors.app.categoryNotFound',
  'invalid-currency': 'errors.app.invalidCurrency',
  'category-used-by-expenses': { plural: 'errors.app.categoryUsedByExpenses' },
  'category-used-by-income': { plural: 'errors.app.categoryUsedByIncome' },
  'category-used-by-recurring': { plural: 'errors.app.categoryUsedByRecurring' },
  'recurring-not-found': 'errors.app.recurringNotFound',
  'occurrence-not-due': 'errors.app.occurrenceNotDue',
  'import-needs-categories': 'errors.app.importNeedsCategories',
  'import-empty-file': 'errors.app.importEmptyFile',
  'import-unknown-columns': 'errors.app.importUnknownColumns',
}

function paramsOf(err: ErrorLike): MessageParams {
  const raw = err.params
  if (typeof raw !== 'object' || raw === null) return {}
  const params: MessageParams = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = value
  }
  return params
}

function vaultMessage(err: ErrorLike, code: string): string | null {
  if (code === 'throttled') {
    const ms = typeof err.retryAfterMs === 'number' ? err.retryAfterMs : 0
    return t('errors.vault.throttled', { seconds: Math.max(1, Math.ceil(ms / 1000)) })
  }
  if (code === 'invalid-state') {
    return t(VAULT_INVALID_STATE_KEYS[err.message] ?? 'errors.vault.invalidState')
  }
  const key = VAULT_KEYS[code] as MessageKey | undefined
  return key ? t(key) : null
}

function backupMessage(err: ErrorLike, code: string): string | null {
  if (err.reason === 'compression') return t('errors.backup.compressionUnsupported')
  if (code === 'invalid-state' && err.message === 'Unlock the app to make a backup') {
    return t('errors.backup.invalidStateBackup')
  }
  const key = BACKUP_KEYS[code] as MessageKey | undefined
  return key ? t(key) : null
}

function appMessage(err: ErrorLike, code: string): string | null {
  const params = paramsOf(err)
  if (code === 'validation') {
    return typeof params.key === 'string' ? validationMessage(params.key) : null
  }
  if (!Object.prototype.hasOwnProperty.call(APP_KEYS, code)) return null
  const entry = APP_KEYS[code as Exclude<AppErrorCode, 'validation'>]
  if (typeof entry === 'string') return t(entry, params)
  const count = typeof params.count === 'number' ? params.count : Number(params.count)
  return plural(entry.plural, Number.isFinite(count) ? count : 0, params)
}

function codedMessage(err: ErrorLike): string | null {
  const code = typeof err.code === 'string' ? err.code : ''
  switch (err.name) {
    case 'VaultError':
      return vaultMessage(err, code)
    case 'BackupError':
      return backupMessage(err, code)
    case 'MainCurrencyChangeError': {
      const key = MAIN_CURRENCY_KEYS[code] as MessageKey | undefined
      return key ? t(key) : null
    }
    case 'AppError':
      return appMessage(err, code)
    case 'DecryptError': {
      const storageKey = typeof err.storageKey === 'string' ? err.storageKey : ''
      return t('errors.decrypt', { key: storageKey })
    }
    default:
      return null
  }
}

// Family (spaces) errors: server codes from CloudError, the client-side
// FamilyActionError codes and SpaceReadOnlyError. Anything else is the
// generic text with its code.
const FAMILY_CLOUD_KEYS: Record<string, MessageKey> = {
  invite_invalid: 'family.errors.inviteInvalid',
  already_in_space: 'family.errors.alreadyInSpace',
  member_limit: 'family.errors.memberLimit',
  space_paused: 'family.errors.paused',
  network: 'family.errors.offline',
  // create_invite raises quota_exceeded for a 6th open invite.
  quota_exceeded: 'family.errors.inviteLimit',
  not_space_owner: 'family.errors.notOwner',
  owner_must_transfer_or_delete: 'family.errors.ownerMustTransfer',
  not_signed_in: 'family.signIn.body',
}

const FAMILY_ACTION_KEYS: Record<string, MessageKey> = {
  not_signed_in: 'family.signIn.body',
  sync_off: 'family.errors.syncOff',
  not_in_plan: 'family.errors.notInPlan',
  not_owner: 'family.errors.notOwner',
  name_mismatch: 'family.errors.nameMismatch',
  invalid_name: 'family.errors.invalidName',
}

function lookupKey(table: Record<string, MessageKey>, code: string): MessageKey | null {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null
}

export function familyErrorMessage(err: unknown): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { name?: unknown; code?: unknown }
  const name = typeof e.name === 'string' ? e.name : ''
  const code = typeof e.code === 'string' ? e.code : ''
  let key: MessageKey | null = null
  if (name === 'CloudError') key = lookupKey(FAMILY_CLOUD_KEYS, code)
  else if (name === 'FamilyActionError') key = lookupKey(FAMILY_ACTION_KEYS, code)
  else if (name === 'SpaceReadOnlyError') key = 'family.errors.readOnly'
  if (key) return t(key)
  return t('family.errors.generic', { code: code || name || 'unknown' })
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const coded = codedMessage(err as ErrorLike)
    if (coded !== null) return coded
    if (err.message.trim() !== '') return err.message
  }
  return t('errors.unexpected')
}
