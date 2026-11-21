// @vitest-environment node
// No CONTRACT_GAPs. Layout guard for the localDb split: src/lib/localDb.ts is a barrel
// over src/lib/db/, and the db files form a layered graph with no cycles, never import
// the barrel and stay at most 700 lines. Reads source text only (style of
// guards.test.ts); the checker functions are proven on inline fixtures first so a guard
// can't pass just because it matches nothing.

import { readFileSync, readdirSync } from 'node:fs'
import { posix } from 'node:path'

import { describe, expect, it } from 'vitest'

type Graph = Record<string, Array<string>>

const ROOT = process.cwd()
const DB_DIR = 'src/lib/db'
const BARREL = 'src/lib/localDb'
const MAX_LINES = 700

// Layer table (lowest first). A file imports only from its own or a lower layer.
const LAYERS: Record<string, number> = {
  context: 0,
  records: 1,
  revs: 1,
  storage: 1,
  events: 2,
  settings: 3,
  maintenance: 3,
  expenses: 4,
  categories: 4,
  income: 4,
  budgets: 4,
  entryConversion: 4,
  recurringOccurrences: 5,
  recurring: 5,
  lifecycle: 6,
  sync: 6,
  syncApply: 6,
  rekey: 6,
  spaces: 6,
  move: 6,
  personal: 7,
  handles: 8,
}

// Comments are stripped so an explanatory comment can't trip a check.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Specifiers of import/export-from (incl. type forms), side-effect imports and dynamic imports.
function importsOf(text: string): Array<string> {
  const src = code(text)
  const out: Array<string> = []
  const patterns = [
    /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1])
  }
  return out
}

// Repo-relative path of a specifier without extension, or null for a package.
function resolveSpec(fromFile: string, spec: string): string | null {
  let target: string
  if (spec.startsWith('@/')) target = posix.join('src', spec.slice(2))
  else if (spec.startsWith('.')) target = posix.join(posix.dirname(fromFile), spec)
  else return null
  return target.replace(/\.tsx?$/, '')
}

function importsBarrel(fromFile: string, spec: string): boolean {
  return resolveSpec(fromFile, spec) === BARREL
}

function findCycle(graph: Graph): Array<string> | null {
  const state = new Map<string, 1 | 2>()
  const stack: Array<string> = []
  const visit = (node: string): Array<string> | null => {
    if (state.get(node) === 2) return null
    if (state.get(node) === 1) return [...stack.slice(stack.indexOf(node)), node]
    state.set(node, 1)
    stack.push(node)
    for (const next of graph[node] ?? []) {
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    state.set(node, 2)
    return null
  }
  for (const node of Object.keys(graph)) {
    const found = visit(node)
    if (found) return found
  }
  return null
}

function layerViolations(graph: Graph, layers: Record<string, number>): Array<string> {
  const out: Array<string> = []
  for (const [from, targets] of Object.entries(graph)) {
    for (const to of targets) {
      if (layers[to] > layers[from]) out.push(`${from} -> ${to}`)
    }
  }
  return out
}

function tooLong(text: string, max = MAX_LINES): boolean {
  return text.replace(/\n$/, '').split('\n').length > max
}

function isTestPath(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.includes('/test/') || path.endsWith('routeTree.gen.ts')
}

function dbFiles(): Array<string> {
  return readdirSync(`${ROOT}/${DB_DIR}`)
    .filter((name) => name.endsWith('.ts') && !isTestPath(name))
    .sort()
}

function readRepo(path: string): string {
  return readFileSync(`${ROOT}/${path}`, 'utf8')
}

describe('checker fixtures', () => {
  it('importsOf finds every import form', () => {
    const text = [
      "import { a } from './context'",
      "import type { B } from './records'",
      "export { c } from './revs'",
      "export type { D } from './storage'",
      "import './events'",
      "const m = await import('./settings')",
      'import {',
      '  e,',
      '  f,',
      "} from '../crypto'",
      "// import { z } from './commented'",
    ].join('\n')
    expect(importsOf(text).sort()).toEqual(
      ['../crypto', './context', './events', './records', './revs', './settings', './storage'].sort(),
    )
  })

  it('importsBarrel flags every spelling of the barrel and nothing else', () => {
    const from = 'src/lib/db/context.ts'
    expect(importsBarrel(from, '@/lib/localDb')).toBe(true)
    expect(importsBarrel(from, '@/lib/localDb.ts')).toBe(true)
    expect(importsBarrel(from, '../localDb')).toBe(true)
    expect(importsBarrel(from, '../localDb.ts')).toBe(true)
    expect(importsBarrel(from, './records')).toBe(false)
    expect(importsBarrel(from, '../crypto')).toBe(false)
    expect(importsBarrel(from, '@/lib/localDb.exports')).toBe(false)
    expect(importsBarrel(from, 'idb-keyval')).toBe(false)
  })

  it('a db sample importing the barrel is caught, a clean sample is not', () => {
    const from = 'src/lib/db/expenses.ts'
    const relative = "import { x } from '../localDb'\nimport { y } from './context'"
    const alias = "import { x } from '@/lib/localDb'"
    const clean = "import { y } from './context'\nimport { z } from '../crypto'"
    expect(importsOf(relative).some((s) => importsBarrel(from, s))).toBe(true)
    expect(importsOf(alias).some((s) => importsBarrel(from, s))).toBe(true)
    expect(importsOf(clean).some((s) => importsBarrel(from, s))).toBe(false)
  })

  it('findCycle returns the cycle path and null for an acyclic graph', () => {
    expect(findCycle({ a: ['b'], b: ['a'] })).toEqual(['a', 'b', 'a'])
    expect(findCycle({ a: ['b'], b: ['c'], c: ['a'] })).toEqual(['a', 'b', 'c', 'a'])
    expect(findCycle({ a: ['b', 'c'], b: ['c'], c: [] })).toBeNull()
  })

  it('layerViolations reports edges to a higher layer only', () => {
    const layers = { low: 0, mid: 1, same: 1, high: 2 }
    expect(layerViolations({ low: ['high'], high: [], mid: [], same: [] }, layers)).toEqual([
      'low -> high',
    ])
    expect(layerViolations({ high: ['low', 'mid'], mid: ['same', 'low'], low: [], same: [] }, layers)).toEqual(
      [],
    )
  })

  it('tooLong fails a 701-line text and passes 700 lines', () => {
    const lines = (n: number) => Array.from({ length: n }, () => 'x').join('\n')
    expect(tooLong(lines(701))).toBe(true)
    expect(tooLong(lines(700))).toBe(false)
    expect(tooLong(`${lines(700)}\n`)).toBe(false)
    expect(tooLong(lines(11), 10)).toBe(true)
  })
})

describe('src/lib/db layout', () => {
  it('holds exactly the 22 expected files', () => {
    const expected = Object.keys(LAYERS)
      .map((name) => `${name}.ts`)
      .sort()
    expect(expected).toHaveLength(22)
    expect(dbFiles()).toEqual(expected)
  })

  it('no db file imports the localDb barrel', () => {
    const offenders: Array<string> = []
    for (const name of dbFiles()) {
      const path = `${DB_DIR}/${name}`
      for (const spec of importsOf(readRepo(path))) {
        if (importsBarrel(path, spec)) offenders.push(`${path}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the sibling import graph has no cycle and no edge to a higher layer', () => {
    const graph: Graph = {}
    for (const name of dbFiles()) {
      const node = name.replace(/\.ts$/, '')
      const path = `${DB_DIR}/${name}`
      const targets = new Set<string>()
      for (const spec of importsOf(readRepo(path))) {
        const resolved = resolveSpec(path, spec)
        if (resolved?.startsWith(`${DB_DIR}/`)) targets.add(resolved.slice(DB_DIR.length + 1))
      }
      graph[node] = [...targets].sort()
    }
    // Positive control: the graph really has edges (handles sits on top of everything).
    expect(Object.values(graph).flat().length).toBeGreaterThan(20)
    expect(graph.personal).toContain('context')
    expect(findCycle(graph)).toBeNull()
    expect(layerViolations(graph, LAYERS)).toEqual([])
  })

  it('every db file has at most 700 lines', () => {
    const files = dbFiles()
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.filter((name) => tooLong(readRepo(`${DB_DIR}/${name}`)))
    expect(offenders).toEqual([])
  })

  it('nothing outside localDb.ts and src/lib/db imports from a lib/db path', () => {
    const scanned: Array<string> = []
    const offenders: Array<string> = []
    for (const entry of readdirSync(`${ROOT}/src`, { recursive: true })) {
      const rel = String(entry).split('\\').join('/')
      if (!/\.tsx?$/.test(rel) || isTestPath(`src/${rel}`)) continue
      const path = `src/${rel}`
      if (path === `${BARREL}.ts` || path.startsWith(`${DB_DIR}/`)) continue
      scanned.push(path)
      for (const spec of importsOf(readRepo(path))) {
        const resolved = resolveSpec(path, spec)
        if (spec.includes('lib/db/') || resolved?.startsWith(`${DB_DIR}/`) || resolved === DB_DIR) {
          offenders.push(`${path}: ${spec}`)
        }
      }
    }
    expect(scanned).toContain('src/lib/spaces/spaceDb.ts')
    expect(scanned.length).toBeGreaterThan(50)
    expect(offenders).toEqual([])
  })
})
