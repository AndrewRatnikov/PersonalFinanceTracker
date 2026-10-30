// Test helper (no CONTRACT_GAPs): users O / B / C / D / X and their devices on
// the Family PGlite harness (familyHarness.ts) and the simulated devices of
// simDevice.ts built with `family: true`.
//
// Every test file that uses this helper installs
//   vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
// and a `@/lib/accountSession` mock whose getAccountSession reads the acting
// user from globalThis (see `setActing` / `ACTING_KEY`), because
// getCurrentMemberId() dynamic-imports accountSession and the module registry
// is reset for every simulated device. `act(device, fn)` switches the acting
// user to the device's user for the duration of one operation.

import { expect } from 'vitest'

import type { FamilyUser } from '@/test/sql/familyHarness'
import type { SqlTestDb } from '@/test/sql/harness'
import type { SimDevice } from '@/test/sync/simDevice'
import type { PendingInvite } from '@/lib/spaces/pendingInvite'
import { familyUser } from '@/test/sql/familyHarness'
import { cloudVaultOf, createSimDevice } from '@/test/sync/simDevice'
import { parseInviteFragment } from '@/lib/spaces/invite'

export const FAMILY_PASSWORD = 'family sim password'
export const ACTING_KEY = '__minimaActingUser'

export function setActing(userId: string | null): void {
  ;(globalThis as Record<string, unknown>)[ACTING_KEY] = userId
}

export function actingUser(): string | null {
  const value = (globalThis as Record<string, unknown>)[ACTING_KEY]
  return typeof value === 'string' ? value : null
}

// Runs `fn` as the user of `device` (the account session mock answers with it).
export async function act<T>(device: SimDevice, fn: () => Promise<T>): Promise<T> {
  setActing(device.state.userId)
  return fn()
}

// A user with no pre-registered device: personal sync registers the devices.
export function newUser(ctx: SqlTestDb): Promise<FamilyUser> {
  return familyUser(ctx, { device: false })
}

// A first device: new vault, personal sync on, ready for Family actions.
export async function firstDevice(user: FamilyUser, name: string): Promise<SimDevice> {
  const device = await createSimDevice({ name, rpc: user.rpc, userId: user.userId, family: true })
  await act(device, async () => {
    await device.createAndUnlockVault(FAMILY_PASSWORD)
    await device.actions.turnOn()
  })
  return device
}

// A second device of the same user, restored from the cloud vault.
export async function nextDevice(user: FamilyUser, name: string): Promise<SimDevice> {
  const device = await createSimDevice({ name, rpc: user.rpc, userId: user.userId, family: true })
  await act(device, async () => {
    const cloud = await cloudVaultOf(device)
    await device.actions.restoreFromCloud(cloud, { password: FAMILY_PASSWORD })
  })
  return device
}

// One full engine cycle (personal stream, then the Family stream).
export async function cycle(device: SimDevice) {
  return act(device, () => device.engine.runCycle({ reason: 'manual' }))
}

// Every device runs `rounds` cycles in turn, so pushes reach everyone.
export async function settle(devices: Array<SimDevice>, rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of devices) await cycle(d)
  }
}

export function userIdOf(device: SimDevice): string {
  const id = device.state.userId
  if (id === null) throw new Error(`${device.name} is signed out`)
  return id
}

export function familyActionsOf(device: SimDevice) {
  if (!device.familyActions) throw new Error(`${device.name} was built without family: true`)
  return device.familyActions
}

export function spacesOf(device: SimDevice) {
  if (!device.spaces) throw new Error(`${device.name} was built without family: true`)
  return device.spaces
}

export function familyOf(device: SimDevice) {
  if (!device.family) throw new Error(`${device.name} was built without family: true`)
  return device.family
}

// The owner creates a Family on `owner` and runs the first cycle. Returns its id.
export async function createFamilyOn(owner: SimDevice, name = 'Home'): Promise<string> {
  const result = await act(owner, () => familyActionsOf(owner).createFamily({ name }))
  if (result.kind !== 'created') throw new Error('createFamily did not create')
  await cycle(owner)
  return result.spaceId
}

export interface JoinRequested {
  invite: PendingInvite
  url: string
  safetyCode: string
}

// The joiner opens the owner's link and asks to join (no approval yet).
export async function requestJoinOn(owner: SimDevice, joiner: SimDevice): Promise<JoinRequested> {
  const created = await act(owner, () => familyActionsOf(owner).createInvite())
  const parsed = parseInviteFragment(new URL(created.url).hash)
  if (!parsed) throw new Error('the invite link did not parse')
  const info = await act(joiner, () => familyActionsOf(joiner).previewInvite(parsed))
  const request = await act(joiner, () => familyActionsOf(joiner).requestJoin(parsed, info.owner_email))
  return { invite: parsed, url: created.url, safetyCode: request.safetyCode }
}

// The owner sees the request, approves it, and the joiner's next cycle joins.
export async function approveOn(owner: SimDevice, joiner: SimDevice): Promise<void> {
  await cycle(owner)
  await act(owner, () => familyActionsOf(owner).approveMember(userIdOf(joiner)))
  await cycle(joiner)
}

export async function joinFamily(owner: SimDevice, joiner: SimDevice): Promise<JoinRequested> {
  const requested = await requestJoinOn(owner, joiner)
  await approveOn(owner, joiner)
  return requested
}

export async function familyExpense(
  device: SimDevice,
  spaceId: string,
  amount: number,
  description: string,
  createdAt = '2026-10-20T12:00:00.000Z',
) {
  return act(device, async () => {
    const db = device.localDb.spaceDb(spaceId)
    const [category] = await db.getAllCategories()
    return db.addExpense({ amount, currency: 'UAH', categoryId: category.id, description, createdAt })
  })
}

export async function familyExpenses(device: SimDevice, spaceId: string) {
  return act(device, () => device.localDb.spaceDb(spaceId).getAllExpenses())
}

export interface ServerRow {
  record_key: string
  key_version: number
  ciphertext: string
  iv: string
  author_id: string
}

export async function serverRows(ctx: SqlTestDb, spaceId: string): Promise<Array<ServerRow>> {
  return ctx.admin<ServerRow>(
    'select record_key, key_version, ciphertext, iv, author_id::text as author_id from public.space_records where space_id = $1 order by seq',
    [spaceId],
  )
}

// Every rpc call (name and arguments, as JSON) the devices made.
export function callsJson(devices: Array<SimDevice>): string {
  return JSON.stringify(devices.flatMap((d) => d.calls))
}

export function expectNoSecret(devices: Array<SimDevice>, secret: Uint8Array): void {
  const text = callsJson(devices)
  const b64url = Buffer.from(secret).toString('base64url')
  const b64 = Buffer.from(secret).toString('base64')
  expect(text.includes(b64url)).toBe(false)
  expect(text.includes(b64)).toBe(false)
}
