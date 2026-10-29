// The in-memory keyring: the AES-GCM keys of every Family space this device
// holds, imported from the personal `spaceKeys` record. Memory only, like the
// DEK; localDb clears it on lock (wipeLocalDbKey) and reloads it through the
// registered loader when it is not loaded or marked stale. This module never
// imports localDb (many tests mock localDb partially).

import type { SpaceRole } from './types'

export interface HeldSpace {
  id: string
  name: string
  role: SpaceRole
  keyVersion: number
  /** Newest version first. */
  keys: Array<{ keyVersion: number; key: CryptoKey }>
}

let held = new Map<string, HeldSpace>()
let loaded = false
let stale = false
let loader: (() => Promise<void>) | null = null

export function setKeyring(spaces: Array<HeldSpace>): void {
  held = new Map(spaces.map((s) => [s.id, s]))
  loaded = true
  stale = false
}

export function clearKeyring(): void {
  held = new Map()
  loaded = false
  stale = false
}

let version = 0

export function markKeyringStale(): void {
  stale = true
  version++
}

// Bumped by every markKeyringStale: a load that started before a bump must
// not clear the staleness it did not see.
export function keyringVersion(): number {
  return version
}

export function isKeyringLoaded(): boolean {
  return loaded
}

// True when the next Family access must (re)load the keyring.
export function keyringNeedsLoad(): boolean {
  return !loaded || stale
}

// The Family space ids held, sorted.
export function heldSpaceIds(): Array<string> {
  return Array.from(held.keys()).sort()
}

export function getHeldSpace(spaceId: string): HeldSpace | undefined {
  return held.get(spaceId)
}

export function isSpaceHeld(spaceId: string): boolean {
  return held.has(spaceId)
}

export function setKeyringLoader(next: (() => Promise<void>) | null): void {
  loader = next
}

// The held Family space ids, loading the keyring first when needed and a
// loader is registered (none when localDb is mocked: then the ids held now).
export async function listHeldSpaceIds(): Promise<Array<string>> {
  if (keyringNeedsLoad() && loader) await loader()
  return heldSpaceIds()
}
