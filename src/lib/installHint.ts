// iOS Safari may evict a website's storage; an app added to the Home Screen
// keeps it (spec §6.1). Pure detection, so it is easy to test.

import { t } from '../i18n/core'

export interface InstallEnv {
  userAgent: string
  maxTouchPoints: number
  navigatorStandalone: boolean
  displayModeStandalone: boolean
}

const IOS_DEVICE = /iPhone|iPad|iPod/
const OTHER_IOS_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS/


export function currentInstallEnv(): InstallEnv | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return null
  }
  const nav = navigator as Navigator & { standalone?: boolean }
  let displayModeStandalone = false
  try {
    displayModeStandalone =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches
  } catch {
    displayModeStandalone = false
  }
  return {
    userAgent: nav.userAgent,
    // Older engines don't define it.
    maxTouchPoints: Number(nav.maxTouchPoints) || 0,
    navigatorStandalone: nav.standalone === true,
    displayModeStandalone,
  }
}

export function isIosSafari(env: InstallEnv): boolean {
  const ua = env.userAgent
  const iosDevice =
    IOS_DEVICE.test(ua) || (ua.includes('Macintosh') && env.maxTouchPoints > 1)
  return iosDevice && ua.includes('Safari') && !OTHER_IOS_BROWSER.test(ua)
}

export function shouldShowInstallHint(
  env: InstallEnv | null = currentInstallEnv(),
): boolean {
  return (
    env !== null &&
    isIosSafari(env) &&
    !env.navigatorStandalone &&
    !env.displayModeStandalone
  )
}

// The hint of the Best-effort storage status, in the UI language.
export function bestEffortHint(env: InstallEnv | null): string {
  return env !== null && isIosSafari(env)
    ? t('settings.storage.hintIos')
    : t('settings.storage.hintOther')
}
