// No CONTRACT_GAPs: addCategory / updateCategory behaviour (#10) is fully
// specified in the Interface Contract.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addCategory,
  getAllCategories,
  unlockLocalDb,
  updateCategory,
} from '@/lib/localDb'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

describe('localDb categories: trim and uniqueness (#10)', () => {
  beforeEach(async () => {
    mockStore.clear()
    unlockLocalDb(
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    )
  })

  describe('addCategory', () => {
    it('stores the trimmed name', async () => {
      const created = await addCategory({ name: ' Cafe ' })

      expect(created.name).toBe('Cafe')
      const all = await getAllCategories()
      expect(all.map((c) => c.name)).toEqual(['Cafe'])
    })

    it('trims a different name differently (not a hard-coded value)', async () => {
      const a = await addCategory({ name: '  Rent' })
      const b = await addCategory({ name: 'Gym\t' })

      expect(a.name).toBe('Rent')
      expect(b.name).toBe('Gym')
    })

    it('rejects a case-insensitive, whitespace-insensitive duplicate and stores nothing', async () => {
      await addCategory({ name: 'Food' })
      const before = mockStore.get('categories')

      await expect(addCategory({ name: ' food ' })).rejects.toThrow(
        /already exists/,
      )

      expect(await getAllCategories()).toHaveLength(1)
      expect(mockStore.get('categories')).toBe(before)
    })

    it('rejects an empty or whitespace-only name', async () => {
      await expect(addCategory({ name: '   ' })).rejects.toThrow(/required/)
      await expect(addCategory({ name: '' })).rejects.toThrow(/required/)

      expect(await getAllCategories()).toEqual([])
    })

    it('still accepts a genuinely different name', async () => {
      await addCategory({ name: 'Food' })
      await addCategory({ name: 'Foods' })

      expect(await getAllCategories()).toHaveLength(2)
    })
  })

  describe('updateCategory', () => {
    it('rejects renaming to another category name (case-insensitive)', async () => {
      await addCategory({ name: 'Food' })
      const b = await addCategory({ name: 'Transport' })
      const before = mockStore.get('categories')

      await expect(
        updateCategory({ id: b.id, name: 'FOOD' }),
      ).rejects.toThrow(/already exists/)

      expect(mockStore.get('categories')).toBe(before)
      const names = (await getAllCategories()).map((c) => c.name)
      expect(names).toEqual(['Food', 'Transport'])
    })

    it('allows renaming a category to its own name with different case and spacing, storing the trimmed name', async () => {
      const a = await addCategory({ name: 'Food' })

      const updated = await updateCategory({ id: a.id, name: '  fOOD ' })

      expect(updated.name).toBe('fOOD')
      expect((await getAllCategories())[0].name).toBe('fOOD')
    })

    it('rejects an empty name', async () => {
      const a = await addCategory({ name: 'Food' })

      await expect(updateCategory({ id: a.id, name: '  ' })).rejects.toThrow(
        /required/,
      )

      expect((await getAllCategories())[0].name).toBe('Food')
    })

    it('stores a trimmed new name for a unique rename', async () => {
      const a = await addCategory({ name: 'Food' })

      const updated = await updateCategory({ id: a.id, name: ' Groceries ' })

      expect(updated.name).toBe('Groceries')
    })
  })
})
