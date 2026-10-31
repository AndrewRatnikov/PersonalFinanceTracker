// CONTRACT_GAP: the checklist's section headings are not fixed; the seven areas
//   are checked by the distinctive terms each must mention.
//
// Repo-structure guard (like the other tests in scripts/): reads the docs from
// disk, nothing else.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const CHECKLIST = 'docs/release/accounts-sync-family-checklist.md'

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('go-live checklist', () => {
  it('exists', () => {
    expect(existsSync(join(ROOT, CHECKLIST))).toBe(true)
  })

  it('is linked from CLAUDE.md', () => {
    expect(read('CLAUDE.md')).toContain(CHECKLIST)
  })

  it('has numbered sections', () => {
    const headings = read(CHECKLIST).match(/^#{2,3} \d+[.)]? /gm) ?? []

    expect(headings.length).toBeGreaterThanOrEqual(7)
  })

  it.each([
    ['migrations and check scripts', ['20261023000000_sync_server.sql', '20261029000000_family_spaces.sql', 'sync_server_checks.sql', 'family_spaces_checks.sql']],
    ['Google OAuth', ['Google', '/auth/callback', '/privacy', '/terms']],
    ['legal constants', ['src/lib/legal.ts']],
    ['plans and free-for-all', ['plans', 'sync_free_for_all']],
    ['Vercel flags and order', ['VITE_ENABLE_ACCOUNTS', 'VITE_ENABLE_SYNC', 'VITE_ENABLE_SPACES', 'rollback']],
    ['smoke test', ['two-device', 'two-account']],
    ['backups and monitoring', ['backup', 'sync_records', 'space_records']],
  ])('covers %s', (_area, terms) => {
    const text = read(CHECKLIST)

    for (const term of terms) expect(text.toLowerCase()).toContain(term.toLowerCase())
  })

  it('lists the enable order accounts, then sync, then spaces', () => {
    const text = read(CHECKLIST)
    const accounts = text.indexOf('VITE_ENABLE_ACCOUNTS')
    const sync = text.indexOf('VITE_ENABLE_SYNC')
    const spaces = text.indexOf('VITE_ENABLE_SPACES')

    expect(accounts).toBeGreaterThanOrEqual(0)
    expect(sync).toBeGreaterThan(accounts)
    expect(spaces).toBeGreaterThan(sync)
  })
})

describe('spec section 23', () => {
  it('docs/free-tier-spec.md has the Family budget in daily use section', () => {
    expect(read('docs/free-tier-spec.md')).toMatch(/^## 23\. Family budget in daily use/m)
  })
})
