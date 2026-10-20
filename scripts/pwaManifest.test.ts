// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: string
}

interface ManifestShortcut {
  name: string
  short_name?: string
  url: string
  icons?: Array<{ src: string; sizes: string }>
}

const publicDir = join(process.cwd(), 'public')

const manifest = JSON.parse(
  readFileSync(join(publicDir, 'manifest.json'), 'utf8'),
) as { icons: Array<ManifestIcon>; shortcuts?: Array<ManifestShortcut> }

const purposes = (icon: ManifestIcon) => (icon.purpose ?? 'any').split(/\s+/)

describe('manifest icons', () => {
  it('has no combined "any maskable" purpose', () => {
    for (const icon of manifest.icons) {
      const p = purposes(icon)
      expect(p.includes('any') && p.includes('maskable'), icon.src).toBe(false)
    }
  })

  it.each(['192x192', '512x512'])(
    'has exactly one any and one maskable entry at %s',
    (size) => {
      const atSize = manifest.icons.filter((i) => i.sizes === size)
      expect(atSize.filter((i) => i.purpose === 'any')).toHaveLength(1)
      expect(atSize.filter((i) => i.purpose === 'maskable')).toHaveLength(1)
    },
  )

  it('points maskable entries at the padded files', () => {
    const maskable = (size: string) =>
      manifest.icons.find((i) => i.sizes === size && i.purpose === 'maskable')
    expect(maskable('192x192')?.src).toBe('logo192-maskable.png')
    expect(maskable('512x512')?.src).toBe('logo512-maskable.png')
  })

  it('keeps the any entries on the original logos', () => {
    const any = (size: string) =>
      manifest.icons.find((i) => i.sizes === size && i.purpose === 'any')
    expect(any('192x192')?.src).toBe('logo192.png')
    expect(any('512x512')?.src).toBe('logo512.png')
  })

  it('has every icon src present in public/', () => {
    for (const icon of manifest.icons) {
      expect(existsSync(join(publicDir, icon.src)), icon.src).toBe(true)
    }
  })
})

describe('manifest shortcuts', () => {
  it('has exactly the "Add expense" shortcut', () => {
    expect(manifest.shortcuts).toEqual([
      {
        name: 'Add expense',
        short_name: 'Add',
        url: '/transactions?add=expense',
        icons: [{ src: 'logo192.png', sizes: '192x192' }],
      },
    ])
  })

  it('opens the Transactions page with the add drawer', () => {
    const shortcut = manifest.shortcuts?.[0]
    expect(shortcut).toBeDefined()
    const url = new URL(shortcut?.url ?? '', 'https://example.test')
    expect(url.pathname).toBe('/transactions')
    expect(url.searchParams.get('add')).toBe('expense')
  })

  it('uses an icon that exists, is one of the manifest icons (so it is precached)', () => {
    const shortcutIcon = manifest.shortcuts?.[0].icons?.[0]
    expect(shortcutIcon?.src).toBe('logo192.png')
    expect(existsSync(join(publicDir, 'logo192.png'))).toBe(true)
    expect(manifest.icons.map((i) => i.src)).toContain('logo192.png')
  })
})

describe.each([192, 512])('logo%i-maskable.png', (size) => {
  const bytes = readFileSync(join(publicDir, `logo${size}-maskable.png`))

  it('is a PNG', () => {
    expect(
      Array.from(bytes.subarray(0, 8)),
    ).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('has the expected square dimensions', () => {
    expect(bytes.readUInt32BE(16)).toBe(size)
    expect(bytes.readUInt32BE(20)).toBe(size)
  })

  it('is opaque RGB (colour type 2)', () => {
    expect(bytes[25]).toBe(2)
  })
})
