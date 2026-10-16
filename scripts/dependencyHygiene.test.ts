// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface LockEntry {
  version?: string
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type Packages = Record<string, LockEntry>

interface Floor {
  name: string
  min: string
  advisories: string
}

const floors: Array<Floor> = [
  {
    name: '@modelcontextprotocol/sdk',
    min: '1.31.0',
    advisories: 'GHSA-6qxp-vccf-f47h',
  },
  { name: 'source-map-js', min: '1.2.2', advisories: 'GHSA-68fv-2mgg-jv7q' },
]

const sdkFloor = floors[0]
const sourceMapFloor = floors[1]

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

function findBelowFloor(packages: Packages, floor: Floor): Array<string> {
  const failures: Array<string> = []
  for (const key of Object.keys(packages)) {
    if (!key.endsWith('node_modules/' + floor.name)) continue
    const version = packages[key].version
    const suffix = `is below ${floor.min} (${floor.advisories})`
    if (version === undefined) {
      failures.push(`${key}@(no version) ${suffix}`)
    } else if (compareVersions(version, floor.min) < 0) {
      failures.push(`${key}@${version} ${suffix}`)
    }
  }
  return failures
}

const pkg = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const lock = JSON.parse(
  readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'),
) as { lockfileVersion: number; packages: Packages }

describe('findBelowFloor (inline copy)', () => {
  it('flags a version below the floor, naming key, version and advisory', () => {
    expect(
      findBelowFloor(
        { 'node_modules/source-map-js': { version: '1.2.1' } },
        sourceMapFloor,
      ),
    ).toEqual([
      'node_modules/source-map-js@1.2.1 is below 1.2.2 (GHSA-68fv-2mgg-jv7q)',
    ])
  })

  it('accepts versions at or above the floor', () => {
    expect(
      findBelowFloor(
        { 'node_modules/source-map-js': { version: '1.2.2' } },
        sourceMapFloor,
      ),
    ).toEqual([])
    expect(
      findBelowFloor(
        { 'node_modules/source-map-js': { version: '1.10.0' } },
        sourceMapFloor,
      ),
    ).toEqual([])
  })

  it('flags nested copies but not lookalikes', () => {
    const result = findBelowFloor(
      {
        'node_modules/source-map-js': { version: '1.2.2' },
        'node_modules/foo/node_modules/source-map-js': { version: '1.2.1' },
        'node_modules/source-map-js-foo': { version: '0.0.1' },
        'node_modules/@x/source-map-js': { version: '0.0.1' },
      },
      sourceMapFloor,
    )
    expect(result).toEqual([
      'node_modules/foo/node_modules/source-map-js@1.2.1 is below 1.2.2 (GHSA-68fv-2mgg-jv7q)',
    ])
  })

  it('matches the scoped sdk key and compares against its floor', () => {
    expect(
      findBelowFloor(
        { 'node_modules/@modelcontextprotocol/sdk': { version: '1.29.0' } },
        sdkFloor,
      ),
    ).toEqual([
      'node_modules/@modelcontextprotocol/sdk@1.29.0 is below 1.31.0 (GHSA-6qxp-vccf-f47h)',
    ])
    expect(
      findBelowFloor(
        { 'node_modules/@modelcontextprotocol/sdk': { version: '1.31.0' } },
        sdkFloor,
      ),
    ).toEqual([])
  })

  it('fails an entry without a version', () => {
    const result = findBelowFloor(
      { 'node_modules/source-map-js': {} },
      sourceMapFloor,
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('node_modules/source-map-js')
    expect(result[0]).toContain('GHSA-68fv-2mgg-jv7q')
  })

  it('passes when the package is absent', () => {
    expect(
      findBelowFloor({ 'node_modules/other': { version: '0.0.1' } }, sdkFloor),
    ).toEqual([])
  })
})

describe('package-lock.json advisory floors', () => {
  it('is lockfileVersion 3', () => {
    expect(lock.lockfileVersion).toBe(3)
  })

  it.each(floors)(
    '$name is at or above $min in every lockfile entry',
    (floor) => {
      expect(findBelowFloor(lock.packages, floor)).toEqual([])
    },
  )
})

describe('web-vitals removal', () => {
  it('is not in package.json dependencies or devDependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('web-vitals')
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('web-vitals')
  })

  it('is not in the lockfile root entry', () => {
    const root = lock.packages['']
    expect(Object.keys(root.dependencies ?? {})).not.toContain('web-vitals')
    expect(Object.keys(root.devDependencies ?? {})).not.toContain('web-vitals')
  })
})

describe('nitro nightly pin', () => {
  const spec = pkg.devDependencies?.nitro
  const match = /^npm:nitro-nightly@(\d[^\s^~]*)$/.exec(spec ?? '')

  it('is an exact npm:nitro-nightly version without ^ or ~', () => {
    expect(spec).toBeDefined()
    expect(match).not.toBeNull()
  })

  it('equals the version locked at node_modules/nitro', () => {
    expect(match?.[1]).toBeDefined()
    expect(lock.packages['node_modules/nitro'].version).toBe(match?.[1])
  })
})
