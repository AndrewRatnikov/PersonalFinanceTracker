// No CONTRACT_GAPs: the restore request helpers are specified in plan section 9
// and the Interface Contract (module: restoreRequest). The feature flag is a
// mutable getter so one file can test both settings.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SYNC_RESTORE_PARAM,
  consumeSyncRestoreRequest,
  requestSyncRestore,
  requestSyncRestoreFromUrl,
} from '@/lib/sync/restoreRequest'

const flags = vi.hoisted(() => ({ sync: true }))

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  get ENABLE_SYNC() {
    return flags.sync
  },
}))

beforeEach(() => {
  flags.sync = true
  // Drain whatever an earlier test left behind.
  consumeSyncRestoreRequest()
})

describe('SYNC_RESTORE_PARAM', () => {
  it('is the "restore" query parameter', () => {
    expect(SYNC_RESTORE_PARAM).toBe('restore')
  })
})

describe('requestSyncRestore / consumeSyncRestoreRequest', () => {
  it('is false when nothing was requested', () => {
    expect(consumeSyncRestoreRequest()).toBe(false)
  })

  it('is true exactly once after a request', () => {
    requestSyncRestore()
    expect(consumeSyncRestoreRequest()).toBe(true)
    expect(consumeSyncRestoreRequest()).toBe(false)
  })

  it('a second request after consuming gives true again', () => {
    requestSyncRestore()
    consumeSyncRestoreRequest()
    requestSyncRestore()
    expect(consumeSyncRestoreRequest()).toBe(true)
  })
})

describe('requestSyncRestoreFromUrl', () => {
  it('accepts ?restore=sync, requests it and returns true', () => {
    expect(requestSyncRestoreFromUrl('?restore=sync')).toBe(true)
    expect(consumeSyncRestoreRequest()).toBe(true)
  })

  it('accepts the search string without the question mark and with other params', () => {
    expect(requestSyncRestoreFromUrl('restore=sync')).toBe(true)
    consumeSyncRestoreRequest()
    expect(requestSyncRestoreFromUrl('?a=1&restore=sync&b=2')).toBe(true)
    expect(consumeSyncRestoreRequest()).toBe(true)
  })

  it.each(['', '?', '?restore=other', '?restore=', '?restore=SYNC', '?other=sync'])(
    'returns false for %j and requests nothing',
    (search) => {
      expect(requestSyncRestoreFromUrl(search)).toBe(false)
      expect(consumeSyncRestoreRequest()).toBe(false)
    },
  )

  it('does nothing when ENABLE_SYNC is off', () => {
    flags.sync = false
    expect(requestSyncRestoreFromUrl('?restore=sync')).toBe(false)
    expect(consumeSyncRestoreRequest()).toBe(false)
  })
})
