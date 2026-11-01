// @vitest-environment node
// No CONTRACT_GAPs: the guard scope (src/components/analytics/** and
// src/components/index/DashboardStats.tsx) and the CategoryDonutChart.tsx
// exemption (decision D4) come from the plan. Mirrors themeColorGuard.test.ts.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const HEX = /#(?:[0-9a-fA-F]{3}){1,2}\b/
const PRIMARY = 'var(--primary)'

// The category palette identifies categories (not the accent colour), so it is
// the one declared exemption in analytics/. MemberBreakdown takes its colours
// from the data and has no literal in the source.
const EXEMPT = ['src/components/analytics/CategoryDonutChart.tsx']

function findChartColourViolations(source: string): Array<string> {
  const found: Array<string> = []
  const hex = source.match(new RegExp(HEX.source, 'g'))
  if (hex) found.push(...hex)
  if (source.includes(PRIMARY)) found.push(PRIMARY)
  return found
}

const root = process.cwd()
const analyticsDir = join(root, 'src', 'components', 'analytics')

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

const files = [
  ...walk(analyticsDir),
  join(root, 'src', 'components', 'index', 'DashboardStats.tsx'),
].map((f) => relative(root, f).split(sep).join('/'))

const scanned = files.filter((f) => !EXEMPT.includes(f))

describe('findChartColourViolations', () => {
  it('flags a six-digit hex fill', () => {
    expect(findChartColourViolations('<Bar fill="#123456" />')).toEqual(['#123456'])
  })

  it('flags a three-digit hex fill', () => {
    expect(findChartColourViolations('<Bar fill="#abc" />')).toEqual(['#abc'])
  })

  it('flags var(--primary) used as a fill', () => {
    expect(findChartColourViolations('<Bar fill="var(--primary)" />')).toEqual([
      'var(--primary)',
    ])
  })

  it('flags var(--primary) in a style object', () => {
    expect(
      findChartColourViolations("itemStyle={{ color: 'var(--primary)' }}").length,
    ).toBe(1)
  })

  it('passes the shared tokens', () => {
    expect(findChartColourViolations('<Bar fill="var(--chart-accent)" />')).toEqual([])
    expect(findChartColourViolations("fill={x ? 'var(--chart-negative)' : 'var(--chart-positive)'}")).toEqual([])
  })

  it('passes other muted tokens and an anchor-like # without hex digits', () => {
    expect(findChartColourViolations('stroke="var(--muted-foreground)"')).toEqual([])
    expect(findChartColourViolations('href="#main-content"')).toEqual([])
  })
})

describe('chart colour guard', () => {
  it('actually scans the chart components (non-vacuous)', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(3)
    expect(scanned).toContain('src/components/index/DashboardStats.tsx')
    expect(scanned).toContain('src/components/analytics/TimelineBarChart.tsx')
    expect(scanned).toContain('src/components/analytics/BudgetVarianceBarChart.tsx')
  })

  it('excludes test files and the declared exemption from the scan', () => {
    expect(scanned.filter((f) => f.includes('.test.'))).toEqual([])
    expect(scanned).not.toContain('src/components/analytics/CategoryDonutChart.tsx')
    expect(files).toContain('src/components/analytics/CategoryDonutChart.tsx')
  })

  it('the exempt palette really contains hex literals (so the exemption is needed)', () => {
    const donut = readFileSync(join(root, EXEMPT[0]), 'utf8')
    expect(findChartColourViolations(donut).length).toBeGreaterThan(0)
  })

  it.each(scanned)('%s has no hex literal and no var(--primary)', (file) => {
    const source = readFileSync(join(root, file), 'utf8')
    expect(findChartColourViolations(source)).toEqual([])
  })
})
