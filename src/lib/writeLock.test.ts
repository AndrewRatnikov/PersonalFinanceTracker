// No CONTRACT_GAPs: withWriteLock and its test notes are fully specified in the
// Interface Contract.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { withWriteLock } from '@/lib/writeLock'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function flush() {
  return new Promise<void>((r) => setTimeout(r, 0))
}

describe('withWriteLock in-memory fallback (jsdom has no navigator.locks)', () => {
  it('has no navigator.locks in this environment', () => {
    expect('locks' in navigator).toBe(false)
  })

  it('returns the value of fn', async () => {
    await expect(withWriteLock('a', () => Promise.resolve(42))).resolves.toBe(
      42,
    )
    await expect(
      withWriteLock(['a'], () => Promise.resolve('x')),
    ).resolves.toBe('x')
  })

  it('serializes callers on the same key', async () => {
    const events: Array<string> = []
    const gate = deferred()

    const first = withWriteLock('a', async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
    })
    const second = withWriteLock('a', () => {
      events.push('second:start')
      return Promise.resolve()
    })

    await flush()
    expect(events).toEqual(['first:start'])

    gate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs read-modify-write sections without losing updates', async () => {
    let value = 0
    const increment = () =>
      withWriteLock('counter', async () => {
        const read = value
        await flush()
        value = read + 1
      })

    await Promise.all([increment(), increment(), increment(), increment()])

    expect(value).toBe(4)
  })

  it('runs waiting callers in FIFO order', async () => {
    const order: Array<number> = []
    const gate = deferred()
    const calls = [0, 1, 2, 3].map((n) =>
      withWriteLock('a', async () => {
        if (n === 0) await gate.promise
        order.push(n)
      }),
    )
    gate.resolve()
    await Promise.all(calls)

    expect(order).toEqual([0, 1, 2, 3])
  })

  it('does not block different keys', async () => {
    const gate = deferred()
    const blocked = withWriteLock('a', () => gate.promise)

    let ran = false
    await withWriteLock('b', () => {
      ran = true
      return Promise.resolve()
    })

    expect(ran).toBe(true)
    gate.resolve()
    await blocked
  })

  it('propagates a rejection to its caller and does not block later callers', async () => {
    const failing = withWriteLock('a', () => Promise.reject(new Error('boom')))
    const later = withWriteLock('a', () => Promise.resolve('ok'))

    await expect(failing).rejects.toThrow('boom')
    await expect(later).resolves.toBe('ok')
    await expect(
      withWriteLock('a', () => Promise.resolve('again')),
    ).resolves.toBe('again')
  })

  it('a multi-key call waits for every key it needs', async () => {
    const gate = deferred()
    const holdB = withWriteLock('b', () => gate.promise)

    let ran = false
    const both = withWriteLock(['a', 'b'], () => {
      ran = true
      return Promise.resolve()
    })

    await flush()
    expect(ran).toBe(false)

    gate.resolve()
    await Promise.all([holdB, both])
    expect(ran).toBe(true)
  })

  it('does not deadlock when two calls pass the same keys in opposite order', async () => {
    const results = await Promise.all([
      withWriteLock(['a', 'b'], () => Promise.resolve(1)),
      withWriteLock(['b', 'a'], () => Promise.resolve(2)),
      withWriteLock(['b', 'a'], () => Promise.resolve(3)),
    ])

    expect(results).toEqual([1, 2, 3])
  })

  it('treats duplicate keys as one lock (no self-deadlock)', async () => {
    await expect(
      withWriteLock(['a', 'a'], () => Promise.resolve('done')),
    ).resolves.toBe('done')
  })

  it('with an empty key list just runs fn', async () => {
    await expect(withWriteLock([], () => Promise.resolve('free'))).resolves.toBe(
      'free',
    )
  })
})

describe('withWriteLock with navigator.locks', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks')
  })

  function installFake() {
    const names: Array<string> = []
    const request = vi.fn(
      (name: string, callback: () => Promise<unknown>): Promise<unknown> => {
        names.push(name)
        return callback()
      },
    )
    Object.defineProperty(navigator, 'locks', {
      value: { request },
      configurable: true,
    })
    return { names, request }
  }

  it('requests "minima:" + key and returns the result of fn', async () => {
    const { names } = installFake()

    const result = await withWriteLock('income', () => Promise.resolve(7))

    expect(names).toEqual(['minima:income'])
    expect(result).toBe(7)
  })

  it('requests multiple keys in sorted order regardless of input order', async () => {
    const { names } = installFake()

    await withWriteLock(['b', 'a'], () => Promise.resolve())
    expect(names).toEqual(['minima:a', 'minima:b'])

    names.length = 0
    await withWriteLock(['budgets', 'categories'], () => Promise.resolve())
    expect(names).toEqual(['minima:budgets', 'minima:categories'])

    names.length = 0
    await withWriteLock(['expenses_2024_04', 'expenses_2024_03'], () =>
      Promise.resolve(),
    )
    expect(names).toEqual(['minima:expenses_2024_03', 'minima:expenses_2024_04'])
  })

  it('requests a duplicated key only once', async () => {
    const { request } = installFake()

    await withWriteLock(['a', 'a'], () => Promise.resolve())

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('holds the outer lock while the inner one is requested and fn runs', async () => {
    const events: Array<string> = []
    const request = vi.fn(
      async (name: string, callback: () => Promise<unknown>) => {
        events.push(`acquire:${name}`)
        try {
          return await callback()
        } finally {
          events.push(`release:${name}`)
        }
      },
    )
    Object.defineProperty(navigator, 'locks', {
      value: { request },
      configurable: true,
    })

    await withWriteLock(['b', 'a'], () => {
      events.push('fn')
      return Promise.resolve()
    })

    expect(events).toEqual([
      'acquire:minima:a',
      'acquire:minima:b',
      'fn',
      'release:minima:b',
      'release:minima:a',
    ])
  })

  it('propagates a rejection of fn unchanged', async () => {
    installFake()
    const err = new Error('nope')

    await expect(
      withWriteLock('a', () => Promise.reject(err)),
    ).rejects.toBe(err)
  })

  it('checks for navigator.locks on every call, not at import time', async () => {
    await withWriteLock('a', () => Promise.resolve())
    const { request } = installFake()

    await withWriteLock('a', () => Promise.resolve())

    expect(request).toHaveBeenCalledTimes(1)
  })
})
