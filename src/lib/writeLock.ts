// Per-storage-key write lock for localDb read-modify-write sections.
//
// Uses the Web Locks API (`navigator.locks`) when available, so writes are
// serialized across tabs too. Otherwise falls back to an in-memory FIFO queue
// per key (same tab only). Multiple keys are always acquired in sorted order
// to avoid deadlocks. The lock is NOT re-entrant: never call another locked
// function for the same key from inside `fn`.

const LOCK_PREFIX = 'minima:'

// Tail of the in-memory queue per key. Each entry resolves when the last
// queued holder has released the key; it never rejects.
const tails = new Map<string, Promise<void>>()

function getLockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as { locks?: LockManager }).locks
  if (!locks || typeof locks.request !== 'function') return null
  return locks
}

async function withMemoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  tails.set(key, tail)
  try {
    await previous
    return await fn()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

async function withSingleLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Checked on every call (not at module load) so tests can install a fake.
  const locks = getLockManager()
  if (locks) {
    return await locks.request(LOCK_PREFIX + key, () => fn())
  }
  return withMemoryLock(key, fn)
}

function acquireInOrder<T>(
  keys: Array<string>,
  index: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (index >= keys.length) return fn()
  return withSingleLock(keys[index], () => acquireInOrder(keys, index + 1, fn))
}

export function withWriteLock<T>(
  keys: string | Array<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const list = typeof keys === 'string' ? [keys] : keys
  const sorted = Array.from(new Set(list)).sort()
  if (sorted.length === 0) return fn()
  return acquireInOrder(sorted, 0, fn)
}
