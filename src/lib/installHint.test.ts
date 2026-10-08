// No CONTRACT_GAPs: installHint exports and detection rules are fully specified
// in the Interface Contract (module: installHint).

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InstallEnv } from '@/lib/installHint'
import {
  bestEffortHint,
  currentInstallEnv,
  isIosSafari,
  shouldShowInstallHint,
} from '@/lib/installHint'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
const IPHONE_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15'
const IPHONE_EDGE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/120.0 Version/17.0 Mobile/15E148 Safari/605.1.15'
const IPHONE_OPERA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/16.0 Version/17.0 Mobile/15E148 Safari/9537.53'
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPOD_SAFARI =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const IOS_HINT = 'Add MinimaSpend to your Home Screen so Safari keeps your data.'
const OTHER_HINT =
  'Install the app or bookmark it so the browser is less likely to clear your data.'

function env(overrides: Partial<InstallEnv> = {}): InstallEnv {
  return {
    userAgent: IPHONE_SAFARI,
    maxTouchPoints: 5,
    navigatorStandalone: false,
    displayModeStandalone: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isIosSafari', () => {
  it.each([
    ['iPhone Safari', IPHONE_SAFARI, 5],
    ['iPad Safari', IPAD_SAFARI, 5],
    ['iPod Safari', IPOD_SAFARI, 5],
    ['iPad in desktop mode (Macintosh + touch)', MAC_SAFARI, 5],
  ])('is true for %s', (_name, userAgent, maxTouchPoints) => {
    expect(isIosSafari(env({ userAgent, maxTouchPoints }))).toBe(true)
  })

  it.each([
    ['desktop Mac Safari without touch', MAC_SAFARI, 0],
    ['a Mac with a single touch point', MAC_SAFARI, 1],
    ['Chrome on iOS (CriOS)', IPHONE_CHROME, 5],
    ['Firefox on iOS (FxiOS)', IPHONE_FIREFOX, 5],
    ['Edge on iOS (EdgiOS)', IPHONE_EDGE, 5],
    ['Opera on iOS (OPiOS)', IPHONE_OPERA, 5],
    ['Android Chrome', ANDROID_CHROME, 5],
  ])('is false for %s', (_name, userAgent, maxTouchPoints) => {
    expect(isIosSafari(env({ userAgent, maxTouchPoints }))).toBe(false)
  })
})

describe('shouldShowInstallHint', () => {
  it('is true on iOS Safari that is not installed', () => {
    expect(shouldShowInstallHint(env())).toBe(true)
  })

  it('is false when navigator.standalone is true', () => {
    expect(shouldShowInstallHint(env({ navigatorStandalone: true }))).toBe(false)
  })

  it('is false when display-mode is standalone', () => {
    expect(shouldShowInstallHint(env({ displayModeStandalone: true }))).toBe(
      false,
    )
  })

  it('is false on Android Chrome', () => {
    expect(shouldShowInstallHint(env({ userAgent: ANDROID_CHROME }))).toBe(false)
  })

  it('is false for a null environment', () => {
    expect(shouldShowInstallHint(null)).toBe(false)
  })

  it('reads the current environment by default', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )
    const ua = vi.spyOn(window.navigator, 'userAgent', 'get')

    ua.mockReturnValue(IPHONE_SAFARI)
    expect(shouldShowInstallHint()).toBe(true)

    ua.mockReturnValue(ANDROID_CHROME)
    expect(shouldShowInstallHint()).toBe(false)
  })
})

describe('currentInstallEnv', () => {
  it('reads the user agent, touch points and display mode', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(display-mode: standalone)',
      })),
    )
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(IPAD_SAFARI)
    vi.spyOn(window.navigator, 'maxTouchPoints', 'get').mockReturnValue(5)

    const result = currentInstallEnv()

    expect(result).not.toBeNull()
    expect(result?.userAgent).toBe(IPAD_SAFARI)
    expect(result?.maxTouchPoints).toBe(5)
    expect(result?.displayModeStandalone).toBe(true)
  })

  it('reports display-mode as not standalone when the query does not match', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )

    expect(currentInstallEnv()?.displayModeStandalone).toBe(false)
  })
})

describe('bestEffortHint', () => {
  it('suggests Add to Home Screen on iOS Safari', () => {
    expect(bestEffortHint(env())).toBe(IOS_HINT)
  })

  it('suggests installing or bookmarking elsewhere', () => {
    expect(bestEffortHint(env({ userAgent: ANDROID_CHROME }))).toBe(OTHER_HINT)
  })

  it('falls back to the generic hint for a null environment', () => {
    expect(bestEffortHint(null)).toBe(OTHER_HINT)
  })
})
