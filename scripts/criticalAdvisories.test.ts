// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface LockEntry {
  version?: string
}

type Packages = Record<string, LockEntry>

interface Floor {
  name: string
  min: string
  advisories: string
}

const floors: Array<Floor> = [
  { name: 'proxy-addr', min: '2.0.8', advisories: 'GHSA-jqcg-44mw-7w3h' },
  { name: 'shell-quote', min: '1.11.0', advisories: 'GHSA-pqg4-j6r4-53mv' },
  {
    name: 'seroval',
    min: '1.6.3',
    advisories: 'GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp',
  },
  {
    name: 'seroval-plugins',
    min: '1.6.3',
    advisories: 'GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp',
  },
  {
    name: 'solid-js',
    min: '1.9.16',
    advisories:
      'critical via seroval: GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp',
  },
]

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

const lock = JSON.parse(
  readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'),
) as { lockfileVersion: number; packages: Packages }

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('returns 1 when greater and -1 when lesser', () => {
    expect(compareVersions('2.0.8', '2.0.7')).toBe(1)
    expect(compareVersions('2.0.7', '2.0.8')).toBe(-1)
  })

  it('treats missing segments as 0', () => {
    expect(compareVersions('1.9', '1.9.0')).toBe(0)
    expect(compareVersions('1.9.1', '1.9')).toBe(1)
    expect(compareVersions('1.9', '1.9.1')).toBe(-1)
  })

  it('compares segments numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('2.0.10', '2.0.8')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })
})

describe('findBelowFloor', () => {
  const seroval = floors.find((f) => f.name === 'seroval')!

  it('flags a version below the floor, naming key, version, floor and advisories', () => {
    const result = findBelowFloor(
      { 'node_modules/seroval': { version: '1.5.6' } },
      seroval,
    )
    expect(result).toEqual([
      'node_modules/seroval@1.5.6 is below 1.6.3 (GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp)',
    ])
  })

  it('accepts a version at or above the floor', () => {
    expect(
      findBelowFloor({ 'node_modules/seroval': { version: '1.6.3' } }, seroval),
    ).toEqual([])
    expect(
      findBelowFloor(
        { 'node_modules/seroval': { version: '1.10.0' } },
        seroval,
      ),
    ).toEqual([])
  })

  it('checks nested copies', () => {
    const result = findBelowFloor(
      {
        'node_modules/seroval': { version: '1.6.9' },
        'node_modules/solid-js/node_modules/seroval': { version: '1.5.6' },
      },
      seroval,
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('node_modules/solid-js/node_modules/seroval@1.5.6')
  })

  it('does not match seroval-plugins or scoped lookalikes for seroval', () => {
    expect(
      findBelowFloor(
        {
          'node_modules/seroval-plugins': { version: '0.0.1' },
          'node_modules/@x/seroval': { version: '0.0.1' },
        },
        seroval,
      ),
    ).toEqual(['node_modules/@x/seroval@0.0.1 is below 1.6.3 (GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp)'])
  })

  it('fails an entry without a version', () => {
    const result = findBelowFloor({ 'node_modules/seroval': {} }, seroval)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('node_modules/seroval')
    expect(result[0]).toContain('GHSA-p6vx-979v-rg4c')
  })

  it('passes when the package is absent', () => {
    expect(
      findBelowFloor({ 'node_modules/other': { version: '0.0.1' } }, seroval),
    ).toEqual([])
  })
})

describe('package-lock.json critical advisory floors', () => {
  it('is lockfileVersion 3 and has packages', () => {
    expect(lock.lockfileVersion).toBe(3)
    expect(lock.packages['node_modules/proxy-addr']).toBeDefined()
  })

  it.each(floors)(
    '$name is at or above $min in every lockfile entry',
    (floor) => {
      expect(findBelowFloor(lock.packages, floor)).toEqual([])
    },
  )

  it('has no nested seroval copies under solid-js', () => {
    const nested = Object.keys(lock.packages).filter((k) =>
      /node_modules\/solid-js\/node_modules\/seroval(-plugins)?$/.test(k),
    )
    expect(nested).toEqual([])
  })
})
