// @vitest-environment node
// No CONTRACT_GAPs. Source-scanning guards for the Family space server run
// (criteria 13, 14 and 16), in the style of guards.test.ts: nothing calls the
// new client yet, the new RPC names live in spacesApi.ts only, invite.ts is
// pure, and wrapSpaceKeyWithSecret stays reserved. The scanner patterns are
// proven with positive controls so a guard cannot pass because a regex matches
// nothing.

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

function raw(path: string): string {
  return readFileSync(join(SRC, path), 'utf8')
}

function source(path: string): string {
  return code(raw(path))
}

const SPACES_API_NAME = /\bspacesApi\b|\bcreateSpacesApi\b/
const SPACE_RPC_NAMES =
  /['"`](?:is_active_space_member|get_my_space|create_space|create_invite|revoke_invite|get_invite|request_join|approve_member|reject_member|remove_member|rotate_space_key|leave_space|transfer_ownership|delete_space|push_space_records|pull_space_records)['"`]/
const IMPORT_FROM = /(?<![.\w])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

function importsOf(text: string): Array<string> {
  return Array.from(code(text).matchAll(IMPORT_FROM), (m) => m[1])
}

describe('scanner self-check', () => {
  it('the name pattern catches the client and nothing else', () => {
    expect(SPACES_API_NAME.test("import { createSpacesApi } from './spacesApi'")).toBe(true)
    expect(SPACES_API_NAME.test('const api = spacesApi')).toBe(true)
    expect(SPACES_API_NAME.test('createCloudApi(rpc)')).toBe(false)
    expect(SPACES_API_NAME.test('const mySpacesApiKey = 1')).toBe(false)
  })

  it('the rpc name pattern catches quoted names only', () => {
    expect(SPACE_RPC_NAMES.test("rpc('push_space_records', args)")).toBe(true)
    expect(SPACE_RPC_NAMES.test('rpc("get_my_space")')).toBe(true)
    expect(SPACE_RPC_NAMES.test('rpc(`create_space`)')).toBe(true)
    expect(SPACE_RPC_NAMES.test("rpc('push_records', args)")).toBe(false)
    expect(SPACE_RPC_NAMES.test('const create_space_form = 1')).toBe(false)
  })

  it('the import pattern reads from-clauses and dynamic imports', () => {
    expect(importsOf("import { a } from './rpc'\nimport type { B } from '@/lib/x'")).toEqual([
      './rpc',
      '@/lib/x',
    ])
    expect(importsOf("const m = await import('./api')")).toEqual(['./api'])
    expect(importsOf("// import x from './api'")).toEqual([])
  })

  it('finds the files under test', () => {
    const files = appSources().map((f) => f.path)
    expect(files).toContain('lib/cloud/spacesApi.ts')
    expect(files).toContain('lib/cloud/rpc.ts')
    expect(files).toContain('lib/spaces/invite.ts')
    expect(files).toContain('lib/spaces/spaceCrypto.ts')
    expect(files).toContain('lib/cloud/api.ts')
    expect(files.some((p) => p.endsWith('.test.ts'))).toBe(false)
  })
})

describe('nothing in the app uses the Family client yet (criterion 13)', () => {
  it('only spacesApi.ts names spacesApi or createSpacesApi', () => {
    const offenders = appSources()
      .filter((f) => f.path !== 'lib/cloud/spacesApi.ts')
      .filter((f) => SPACES_API_NAME.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('spacesApi.ts exports createSpacesApi and currentKeyVersionOf', () => {
    const text = source('lib/cloud/spacesApi.ts')
    expect(text).toMatch(/export function createSpacesApi\s*\(/)
    expect(text).toMatch(/export function currentKeyVersionOf\s*\(/)
  })

  it('only spacesApi.ts names the new rpc functions', () => {
    const offenders = appSources()
      .filter((f) => f.path !== 'lib/cloud/spacesApi.ts')
      .filter((f) => SPACE_RPC_NAMES.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
    // ... and it really does name them.
    expect(source('lib/cloud/spacesApi.ts')).toMatch(SPACE_RPC_NAMES)
  })

  it('spacesApi.ts names all 15 rpc functions it wraps', () => {
    const text = source('lib/cloud/spacesApi.ts')
    for (const fn of [
      'get_my_space',
      'create_space',
      'create_invite',
      'revoke_invite',
      'get_invite',
      'request_join',
      'approve_member',
      'reject_member',
      'remove_member',
      'rotate_space_key',
      'leave_space',
      'transfer_ownership',
      'delete_space',
      'push_space_records',
      'pull_space_records',
    ]) {
      expect(text, fn).toMatch(new RegExp(`['"\`]${fn}['"\`]`))
    }
  })

  it('spacesApi.ts has no default rpc, no api import and no supabase import', () => {
    const imports = importsOf(raw('lib/cloud/spacesApi.ts'))
    expect(imports).toContain('./rpc')
    expect(imports).toContain('./types')
    expect(imports).toContain('zod')
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/^(?:\.\/api|@\/lib\/cloud\/api)$/)
      expect(spec, spec).not.toMatch(/supabase/i)
    }
    expect(source('lib/cloud/spacesApi.ts')).not.toMatch(/export function createSpacesApi\s*\(\s*\w+\s*(?::[^)=]*)?=/)
  })

  it('spacesApi.ts only imports the crypto and space types as types', () => {
    const text = source('lib/cloud/spacesApi.ts')
    const statements = text.match(/^import\b[^;'"]*?\bfrom\s+['"]@\/lib\/spaces\/[^'"]+['"]/gm) ?? []
    for (const statement of statements) expect(statement).toMatch(/^import type\b/)
  })

  it('inside lib/cloud only entitlements.ts still imports the api', () => {
    const importers = appSources()
      .filter((f) => f.path.startsWith('lib/cloud/') && f.path !== 'lib/cloud/api.ts')
      .filter((f) => importsOf(f.text).some((s) => /(?:^|\/)api$/.test(s)))
      .map((f) => f.path)
    expect(importers).toEqual(['lib/cloud/entitlements.ts'])
  })
})

describe('CloudError lives in rpc.ts (decision D7)', () => {
  it('rpc.ts defines CloudError and the rpc types', () => {
    const text = source('lib/cloud/rpc.ts')
    expect(text).toMatch(/export class CloudError extends Error/)
    expect(text).toMatch(/export type RpcFn/)
    expect(text).toMatch(/RpcResponse/)
    expect(text).toMatch(/RpcError/)
  })

  it('rpc.ts imports only types from ./types', () => {
    const imports = importsOf(raw('lib/cloud/rpc.ts'))
    expect(imports).toEqual(['./types'])
    expect(source('lib/cloud/rpc.ts')).toMatch(/import type \{[^}]*CloudErrorCode[^}]*\} from ['"]\.\/types['"]/)
  })

  it('api.ts re-exports from rpc.ts and no longer defines the class', () => {
    const text = source('lib/cloud/api.ts')
    expect(text).toMatch(/export \{ CloudError \} from ['"]\.\/rpc['"]/)
    expect(text).not.toMatch(/class CloudError/)
    expect(text).toMatch(/export type \{[^}]*RpcFn[^}]*\} from ['"]\.\/rpc['"]/)
  })

  it('api.ts still does not know the new codes or rpc names', () => {
    const text = source('lib/cloud/api.ts')
    expect(text).not.toMatch(SPACE_RPC_NAMES)
    expect(text).not.toMatch(/SPACE_SERVER_ERROR_CODES/)
  })
})

describe('invite.ts is pure (criterion 14)', () => {
  it('imports nothing from lib/cloud, supabase or any network code', () => {
    const imports = importsOf(raw('lib/spaces/invite.ts'))
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/cloud|supabase|sync|fetch/i)
    }
    expect(source('lib/spaces/invite.ts')).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage/)
  })

  it('never exports a raw key and derives the token with HKDF', () => {
    const text = source('lib/spaces/invite.ts')
    expect(text).not.toMatch(/\bexportKey\b/)
    expect(text).toMatch(/HKDF/)
    expect(text).toMatch(/SHA-256/)
    expect(raw('lib/spaces/invite.ts')).toContain('minima-invite-token-v1')
  })

  it('does not log', () => {
    expect(source('lib/spaces/invite.ts')).not.toMatch(/\bconsole\./)
    expect(source('lib/cloud/spacesApi.ts')).not.toMatch(/\bconsole\./)
  })

  it('only the invite module builds join links', () => {
    const offenders = appSources()
      .filter((f) => f.path !== 'lib/spaces/invite.ts')
      .filter((f) => /['"`]\/join#|\/join#\$\{/.test(code(f.text)))
      .map((f) => f.path)
    expect(offenders).toEqual([])
    expect(source('lib/spaces/invite.ts')).toMatch(/#/)
  })
})

describe('wrapSpaceKeyWithSecret stays reserved (criterion 16)', () => {
  it('spaceCrypto.ts says "reserved" right above wrapSpaceKeyWithSecret', () => {
    const lines = raw('lib/spaces/spaceCrypto.ts').split('\n')
    const at = lines.findIndex((l) => /function wrapSpaceKeyWithSecret\b/.test(l))
    expect(at).toBeGreaterThan(0)
    const above = lines.slice(Math.max(0, at - 4), at).join('\n')
    expect(above).toMatch(/reserved/i)
    expect(above).toMatch(/\/\//)
  })

  it('still exports both secret helpers', () => {
    const text = source('lib/spaces/spaceCrypto.ts')
    expect(text).toMatch(/export async function wrapSpaceKeyWithSecret\b/)
    expect(text).toMatch(/export async function unwrapSpaceKeyWithSecret\b/)
  })

  it('no app file other than spaceCrypto.ts calls it', () => {
    const callers = appSources()
      .filter((f) => f.path !== 'lib/spaces/spaceCrypto.ts')
      .filter((f) => /\bwrapSpaceKeyWithSecret\s*\(/.test(code(f.text)))
      .map((f) => f.path)
    expect(callers).toEqual([])
    // Positive control: the pattern does match the definition.
    expect(source('lib/spaces/spaceCrypto.ts')).toMatch(/\bwrapSpaceKeyWithSecret\s*\(/)
  })

  it('invite.ts does not use the secret-wrapping helpers', () => {
    expect(source('lib/spaces/invite.ts')).not.toMatch(/WithSecret/)
  })
})
