// Shared by vite.config.ts (constants) and scripts/precacheCheck.test.ts (build-output check).
// Keep this module dependency-free: no node: imports, so the Vite config can load it as-is.

/** Directory (relative to the repo root) that Nitro's vercel preset serves statically. VitePWA globs it. */
export const STATIC_OUTPUT_DIR = '.vercel/output/static'

/** URL of the prerendered app shell that the SW serves when a navigation fails. */
export const APP_SHELL_URL = '/_shell.html'

const normalise = (url: string): string => url.replace(/^\.?\//, '')

/**
 * Returns every `url` in the first `precacheAndRoute([...])` call of a generated
 * service worker, in source order, with a leading `/` or `./` stripped.
 * Only a property named exactly `url` counts (quoted or not), so keys such as
 * `fallbackURL` are ignored. Throws if the source has no `precacheAndRoute(` call.
 */
export function parsePrecacheUrls(swSource: string): Array<string> {
  const call = 'precacheAndRoute('
  const start = swSource.indexOf(call)
  if (start === -1) {
    throw new Error('No precacheAndRoute( call found in service worker source')
  }
  const rest = swSource.slice(start + call.length)
  const end = rest.indexOf(']')
  const manifest = end === -1 ? rest : rest.slice(0, end)

  const urls: Array<string> = []
  const urlProp = /[{,]\s*(["']?)url\1\s*:\s*(["'])(.*?)\2/g
  for (const match of manifest.matchAll(urlProp)) {
    urls.push(normalise(match[3]))
  }
  return urls
}

/**
 * Returns the entries of `files` that are not in `precacheUrls` (a leading `/`
 * or `./` is ignored on both sides). Keeps the input spelling, sorted and
 * deduplicated; `[]` when nothing is missing.
 */
export function findMissingFromPrecache(
  files: ReadonlyArray<string>,
  precacheUrls: ReadonlyArray<string>,
): Array<string> {
  const precached = new Set(precacheUrls.map(normalise))
  const missing = new Set(files.filter((f) => !precached.has(normalise(f))))
  return Array.from(missing).sort()
}
