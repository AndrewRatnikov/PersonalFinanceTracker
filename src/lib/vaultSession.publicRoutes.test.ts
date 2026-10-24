// No CONTRACT_GAPs: PUBLIC_ROUTES, isPublicRoute and the computeGate change are
// specified in plan section 11 and the Interface Contract (module:
// vaultSession). The mocks mirror vaultSession.test.ts.

import { describe, expect, it, vi } from 'vitest'

import {
  PUBLIC_ROUTES,
  computeGate,
  isDataRoute,
  isPublicRoute,
} from '@/lib/vaultSession'

vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))

describe('PUBLIC_ROUTES / isPublicRoute', () => {
  it('lists /terms and /privacy', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual(['/privacy', '/terms'])
  })

  it('matches the routes exactly and their sub-paths', () => {
    expect(isPublicRoute('/terms')).toBe(true)
    expect(isPublicRoute('/privacy')).toBe(true)
    expect(isPublicRoute('/terms/')).toBe(true)
    expect(isPublicRoute('/privacy/section')).toBe(true)
  })

  it('does not match other paths or look-alikes', () => {
    for (const path of ['/', '/settings', '/analytics', '/termsx', '/privacyx', '/my/terms', '/login']) {
      expect(isPublicRoute(path), path).toBe(false)
    }
  })

  it('public routes are not data routes', () => {
    expect(isDataRoute('/terms')).toBe(false)
    expect(isDataRoute('/privacy')).toBe(false)
  })
})

describe('computeGate and the legal pages', () => {
  it.each(['/terms', '/privacy'])('never shows the gate on %s while locked', (pathname) => {
    expect(
      computeGate({ mounted: true, phase: 'locked', createRequested: false, pathname }),
    ).toEqual({ showGate: false, showChildren: true })
  })

  it.each(['/terms', '/privacy'])('never shows the gate on %s while creating a vault', (pathname) => {
    expect(
      computeGate({ mounted: true, phase: 'none', createRequested: true, pathname }),
    ).toEqual({ showGate: false, showChildren: true })
  })

  it('shows the content on the legal pages in every phase', () => {
    for (const phase of ['checking', 'none', 'locked', 'unlocked'] as const) {
      const gate = computeGate({
        mounted: true,
        phase,
        createRequested: false,
        pathname: '/privacy',
      })
      expect(gate.showGate, phase).toBe(false)
      expect(gate.showChildren, phase).toBe(true)
    }
  })

  it('still shows the gate on other routes while locked', () => {
    expect(
      computeGate({ mounted: true, phase: 'locked', createRequested: false, pathname: '/' }),
    ).toEqual({ showGate: true, showChildren: true })
    expect(
      computeGate({ mounted: true, phase: 'locked', createRequested: false, pathname: '/settings' }),
    ).toEqual({ showGate: true, showChildren: false })
    expect(
      computeGate({ mounted: true, phase: 'locked', createRequested: false, pathname: '/termsx' }),
    ).toEqual({ showGate: true, showChildren: true })
  })

  it('still shows the gate for vault creation on other routes', () => {
    expect(
      computeGate({ mounted: true, phase: 'none', createRequested: true, pathname: '/' }),
    ).toEqual({ showGate: true, showChildren: true })
  })

  it('does nothing before mount', () => {
    expect(
      computeGate({ mounted: false, phase: 'locked', createRequested: false, pathname: '/' }),
    ).toEqual({ showGate: false, showChildren: true })
  })
})
