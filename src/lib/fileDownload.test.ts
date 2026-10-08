// No CONTRACT_GAPs: saveFile, SaveResult and OBJECT_URL_REVOKE_DELAY_MS are
// fully specified in the Interface Contract (module: fileDownload).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OBJECT_URL_REVOKE_DELAY_MS, saveFile } from '@/lib/fileDownload'

const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake-url')
const revokeObjectURL = vi.fn((_url: string) => {})

let clicked: Array<{ href: string; download: string; inBody: boolean }> = []

function stubNavigator(name: 'share' | 'canShare', value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value })
}

beforeEach(() => {
  vi.useFakeTimers()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  createObjectURL.mockImplementation(() => 'blob:fake-url')
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      clicked.push({
        href: this.href,
        download: this.download,
        inBody: document.body.contains(this),
      })
    },
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'share')
  Reflect.deleteProperty(navigator, 'canShare')
})

describe('OBJECT_URL_REVOKE_DELAY_MS', () => {
  it('is 10 seconds', () => {
    expect(OBJECT_URL_REVOKE_DELAY_MS).toBe(10_000)
  })
})

describe('saveFile download path', () => {
  it('downloads the blob through a temporary anchor with the given filename', async () => {
    const blob = new Blob(['abc'], { type: 'application/octet-stream' })

    const result = await saveFile(blob, 'minima-backup-2026-03-05.minima')

    expect(result).toBe('saved')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(clicked).toHaveLength(1)
    expect(clicked[0].download).toBe('minima-backup-2026-03-05.minima')
    expect(clicked[0].href).toBe('blob:fake-url')
    expect(clicked[0].inBody).toBe(true)
  })

  it('uses the filename it was given, not a fixed one', async () => {
    await saveFile(new Blob(['a']), 'one.zip')
    await saveFile(new Blob(['b']), 'two.zip')

    expect(clicked.map((c) => c.download)).toEqual(['one.zip', 'two.zip'])
  })

  it('removes the anchor from the document after the click', async () => {
    await saveFile(new Blob(['abc']), 'x.minima')

    expect(document.body.querySelector('a[download]')).toBeNull()
  })

  it('never revokes the object URL synchronously', async () => {
    await saveFile(new Blob(['abc']), 'x.minima')

    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes the object URL only after the delay', async () => {
    createObjectURL.mockImplementation(() => 'blob:delayed')
    await saveFile(new Blob(['abc']), 'x.minima')

    vi.advanceTimersByTime(OBJECT_URL_REVOKE_DELAY_MS - 1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:delayed')
  })

  it('does not share when options.share is not set, even if the browser can', async () => {
    const share = vi.fn(() => Promise.resolve())
    stubNavigator('share', share)
    stubNavigator('canShare', () => true)

    const result = await saveFile(new Blob(['abc']), 'x.zip')

    expect(result).toBe('saved')
    expect(share).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('downloads when share is requested but navigator.share is missing', async () => {
    const result = await saveFile(new Blob(['abc']), 'x.minima', {
      share: true,
    })

    expect(result).toBe('saved')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clicked).toHaveLength(1)
  })

  it('downloads when share is requested but canShare says no', async () => {
    const share = vi.fn(() => Promise.resolve())
    const canShare = vi.fn(() => false)
    stubNavigator('share', share)
    stubNavigator('canShare', canShare)

    const result = await saveFile(new Blob(['abc']), 'x.minima', {
      share: true,
    })

    expect(result).toBe('saved')
    expect(canShare).toHaveBeenCalledTimes(1)
    expect(share).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('downloads when share is requested but navigator.canShare is missing', async () => {
    const share = vi.fn(() => Promise.resolve())
    stubNavigator('share', share)

    await saveFile(new Blob(['abc']), 'x.minima', { share: true })

    expect(share).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })
})

describe('saveFile share path', () => {
  it('shares a File with the given name and type, and does not download', async () => {
    const share = vi.fn((_data: ShareData) => Promise.resolve())
    const canShare = vi.fn((_data?: ShareData) => true)
    stubNavigator('share', share)
    stubNavigator('canShare', canShare)

    const result = await saveFile(
      new Blob(['abc'], { type: 'application/octet-stream' }),
      'minima-backup-2026-03-05.minima',
      { share: true },
    )

    expect(result).toBe('saved')
    expect(share).toHaveBeenCalledTimes(1)
    const data = share.mock.calls[0][0]
    expect(data.files).toHaveLength(1)
    expect(data.files?.[0].name).toBe('minima-backup-2026-03-05.minima')
    expect(data.files?.[0].type).toBe('application/octet-stream')
    expect(data.title).toBe('minima-backup-2026-03-05.minima')
    expect(canShare.mock.calls[0][0]?.files?.[0].name).toBe(
      'minima-backup-2026-03-05.minima',
    )
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(clicked).toHaveLength(0)
  })

  it('returns "cancelled" when the user dismisses the share sheet (AbortError)', async () => {
    const abort = Object.assign(new Error('Share canceled'), {
      name: 'AbortError',
    })
    stubNavigator('share', vi.fn(() => Promise.reject(abort)))
    stubNavigator('canShare', () => true)

    const result = await saveFile(new Blob(['abc']), 'x.minima', {
      share: true,
    })

    expect(result).toBe('cancelled')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('rethrows any other share failure', async () => {
    stubNavigator(
      'share',
      vi.fn(() => Promise.reject(new Error('share exploded'))),
    )
    stubNavigator('canShare', () => true)

    await expect(
      saveFile(new Blob(['abc']), 'x.minima', { share: true }),
    ).rejects.toThrow('share exploded')
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
