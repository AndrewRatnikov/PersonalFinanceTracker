// Saves a file the way the platform supports best (spec §7.2): the share
// sheet (navigator.share({ files })) when asked for and supported, otherwise a
// single blob download through a temporary anchor. The object URL is revoked
// after a delay, never synchronously, so the download can start first.

export const OBJECT_URL_REVOKE_DELAY_MS = 10_000

export type SaveResult = 'saved' | 'cancelled'

type ShareNavigator = Partial<Pick<Navigator, 'share' | 'canShare'>>

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

function shareNavigator(): ShareNavigator | null {
  if (typeof navigator === 'undefined') return null
  return navigator as ShareNavigator
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS)
}

export async function saveFile(
  blob: Blob,
  filename: string,
  options: { share?: boolean } = {},
): Promise<SaveResult> {
  const nav = shareNavigator()
  if (
    options.share &&
    nav &&
    typeof nav.share === 'function' &&
    typeof nav.canShare === 'function'
  ) {
    const file = new File([blob], filename, { type: blob.type })
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: filename })
        return 'saved'
      } catch (err) {
        if (isAbortError(err)) return 'cancelled'
        throw err
      }
    }
  }
  download(blob, filename)
  return 'saved'
}
