// No CONTRACT_GAPs: createNbuProvider, nbuRequestUrl, HttpError and the NBU_*
// constants are fully specified in the Interface Contract (module: rates).
// Every test injects fetchJson (or stubs the global request function); the real
// NBU is never called.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HttpError,
  NBU_DEFAULT_BASE_URL,
  NBU_MAX_CONCURRENT,
  NBU_MAX_LOOKBACK_DAYS,
  NBU_MAX_TRIES,
  createNbuProvider,
  nbuRequestUrl,
} from '@/lib/rates/nbu'
import { RateUnavailableError } from '@/lib/rates/types'

const URL_PREFIX = `${NBU_DEFAULT_BASE_URL}/NBUStatService/v1/statdirectory/exchange?json&date=`

function rows(exchangedate = '14.10.2026') {
  return [
    { r030: 840, txt: 'US Dollar', rate: 41.52, cc: 'USD', exchangedate },
    { r030: 978, txt: 'Euro', rate: 45.1, cc: 'EUR', exchangedate },
    { r030: 826, txt: 'Pound', rate: 53.2, cc: 'GBP', exchangedate },
  ]
}

// 'YYYYMMDD' from a request url -> 'DD.MM.YYYY'
function exchangeDateOf(url: string): string {
  const compact = url.slice(url.length - 8)
  return `${compact.slice(6, 8)}.${compact.slice(4, 6)}.${compact.slice(0, 4)}`
}

const noSleep = () => Promise.resolve()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('constants', () => {
  it('exposes the documented limits and base url', () => {
    expect(NBU_DEFAULT_BASE_URL).toBe('https://bank.gov.ua')
    expect(NBU_MAX_LOOKBACK_DAYS).toBe(7)
    expect(NBU_MAX_CONCURRENT).toBe(3)
    expect(NBU_MAX_TRIES).toBe(3)
  })
})

describe('nbuRequestUrl', () => {
  it('builds the statdirectory url with the date as YYYYMMDD', () => {
    expect(nbuRequestUrl('https://bank.gov.ua', '2026-10-14')).toBe(
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&date=20261014',
    )
  })

  it('uses the given base url and changes with the date', () => {
    expect(nbuRequestUrl('http://localhost:9999', '2026-01-05')).toBe(
      'http://localhost:9999/NBUStatService/v1/statdirectory/exchange?json&date=20260105',
    )
  })
})

describe('createNbuProvider getRates parsing', () => {
  it('has the id "nbu"', () => {
    expect(createNbuProvider({ fetchJson: vi.fn() }).id).toBe('nbu')
  })

  it('parses a fixture into perBase { UAH: 1, USD: 41.52, EUR: 45.10 } with the effective date', async () => {
    const fetchJson = vi.fn().mockResolvedValue(rows('14.10.2026'))
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table).toEqual({
      base: 'UAH',
      effectiveDate: '2026-10-14',
      perBase: { UAH: 1, USD: 41.52, EUR: 45.1 },
    })
  })

  it('takes effectiveDate from exchangedate, not from the requested date', async () => {
    const fetchJson = vi.fn().mockResolvedValue(rows('09.10.2026'))
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.effectiveDate).toBe('2026-10-09')
  })

  it('ignores currencies outside CURRENCIES', async () => {
    const fetchJson = vi.fn().mockResolvedValue(rows())
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(Object.keys(table.perBase).sort()).toEqual(['EUR', 'UAH', 'USD'])
  })

  it('requests exactly the date url, with nothing but the date in it', async () => {
    const fetchJson = vi.fn().mockResolvedValue(rows())
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    await provider.getRates('2026-10-14')

    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(fetchJson).toHaveBeenCalledWith(`${URL_PREFIX}20261014`)
    const url = new URL(fetchJson.mock.calls[0][0] as string)
    expect([...url.searchParams.keys()].sort()).toEqual(['date', 'json'])
  })

  it('uses a custom baseUrl', async () => {
    const fetchJson = vi.fn().mockResolvedValue(rows())
    const provider = createNbuProvider({
      fetchJson,
      baseUrl: 'http://localhost:9999',
      sleep: noSleep,
    })

    await provider.getRates('2026-10-14')

    expect(fetchJson).toHaveBeenCalledWith(
      'http://localhost:9999/NBUStatService/v1/statdirectory/exchange?json&date=20261014',
    )
  })

  it('does not cache: asking twice requests twice', async () => {
    const fetchJson = vi.fn().mockResolvedValue(rows())
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    await provider.getRates('2026-10-14')
    await provider.getRates('2026-10-14')

    expect(fetchJson).toHaveBeenCalledTimes(2)
  })
})

describe('createNbuProvider default request', () => {
  it('sends credentials omit and no referrer, and returns the parsed body', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(rows()),
    })
    vi.stubGlobal('fetch', request)
    const provider = createNbuProvider({ sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.perBase.USD).toBe(41.52)
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${URL_PREFIX}20261014`)
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
  })

  it('treats a non-ok response as an HTTP error: a 404 is not retried', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve([]),
    })
    vi.stubGlobal('fetch', request)
    const provider = createNbuProvider({ sleep: noSleep })

    await expect(provider.getRates('2026-10-14')).rejects.toBeInstanceOf(
      RateUnavailableError,
    )
    // 404 is not retried.
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('HttpError', () => {
  it('is an Error carrying the status', () => {
    const err = new HttpError(503)

    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(503)
    expect(new HttpError(429).status).toBe(429)
  })
})

describe('createNbuProvider step-back', () => {
  it('steps back one day when the date returns [] and reports that effectiveDate', async () => {
    const fetchJson = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('20261014') ? [] : rows(exchangeDateOf(url))),
    )
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.effectiveDate).toBe('2026-10-13')
    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      `${URL_PREFIX}20261014`,
      `${URL_PREFIX}20261013`,
    ])
  })

  it('steps back across a month boundary', async () => {
    const fetchJson = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('20260301') ? [] : rows(exchangeDateOf(url))),
    )
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-03-01')

    expect(table.effectiveDate).toBe('2026-02-28')
  })

  it('steps back when a day lacks one of the currencies', async () => {
    const fetchJson = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('20261014')
          ? rows().filter((r) => r.cc !== 'EUR')
          : rows(exchangeDateOf(url)),
      ),
    )
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.effectiveDate).toBe('2026-10-13')
    expect(table.perBase.EUR).toBe(45.1)
  })

  it.each([0, -3, Number.NaN])(
    'steps back when a rate is not a finite positive number (%s)',
    async (bad) => {
      const fetchJson = vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('20261014')
            ? rows().map((r) => (r.cc === 'USD' ? { ...r, rate: bad } : r))
            : rows(exchangeDateOf(url)),
        ),
      )
      const provider = createNbuProvider({ fetchJson, sleep: noSleep })

      const table = await provider.getRates('2026-10-14')

      expect(table.effectiveDate).toBe('2026-10-13')
    },
  )

  it('treats a response that is not an array as []', async () => {
    const fetchJson = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('20261014') ? { error: 'nope' } : rows(exchangeDateOf(url)),
      ),
    )
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.effectiveDate).toBe('2026-10-13')
  })

  it('finds a rate on the 7th date (6 days back)', async () => {
    const fetchJson = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('20261008') ? rows('08.10.2026') : []),
    )
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.effectiveDate).toBe('2026-10-08')
    expect(fetchJson).toHaveBeenCalledTimes(7)
  })

  it('stops after 7 dates with RateUnavailableError', async () => {
    const fetchJson = vi.fn().mockResolvedValue([])
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    await expect(provider.getRates('2026-10-14')).rejects.toBeInstanceOf(
      RateUnavailableError,
    )

    expect(fetchJson).toHaveBeenCalledTimes(NBU_MAX_LOOKBACK_DAYS)
    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      `${URL_PREFIX}20261014`,
      `${URL_PREFIX}20261013`,
      `${URL_PREFIX}20261012`,
      `${URL_PREFIX}20261011`,
      `${URL_PREFIX}20261010`,
      `${URL_PREFIX}20261009`,
      `${URL_PREFIX}20261008`,
    ])
  })
})

describe('createNbuProvider retries', () => {
  it.each([429, 500, 503])(
    'retries a %s response and succeeds on the third try',
    async (status) => {
      const fetchJson = vi
        .fn()
        .mockRejectedValueOnce(new HttpError(status))
        .mockRejectedValueOnce(new HttpError(status))
        .mockResolvedValue(rows())
      const provider = createNbuProvider({ fetchJson, sleep: noSleep })

      const table = await provider.getRates('2026-10-14')

      expect(table.perBase.USD).toBe(41.52)
      expect(fetchJson).toHaveBeenCalledTimes(3)
      // All three tries asked for the same date.
      expect(new Set(fetchJson.mock.calls.map((c) => c[0])).size).toBe(1)
    },
  )

  it('retries a network error (non-HttpError)', async () => {
    const fetchJson = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to load'))
      .mockResolvedValue(rows())
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const table = await provider.getRates('2026-10-14')

    expect(table.perBase.EUR).toBe(45.1)
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('gives up after 3 tries with RateUnavailableError and does not step back', async () => {
    const fetchJson = vi.fn().mockRejectedValue(new HttpError(500))
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    await expect(provider.getRates('2026-10-14')).rejects.toBeInstanceOf(
      RateUnavailableError,
    )

    expect(fetchJson).toHaveBeenCalledTimes(NBU_MAX_TRIES)
    expect(new Set(fetchJson.mock.calls.map((c) => c[0])).size).toBe(1)
  })

  it.each([400, 403, 404])(
    'does not retry a %s response',
    async (status) => {
      const fetchJson = vi.fn().mockRejectedValue(new HttpError(status))
      const provider = createNbuProvider({ fetchJson, sleep: noSleep })

      await expect(provider.getRates('2026-10-14')).rejects.toBeInstanceOf(
        RateUnavailableError,
      )

      expect(fetchJson).toHaveBeenCalledTimes(1)
    },
  )

  it('waits retryDelayMs * 2^(attempt-1) between tries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fetchJson = vi.fn().mockRejectedValue(new HttpError(503))
    const provider = createNbuProvider({ fetchJson, retryDelayMs: 100, sleep })

    await expect(provider.getRates('2026-10-14')).rejects.toBeInstanceOf(
      RateUnavailableError,
    )

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200])
  })

  it('scales the delay with retryDelayMs', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fetchJson = vi.fn().mockRejectedValue(new HttpError(503))
    const provider = createNbuProvider({ fetchJson, retryDelayMs: 7, sleep })

    await expect(provider.getRates('2026-10-14')).rejects.toBeInstanceOf(
      RateUnavailableError,
    )

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7, 14])
  })

  it('does not sleep when the first try succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const provider = createNbuProvider({
      fetchJson: vi.fn().mockResolvedValue(rows()),
      sleep,
    })

    await provider.getRates('2026-10-14')

    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('createNbuProvider concurrency', () => {
  it('runs at most 3 requests at once across parallel getRates calls', async () => {
    const resolvers: Array<() => void> = []
    let inFlight = 0
    let maxInFlight = 0
    const fetchJson = vi.fn((url: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<unknown>((resolve) => {
        resolvers.push(() => {
          inFlight--
          resolve(rows(exchangeDateOf(url)))
        })
      })
    })
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })
    const dates = [
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]

    const all = Promise.all(dates.map((d) => provider.getRates(d)))

    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(NBU_MAX_CONCURRENT)
    })
    // Give a wrongly unbounded implementation the chance to start more.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchJson).toHaveBeenCalledTimes(NBU_MAX_CONCURRENT)

    let released = 0
    while (released < dates.length) {
      await vi.waitFor(() => {
        expect(resolvers.length).toBeGreaterThan(0)
      })
      resolvers.shift()?.()
      released++
    }
    const tables = await all

    expect(maxInFlight).toBe(NBU_MAX_CONCURRENT)
    expect(fetchJson).toHaveBeenCalledTimes(dates.length)
    expect(tables.map((t) => t.effectiveDate)).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ])
  })

  it('frees its slots when requests fail, so later calls still run', async () => {
    const fetchJson = vi.fn((url: string) =>
      url.endsWith('20261001')
        ? Promise.reject(new HttpError(404))
        : Promise.resolve(rows(exchangeDateOf(url))),
    )
    const provider = createNbuProvider({ fetchJson, sleep: noSleep })

    const failed = await Promise.allSettled(
      Array.from({ length: 6 }, () => provider.getRates('2026-10-01')),
    )
    const table = await provider.getRates('2026-10-14')

    expect(failed.every((r) => r.status === 'rejected')).toBe(true)
    expect(table.effectiveDate).toBe('2026-10-14')
  })
})
