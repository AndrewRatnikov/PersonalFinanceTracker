// @vitest-environment node
// No CONTRACT_GAPs. Source-scanning guards (criteria 23 and 24, decisions D2
// and D4): this is the one place that reads repo source files; every other test
// avoids the filesystem. The scanner patterns are proven with positive controls
// so a guard can't pass just because its regex matches nothing.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

function isTestFile(path: string): boolean {
  return (
    /\.test\.tsx?$/.test(path) ||
    path.startsWith('test/') ||
    path.includes('/test/') ||
    path.endsWith('routeTree.gen.ts')
  )
}

interface SourceFile {
  path: string
  text: string
}

function appSources(): Array<SourceFile> {
  const out: Array<SourceFile> = []
  for (const entry of readdirSync(SRC, { recursive: true })) {
    const rel = String(entry).split('\\').join('/')
    if (!/\.tsx?$/.test(rel) || isTestFile(rel)) continue
    out.push({ path: rel, text: readFileSync(join(SRC, rel), 'utf8') })
  }
  return out
}

// Comments are stripped so an explanatory comment can't trip a guard.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function source(path: string): string {
  return code(readFileSync(join(SRC, path), 'utf8'))
}

const API_IMPORT =
  /(?:from|import)\s*\(?\s*['"](?:@\/lib\/cloud\/api|(?:\.\.?\/)+(?:lib\/)?cloud\/api|\.\/api)['"]/
const API_METHODS =
  /\b\w*[aA]pi\.(?:getVault|registerDevice|listDevices|renameDevice|removeDevice|createVault|updateVaultHeader|pushRecords|pullRecords|deleteCloudData)\s*\(/
const RPC_NAMES =
  /['"](?:register_device|list_devices|rename_device|remove_device|create_vault|get_vault|update_vault_header|push_records|pull_records|delete_cloud_data|get_sync_status)['"]/
const PLAN_ID_COMPARE =
  /plan_id\s*(?:===|!==|==|!=)|(?:===|!==|==|!=)\s*[\w.?]*plan_id\b|switch\s*\([^)]*plan_id/

describe('scanner self-check', () => {
  it('the plan_id pattern catches comparisons and ignores plain use', () => {
    expect(PLAN_ID_COMPARE.test("status.plan_id === 'beta'")).toBe(true)
    expect(PLAN_ID_COMPARE.test("if (s.plan_id != 'free')")).toBe(true)
    expect(PLAN_ID_COMPARE.test("'beta' !== s.plan_id")).toBe(true)
    expect(PLAN_ID_COMPARE.test('switch (status.plan_id) {')).toBe(true)
    expect(PLAN_ID_COMPARE.test('plan_id: string')).toBe(false)
    expect(PLAN_ID_COMPARE.test('PLAN_NAME_KEYS[status.plan_id]')).toBe(false)
  })

  it('the api import pattern catches the usual spellings', () => {
    expect(API_IMPORT.test("import { createCloudApi } from '@/lib/cloud/api'")).toBe(true)
    expect(API_IMPORT.test("import { x } from '../lib/cloud/api'")).toBe(true)
    expect(API_IMPORT.test("const m = await import('@/lib/cloud/api')")).toBe(true)
    expect(API_IMPORT.test("import { x } from '@/lib/cloud/types'")).toBe(false)
  })

  it('the api method pattern catches member calls only', () => {
    expect(API_METHODS.test('await cloudApi.pushRecords(a, b, c)')).toBe(true)
    expect(API_METHODS.test('api.deleteCloudData()')).toBe(true)
    expect(API_METHODS.test('await createVault(password)')).toBe(false)
  })

  it('finds source files to scan', () => {
    const files = appSources().map((f) => f.path)
    expect(files).toContain('lib/cloud/entitlements.ts')
    expect(files).toContain('lib/cloud/api.ts')
    expect(files.some((p) => p.endsWith('.test.ts'))).toBe(false)
    expect(files.length).toBeGreaterThan(50)
  })
})

describe('no cloud calls outside the gate (criterion 24)', () => {
  it('no app file outside src/lib/cloud imports the cloud api', () => {
    const offenders = appSources()
      .filter((f) => !f.path.startsWith('lib/cloud/'))
      .filter((f) => API_IMPORT.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('inside src/lib/cloud only entitlements.ts imports the api', () => {
    const importers = appSources()
      .filter((f) => f.path.startsWith('lib/cloud/') && f.path !== 'lib/cloud/api.ts')
      .filter((f) => API_IMPORT.test(code(f.text)))
      .map((f) => f.path)
    expect(importers).toEqual(['lib/cloud/entitlements.ts'])
  })

  it('createCloudApi is called only by entitlements.ts (and defined in api.ts)', () => {
    const callers = appSources()
      .filter((f) => /\bcreateCloudApi\s*\(/.test(code(f.text)))
      .map((f) => f.path)
      .sort()
    expect(callers).toEqual(['lib/cloud/api.ts', 'lib/cloud/entitlements.ts'])
  })

  it('no file calls an API method other than getSyncStatus', () => {
    const offenders = appSources()
      .filter((f) => f.path !== 'lib/cloud/api.ts')
      .filter((f) => API_METHODS.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('getSyncStatus is called only inside entitlements.ts', () => {
    const callers = appSources()
      .filter((f) => f.path !== 'lib/cloud/api.ts')
      .filter((f) => /\.getSyncStatus\s*\(/.test(code(f.text)))
      .map((f) => f.path)
    expect(callers).toEqual(['lib/cloud/entitlements.ts'])
  })

  it('no file outside api.ts names a sync RPC function', () => {
    const offenders = appSources()
      .filter((f) => f.path !== 'lib/cloud/api.ts')
      .filter((f) => RPC_NAMES.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('no plan id checks in the client (criterion 23)', () => {
  it('no app file compares plan_id', () => {
    const offenders = appSources()
      .filter((f) => PLAN_ID_COMPARE.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('entitlements.ts exposes the feature check', () => {
    const text = source('lib/cloud/entitlements.ts')
    expect(text).toMatch(/export function hasFeature/)
    expect(text).toMatch(/export function FeatureGate/)
    expect(text).toMatch(/export function useSyncStatus/)
  })
})

describe('key handling (decisions D1 and D2)', () => {
  it('recordCrypto.ts never imports vault.ts (no cycle)', () => {
    const text = source('lib/cloud/recordCrypto.ts')
    expect(text).not.toMatch(/from\s+['"](?:@\/lib\/vault|\.\.\/vault|\.\/vault)['"]/)
  })

  it('types.ts imports from vault and syncRecords as types only', () => {
    const text = source('lib/cloud/types.ts')
    const imports = text.match(/^import[^\n]*from\s+['"][^'"]*(?:vault|syncRecords)['"]/gm) ?? []
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line).toMatch(/^import type\b/)
  })

  it('no source file exports a raw key: exportKey is never used', () => {
    const offenders = appSources()
      .filter((f) => /\bexportKey\b/.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('vault.ts exposes getSyncKeys and imports HKDF material as non-extractable', () => {
    const text = source('lib/vault.ts')
    expect(text).toMatch(/export (?:async )?function getSyncKeys/)
    expect(text).toMatch(/importKey\(\s*['"]raw['"]\s*,\s*\w+\s*,\s*['"]HKDF['"]\s*,\s*false/)
  })

  it('the unchanged files still do not know about sync', () => {
    for (const file of ['lib/crypto.ts', 'lib/localDb.ts', 'lib/backup.ts', 'lib/featureFlags.ts']) {
      const text = source(file)
      expect(text, file).not.toMatch(/HKDF|getSyncKeys|lib\/cloud/)
    }
  })
})

describe('no secrets', () => {
  it('no source file mentions a service-role key', () => {
    const offenders = appSources()
      .filter((f) => /service[_-]?role[_-]?key|SUPABASE_SERVICE_ROLE/i.test(f.text))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})
