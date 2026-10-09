// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APP_SHELL_URL,
  STATIC_OUTPUT_DIR,
  findMissingFromPrecache,
  parsePrecacheUrls,
} from './precacheCheck'

const MINIFIED_SW =
  'define(["./workbox-4db61445"],function(s){"use strict";self.skipWaiting(),s.clientsClaim(),s.precacheAndRoute([{url:"manifest.json",revision:"93b2"},{url:"assets/index-Dlx3zX7b.js",revision:null},{url:"/_shell.html",revision:"muzvyuu1"}],{}),s.cleanupOutdatedCaches(),s.registerRoute(({request:s})=>"navigate"===s.mode,new s.NetworkOnly({plugins:[new s.PrecacheFallbackPlugin({fallbackURL:"/_shell.html"})]}),"GET")});'

describe('constants', () => {
  it('exposes the static output dir and shell url', () => {
    expect(STATIC_OUTPUT_DIR).toBe('.vercel/output/static')
    expect(APP_SHELL_URL).toBe('/_shell.html')
  })
})

describe('parsePrecacheUrls', () => {
  it('returns urls in source order with leading slash stripped', () => {
    expect(parsePrecacheUrls(MINIFIED_SW)).toEqual([
      'manifest.json',
      'assets/index-Dlx3zX7b.js',
      '_shell.html',
    ])
  })

  it('does not return fallbackURL values', () => {
    const urls = parsePrecacheUrls(MINIFIED_SW)
    expect(urls).toHaveLength(3)
    // fallbackURL is "/_shell.html"; the shell appears once (from the url entry) only
    expect(urls.filter((u) => u === '_shell.html')).toHaveLength(1)
  })

  it('ignores a fallbackURL even when it is the only match-looking key', () => {
    const src =
      's.precacheAndRoute([{url:"a.js",revision:null}],{}),new s.PrecacheFallbackPlugin({fallbackURL:"/zzz.html"})'
    expect(parsePrecacheUrls(src)).toEqual(['a.js'])
  })

  it('supports quoted "url" keys and single-quoted values', () => {
    const src = `precacheAndRoute([{ "url": "./assets/a.css", "revision": null }, { 'url': './b.woff2' }])`
    expect(parsePrecacheUrls(src)).toEqual(['assets/a.css', 'b.woff2'])
  })

  it('returns an empty array for an empty manifest', () => {
    expect(parsePrecacheUrls('s.precacheAndRoute([],{})')).toEqual([])
  })

  it('throws mentioning precacheAndRoute when the call is absent', () => {
    expect(() => parsePrecacheUrls('console.log("no sw here")')).toThrow(
      /precacheAndRoute/,
    )
  })

  it('does not read urls after the closing bracket of the array', () => {
    const src =
      's.precacheAndRoute([{url:"a.js",revision:null}],{}),s.other([{url:"later.js"}])'
    expect(parsePrecacheUrls(src)).toEqual(['a.js'])
  })
})

describe('findMissingFromPrecache', () => {
  it('returns [] when everything is precached', () => {
    expect(
      findMissingFromPrecache(['assets/a.js', 'assets/b.js'], ['assets/b.js', 'assets/a.js']),
    ).toEqual([])
  })

  it('returns missing files sorted and deduplicated', () => {
    expect(
      findMissingFromPrecache(
        ['assets/z.js', 'assets/a.js', 'assets/z.js', 'assets/m.js'],
        ['assets/m.js'],
      ),
    ).toEqual(['assets/a.js', 'assets/z.js'])
  })

  it('ignores a leading slash on either side', () => {
    expect(findMissingFromPrecache(['/assets/a.js'], ['assets/a.js'])).toEqual([])
    expect(findMissingFromPrecache(['assets/a.js'], ['/assets/a.js'])).toEqual([])
    expect(findMissingFromPrecache(['./assets/a.js'], ['assets/a.js'])).toEqual([])
  })

  it('keeps the input spelling of missing entries', () => {
    expect(findMissingFromPrecache(['/assets/x.js'], ['assets/y.js'])).toEqual([
      '/assets/x.js',
    ])
  })

  it('returns everything when the precache is empty', () => {
    expect(findMissingFromPrecache(['b.js', 'a.js'], [])).toEqual(['a.js', 'b.js'])
  })
})

function walk(dir: string): Array<string> {
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe.runIf(process.env.PRECACHE_BUILD_CHECK === '1')(
  'build output (run npm run test:precache)',
  () => {
    const root = process.cwd()
    const staticDir = join(root, STATIC_OUTPUT_DIR)
    const swPath = join(staticDir, 'sw.js')

    const readSw = () => readFileSync(swPath, 'utf8')
    const assetFiles = () =>
      readdirSync(join(staticDir, 'assets'))
        .filter((f) => ['.js', '.css', '.woff', '.woff2'].includes(extname(f)))
        .map((f) => `assets/${f}`)

    it('has sw.js and its workbox runtime', () => {
      expect(existsSync(swPath), 'sw.js missing').toBe(true)
      const match = /workbox-[0-9a-f]+/.exec(readSw())
      expect(match, 'no workbox-<hash> reference in sw.js').not.toBeNull()
      const runtime = join(staticDir, `${match?.[0] ?? ''}.js`)
      expect(existsSync(runtime), `${runtime} missing`).toBe(true)
    })

    it('precaches every built asset (js, css, fonts)', () => {
      const files = assetFiles()
      expect(files.length).toBeGreaterThan(0)
      const missing = findMissingFromPrecache(files, parsePrecacheUrls(readSw()))
      expect(missing, `not precached: ${missing.join(', ')}`).toEqual([])
    })

    it('precaches the app shell, manifest and manifest icons', () => {
      const urls = parsePrecacheUrls(readSw())
      expect(urls).toContain('_shell.html')
      expect(urls).toContain('manifest.json')
      const manifest = JSON.parse(
        readFileSync(join(root, 'public/manifest.json'), 'utf8'),
      ) as { icons: Array<{ src: string }> }
      const missing = findMissingFromPrecache(
        manifest.icons.map((i) => i.src),
        urls,
      )
      expect(missing, `icons not precached: ${missing.join(', ')}`).toEqual([])
    })

    it('does not precache sw.js or workbox runtime files', () => {
      const urls = parsePrecacheUrls(readSw())
      expect(urls).not.toContain('sw.js')
      expect(urls.filter((u) => /^workbox-.*\.js$/.test(u))).toEqual([])
    })

    it('has a shell that boots the client and whose assets are precached', () => {
      const shellPath = join(staticDir, '_shell.html')
      expect(existsSync(shellPath), '_shell.html missing').toBe(true)
      const html = readFileSync(shellPath, 'utf8')
      expect(html).toContain('<script type="module"')
      const refs = Array.from(
        html.matchAll(/["'](\/assets\/[^"'\s?#]+)["']/g),
        (m) => m[1],
      )
      expect(refs.length).toBeGreaterThan(0)
      const urls = parsePrecacheUrls(readSw())
      const missing = findMissingFromPrecache(refs, urls)
      expect(missing, `shell assets not precached: ${missing.join(', ')}`).toEqual([])
      const absent = refs.filter((r) => !existsSync(join(staticDir, r)))
      expect(absent, `shell assets missing on disk: ${absent.join(', ')}`).toEqual([])
    })

    it('serves navigations NetworkOnly with the shell as fallback', () => {
      const sw = readSw()
      expect(sw).toContain('PrecacheFallbackPlugin')
      expect(sw).toContain('NetworkOnly')
      expect(sw).toMatch(/fallbackURL:\s*["']\/_shell\.html["']/)
    })

    it('has no expiry and no NetworkFirst', () => {
      const sw = readSw()
      expect(sw).not.toContain('maxAgeSeconds')
      expect(sw).not.toContain('ExpirationPlugin')
      expect(sw).not.toContain('NetworkFirst')
    })

    it('has no static index.html that would shadow SSR', () => {
      const indexFiles = walk(staticDir).filter(
        (f) => f.split(/[\\/]/).pop() === 'index.html',
      )
      expect(indexFiles).toEqual([])
    })
  },
)
