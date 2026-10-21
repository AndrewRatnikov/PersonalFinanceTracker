// No CONTRACT_GAPs: I18nProvider, useT, LangHtml, resolveServerLang and the
// landing page are specified in plan sections 4, 5 and 1. getRequestLang needs
// a request context and is not unit-tested here (per the Interface Contract);
// the server-side decision is covered through resolveServerLang, which it calls.
// The landing page is rendered with the same mocks as LandingPage.test.tsx.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import { getLang, setLang, translate } from '@/i18n/core'
import { formatMoney } from '@/i18n/format'
import { I18nProvider, LangHtml, useT } from '@/i18n/react'
import { resolveServerLang } from '@/i18n/resolve'
import LandingPage from '@/components/LandingPage'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string
    children?: ReactNode
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: () => null,
}))

// React escapes these characters in server output.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function clearPersistedLang() {
  localStorage.clear()
  document.cookie = 'minima_lang=; Path=/; Max-Age=0'
}

function setNavigatorLanguages(languages: Array<string>) {
  Object.defineProperty(navigator, 'languages', {
    value: languages,
    configurable: true,
  })
}

function Probe() {
  const { lang, pending, t } = useT()
  return <p>{`${lang}|${pending}|${t('landing.heroTitle')}|${formatMoney(1, 'UAH')}`}</p>
}

function serverPage(initialLang: Lang): string {
  return renderToString(
    <I18nProvider initialLang={initialLang}>
      <LangHtml className="scroll-smooth">
        <body>
          <LandingPage />
        </body>
      </LangHtml>
    </I18nProvider>,
  )
}

beforeEach(() => {
  clearPersistedLang()
  setLang('en', { persist: false })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'languages')
  clearPersistedLang()
  setLang('en', { persist: false })
  document.title = ''
  document.head.querySelectorAll('meta[name="description"]').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('server render picks the language from the request', () => {
  it('cookie minima_lang=uk renders <html lang="uk"> and the Ukrainian landing text', () => {
    const html = serverPage(resolveServerLang({ cookie: 'minima_lang=uk' }))

    expect(html).toContain('lang="uk"')
    expect(html).toContain(escapeHtml(translate('uk', 'landing.heroTitle')))
    expect(html).not.toContain(translate('en', 'landing.heroTitle'))
  })

  it('Accept-Language uk-UA without a cookie does the same', () => {
    const html = serverPage(
      resolveServerLang({ acceptLanguage: 'uk-UA,uk;q=0.9,en;q=0.8' }),
    )

    expect(html).toContain('lang="uk"')
    expect(html).toContain(escapeHtml(translate('uk', 'landing.heroTitle')))
  })

  it('an English Accept-Language without a cookie renders English', () => {
    const html = serverPage(resolveServerLang({ acceptLanguage: 'en-US' }))

    expect(html).toContain('lang="en"')
    expect(html).not.toContain('lang="uk"')
    expect(html).toContain('Track your money.')
    expect(html).not.toContain(escapeHtml(translate('uk', 'landing.heroTitle')))
  })

  it('the cookie wins over Accept-Language', () => {
    const html = serverPage(
      resolveServerLang({ cookie: 'minima_lang=en', acceptLanguage: 'uk-UA' }),
    )

    expect(html).toContain('lang="en"')
    expect(html).toContain('Track your money.')
    expect(html).not.toContain('lang="uk"')
  })

  it('a Ukrainian cookie wins over an English Accept-Language', () => {
    const html = serverPage(
      resolveServerLang({ cookie: 'minima_lang=uk', acceptLanguage: 'en-US' }),
    )

    expect(html).toContain('lang="uk"')
    expect(html).toContain(escapeHtml(translate('uk', 'landing.heroTitle')))
  })

  it('the format helpers read the provider language during the first render', () => {
    const uk = renderToString(
      <I18nProvider initialLang="uk">
        <Probe />
      </I18nProvider>,
    )
    expect(uk).toContain('uk|false|')
    expect(uk).toContain('1,00 грн')

    const en = renderToString(
      <I18nProvider initialLang="en">
        <Probe />
      </I18nProvider>,
    )
    expect(en).toContain('en|false|')
    expect(en).toContain('1.00 UAH')
  })

  it('does not persist the language it was given', () => {
    serverPage('uk')

    expect(localStorage.getItem('minima_lang')).toBeNull()
    expect(document.cookie).not.toContain('minima_lang')
  })
})

describe('hydration', () => {
  it('hydrates the server markup without a mismatch', async () => {
    const tree = (
      <I18nProvider initialLang="uk">
        <Probe />
      </I18nProvider>
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.innerHTML = renderToString(tree)
    const serverText = container.textContent
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    let root: ReturnType<typeof hydrateRoot> | undefined
    await act(async () => {
      root = hydrateRoot(container, tree)
    })

    expect(consoleError).not.toHaveBeenCalled()
    expect(container.textContent).toBe(serverText)
    expect(serverText).toContain('uk|false|')
    act(() => root?.unmount())
    container.remove()
  })
})

describe('the offline shell resolves the language on the client', () => {
  it('server-renders the shell as pending', () => {
    const html = renderToString(
      <I18nProvider initialLang={null}>
        <Probe />
      </I18nProvider>,
    )

    expect(html).toContain('|true|')
  })

  it('picks Ukrainian from the browser languages before first paint', () => {
    setNavigatorLanguages(['uk-UA', 'en'])

    const { container } = render(
      <I18nProvider initialLang={null}>
        <Probe />
      </I18nProvider>,
    )

    expect(container.textContent).toContain('uk|false|')
    expect(container.textContent).toContain(translate('uk', 'landing.heroTitle'))
    expect(document.documentElement.lang).toBe('uk')
    expect(getLang()).toBe('uk')
  })

  it('stays English for a browser without Ukrainian', () => {
    setNavigatorLanguages(['ru-RU', 'en-US'])

    const { container } = render(
      <I18nProvider initialLang={null}>
        <Probe />
      </I18nProvider>,
    )

    expect(container.textContent).toContain('en|false|Track your money.')
    expect(document.documentElement.lang).toBe('en')
  })

  it('a stored choice beats the browser languages', () => {
    setNavigatorLanguages(['uk-UA'])
    localStorage.setItem('minima_lang', 'en')

    const { container } = render(
      <I18nProvider initialLang={null}>
        <Probe />
      </I18nProvider>,
    )

    expect(container.textContent).toContain('en|false|')
  })

  it('does not persist an automatically detected language', () => {
    setNavigatorLanguages(['uk-UA'])

    render(
      <I18nProvider initialLang={null}>
        <Probe />
      </I18nProvider>,
    )

    expect(localStorage.getItem('minima_lang')).toBeNull()
    expect(document.cookie).not.toContain('minima_lang')
  })
})

describe('I18nProvider after mount', () => {
  it('switches to a stored choice that differs from the server language and re-writes the cookie', () => {
    localStorage.setItem('minima_lang', 'uk')

    const { container } = render(
      <I18nProvider initialLang="en">
        <Probe />
      </I18nProvider>,
    )

    expect(container.textContent).toContain('uk|false|')
    expect(document.documentElement.lang).toBe('uk')
    expect(document.cookie).toContain('minima_lang=uk')
  })

  it('keeps the server language when nothing is stored', () => {
    const { container } = render(
      <I18nProvider initialLang="uk">
        <Probe />
      </I18nProvider>,
    )

    expect(container.textContent).toContain('uk|false|')
    expect(localStorage.getItem('minima_lang')).toBeNull()
  })

  it('without initialLang starts from the current language', () => {
    setLang('uk', { persist: false })

    const { container } = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    )

    expect(container.textContent).toContain('uk|false|')
  })

  it('re-renders the tree when setLang is called from outside', () => {
    const { container } = render(
      <I18nProvider initialLang="en">
        <Probe />
      </I18nProvider>,
    )
    expect(container.textContent).toContain('en|false|Track your money.')

    act(() => {
      setLang('uk', { persist: false })
    })

    expect(container.textContent).toContain('uk|false|')
    expect(container.textContent).toContain(translate('uk', 'landing.heroTitle'))
  })

  it('keeps <title> and the meta description in the current language', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'description')
    meta.setAttribute('content', '')
    document.head.appendChild(meta)

    function Switch() {
      const { setLang: choose } = useT()
      return (
        <>
          <button type="button" onClick={() => choose('uk')}>
            {'to-uk'}
          </button>
          <button type="button" onClick={() => choose('en')}>
            {'to-en'}
          </button>
        </>
      )
    }
    render(
      <I18nProvider initialLang="en">
        <Switch />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByText('to-uk'))
    expect(document.title).toBe(translate('uk', 'landing.metaTitle'))
    expect(meta.getAttribute('content')).toBe(translate('uk', 'landing.metaDescription'))

    fireEvent.click(screen.getByText('to-en'))
    expect(document.title).toBe(translate('en', 'landing.metaTitle'))
    expect(meta.getAttribute('content')).toBe(translate('en', 'landing.metaDescription'))
    expect(translate('uk', 'landing.metaDescription')).not.toBe(
      translate('en', 'landing.metaDescription'),
    )
  })
})

describe('useT outside a provider', () => {
  it('works and is bound to the current language', () => {
    const { container, unmount } = render(<Probe />)
    expect(container.textContent).toContain('en|false|Track your money.')
    unmount()

    setLang('uk', { persist: false })
    const second = render(<Probe />)
    expect(second.container.textContent).toContain('uk|false|')
    expect(second.container.textContent).toContain(translate('uk', 'landing.heroTitle'))
  })
})
