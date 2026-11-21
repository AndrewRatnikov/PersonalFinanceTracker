// Layer 6 of src/lib/db: the post-unlock routine.

import { listHeldSpaceIds } from '../spaces/keyring'
import { PERSONAL_CTX, ctxFor } from './context'
import { requestEntryConversion } from './events'
import { migrateSyncedSettings } from './settings'
import {
  ensureIncomeCategoriesIn,
  provisionDefaultCategoriesIn,
} from './categories'
import { processDueRecurringIn } from './recurringOccurrences'
import type { Lang } from '../../i18n/lang'

// Runs after every unlock: the synced settings migration first, then default
// expense categories for a new vault, then the income categories (defaults
// and legacy conversion), then the due recurring occurrences. Errors,
// including DecryptError, propagate to the caller. Returns how many recurring
// records were created. `lang` is the language of the default categories
// (only used when they are written).
export async function prepareUnlockedVault({
  isNewVault,
  lang = 'en',
}: {
  isNewVault: boolean
  lang?: Lang
}): Promise<{ recurringCreated: number }> {
  await migrateSyncedSettings()
  if (isNewVault) await provisionDefaultCategoriesIn(PERSONAL_CTX, lang)
  await ensureIncomeCategoriesIn(PERSONAL_CTX, lang)
  let { created } = await processDueRecurringIn(PERSONAL_CTX)
  // Every Family space this device holds a key for, while personal is active
  // (a DecryptError propagates as for personal).
  for (const spaceId of await listHeldSpaceIds()) {
    created += (await processDueRecurringIn(ctxFor(spaceId))).created
  }
  // Convert whatever is pending (old records, the records just generated).
  // Not awaited: the conversion runs in the background.
  requestEntryConversion()
  return { recurringCreated: created }
}
