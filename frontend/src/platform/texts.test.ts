// FE-133 -- the instance text overlays fetched at start.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyInstanceConfig } from '@/platform/instance'

const apply = vi.hoisted(() => vi.fn())
const report = vi.hoisted(() => vi.fn())
vi.mock('@/locales', () => ({ applyInstanceOverrides: apply }))
vi.mock('@/platform/error-reporter', () => ({ reportError: report }))

import { INSTANCE_TEXTS_TIMEOUT_MS, INSTANCE_TEXTS_URL, loadInstanceTexts } from './texts'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('loadInstanceTexts -- /texts/ui/<locale>.json (FE-133)', () => {
  beforeEach(() => {
    apply.mockReset()
    report.mockClear()
    applyInstanceConfig({ locales: 'ru,en,uk' })
  })
  afterEach(() => applyInstanceConfig(null))

  it('requests one file per instance locale, without caching', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }))
    await loadInstanceTexts(fetchMock as unknown as typeof fetch)
    const init = { cache: 'no-store', signal: expect.any(AbortSignal) }
    expect(fetchMock.mock.calls).toEqual([
      [`${INSTANCE_TEXTS_URL}ru.json`, init],
      [`${INSTANCE_TEXTS_URL}en.json`, init],
      [`${INSTANCE_TEXTS_URL}uk.json`, init],
    ])
  })

  it('hands the files that exist to applyInstanceOverrides, by locale', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/ru.json')
        ? json({ common: { save: 'Принять' } })
        : new Response('', { status: 404 }),
    )
    await loadInstanceTexts(fetchImpl as unknown as typeof fetch)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ ru: { common: { save: 'Принять' } } })
  })

  it('no package mounted (404 everywhere) is a silent no-op', async () => {
    await loadInstanceTexts((async () => new Response('', { status: 404 })) as typeof fetch)
    expect(apply).not.toHaveBeenCalled()
  })

  it('an HTML answer (dev-server SPA fallback) is "no texts"', async () => {
    await loadInstanceTexts(
      (async () =>
        new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch,
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it('a broken file, a non-object body and a network error never throw', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/ru.json'))
        return new Response('{', { headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/en.json')) return json(['not', 'an', 'object'])
      throw new TypeError('offline')
    })
    await expect(loadInstanceTexts(fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined()
    expect(apply).not.toHaveBeenCalled()
  })

  it('a stalled file is abandoned after the timeout: the app starts without it', async () => {
    const stalled = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('t', 'TimeoutError')),
          )
        }),
    )
    vi.useFakeTimers()
    try {
      const done = loadInstanceTexts(stalled as unknown as typeof fetch)
      await vi.advanceTimersByTimeAsync(INSTANCE_TEXTS_TIMEOUT_MS + 10)
      await done
    } finally {
      vi.useRealTimers()
    }
    expect(apply).not.toHaveBeenCalled()
  })

  it('an overlay that makes applyInstanceOverrides throw is reported, the app starts', async () => {
    apply.mockImplementation(() => {
      throw new RangeError('too deep')
    })
    const fetchImpl = async () => json({ common: { save: 'x' } })
    await expect(loadInstanceTexts(fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledWith(expect.any(RangeError), {
      source: 'window',
      info: 'instance texts',
    })
  })
})
