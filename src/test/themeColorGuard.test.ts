// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const srcDir = join(process.cwd(), 'src')
const needle = 'hsl(var(--'

function walk(dir: string): Array<string> {
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = walk(srcDir).map((f) => relative(process.cwd(), f).split(sep).join('/'))

describe('theme colour guard', () => {
  it('actually scans src (non-vacuous)', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain('src/components/index/DashboardStats.tsx')
  })

  it('excludes test files from the scan', () => {
    expect(files.filter((f) => f.includes('.test.'))).toEqual([])
  })

  it('has no hsl(var(--token)) wrapper in any non-test .ts/.tsx file', () => {
    const offenders = files.filter((f) =>
      readFileSync(join(process.cwd(), f), 'utf8').includes(needle),
    )
    expect(offenders).toEqual([])
  })
})
