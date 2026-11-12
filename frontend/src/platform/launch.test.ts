// =============================================================================
// VELO Frontend -- platform/launch.ts tests (BE-149)
// =============================================================================
//
// The launch decision is the one question everything in launch.ts hangs on:
// did Telegram launch this page? A wrong "no" boots the Telegram Mini App as a
// standalone page (the "Open in Telegram" stub INSIDE Telegram); a wrong "yes"
// sends a browser to telegram.org and leaves the installed app without
// viewport-fit=cover. Both directions are pinned here, along the three twin
// axes: REPEAT (params twice, loader called twice), EMPTY (empty values, bare
// separators, empty mark), SHORTAGE (only some params, storage that throws).
//
// The script element is never really inserted: a real <script src> in
// happy-dom would try the network. Tests capture it at appendChild and fire
// its onload/onerror by hand -- which is exactly the contract loadTelegramScript
// relies on.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  INSTANCE_CONFIG_URL,
  TELEGRAM_LAUNCH_KEY,
  TELEGRAM_SCRIPT_URL,
  _resetLaunchForTests,
  applyStandaloneViewport,
  hasLaunchParams,
  isTelegramLaunch,
  loadInstanceConfig,
  loadTelegramScript,
  prepareHost,
} from '@/platform/launch'
import { INSTANCE, applyInstanceConfig } from '@/platform/instance'

const BASE_VIEWPORT =
  'width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes, interactive-widget=resizes-visual'

/** In-memory Storage double; `failGet` / `failSet` make it throw like a blocked one. */
function memoryStorage(
  init: Record<string, string> = {},
  opts: { failGet?: boolean; failSet?: boolean } = {},
): Storage {
  const data = new Map(Object.entries(init))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => {
      if (opts.failGet) throw new Error('SecurityError')
      return data.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (opts.failSet) throw new Error('QuotaExceededError')
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
  }
}

/** Minimal Document double for the loader: records created scripts. */
function fakeDoc(): { doc: Document; scripts: HTMLScriptElement[] } {
  const scripts: HTMLScriptElement[] = []
  const doc = {
    createElement: () => {
      const s = { src: '', onload: null, onerror: null } as unknown as HTMLScriptElement
      scripts.push(s)
      return s
    },
    head: { appendChild: vi.fn() },
  } as unknown as Document
  return { doc, scripts }
}

function viewportMeta(): HTMLMetaElement {
  return document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!
}

beforeEach(() => {
  _resetLaunchForTests()
  sessionStorage.clear()
  document.head.innerHTML = `<meta name="viewport" content="${BASE_VIEWPORT}" />`
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('hasLaunchParams -- Telegram launch parameters in the URL', () => {
  it.each([
    ['hash, full launch', 'https://x.test/#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0'],
    ['query (some clients)', 'https://x.test/?tgWebAppStartParam=open_practice__1'],
    ['reply-keyboard launch: version only, no data', 'https://x.test/#tgWebAppVersion=8.0'],
    ['REPEAT: in both query and hash', 'https://x.test/?tgWebAppData=a#tgWebAppData=a'],
    ['EMPTY value: key present, nothing after "="', 'https://x.test/#tgWebAppData='],
    ['after a route path', 'https://x.test/practices/7#tgWebAppPlatform=ios'],
  ])('%s -> true', (_label, href) => {
    expect(hasLaunchParams(href)).toBe(true)
  })

  it.each([
    ['no query, no hash', 'https://x.test/practices/7'],
    ['EMPTY: bare "#"', 'https://x.test/#'],
    ['EMPTY: bare "?"', 'https://x.test/?'],
    ['an app hash, not Telegram', 'https://x.test/diary#entry-42'],
    ['an unrelated query', 'https://x.test/?utm_source=tg'],
    ['the prefix only inside a VALUE', 'https://x.test/?ref=tgWebAppData'],
  ])('%s -> false', (_label, href) => {
    expect(hasLaunchParams(href)).toBe(false)
  })
})

describe('isTelegramLaunch -- URL first, then the session mark', () => {
  it('URL params -> true AND the mark is left for a later reload', () => {
    const storage = memoryStorage()

    expect(isTelegramLaunch('https://x.test/#tgWebAppData=a', () => storage)).toBe(true)
    expect(storage.getItem(TELEGRAM_LAUNCH_KEY)).toBe('1')
  })

  it('reload after in-app navigation: URL lost its params, the mark answers', () => {
    // The state a Telegram "Reload" (or chunk-reload.ts) produces: without the
    // mark the Mini App would come back up as the standalone stub.
    const storage = memoryStorage({ [TELEGRAM_LAUNCH_KEY]: '1' })

    expect(isTelegramLaunch('https://x.test/practices/7', () => storage)).toBe(true)
  })

  it('plain browser: no params, no mark -> false, and nothing is written', () => {
    const storage = memoryStorage()

    expect(isTelegramLaunch('https://x.test/', () => storage)).toBe(false)
    expect(storage.length).toBe(0)
  })

  it.each([
    ['EMPTY mark', ''],
    ['foreign value', 'true'],
  ])('%s -> false (only the exact mark counts)', (_label, value) => {
    const storage = memoryStorage({ [TELEGRAM_LAUNCH_KEY]: value })

    expect(isTelegramLaunch('https://x.test/', () => storage)).toBe(false)
  })

  it('SHORTAGE: storage that throws on read -> false, not an exception', () => {
    const storage = memoryStorage({}, { failGet: true })

    expect(isTelegramLaunch('https://x.test/', () => storage)).toBe(false)
  })

  it('SHORTAGE: unwritable storage still detects THIS load from the URL', () => {
    const storage = memoryStorage({}, { failSet: true })

    expect(isTelegramLaunch('https://x.test/#tgWebAppData=a', () => storage)).toBe(true)
  })

  it('SHORTAGE: storage getter itself throws -> false', () => {
    expect(
      isTelegramLaunch('https://x.test/', () => {
        throw new Error('SecurityError')
      }),
    ).toBe(false)
  })
})

describe('loadTelegramScript', () => {
  it('appends ONE script with the CDN url and resolves on load', async () => {
    const { doc, scripts } = fakeDoc()
    let settled = false

    const p = loadTelegramScript(doc).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false) // waits for the script, does not race it

    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.src).toBe(TELEGRAM_SCRIPT_URL)
    expect(doc.head.appendChild).toHaveBeenCalledWith(scripts[0])
    scripts[0]!.onload!(new Event('load'))
    await p
    expect(settled).toBe(true)
  })

  it('a failed load resolves too (start as standalone, like a blocked CDN)', async () => {
    const { doc, scripts } = fakeDoc()

    const p = loadTelegramScript(doc)
    ;(scripts[0]!.onerror as (e: Event) => void)(new Event('error'))

    await expect(p).resolves.toBeUndefined()
  })

  it('REPEAT: a second call returns the same load -- no second script', () => {
    const { doc, scripts } = fakeDoc()

    const a = loadTelegramScript(doc)
    const b = loadTelegramScript(doc)

    expect(b).toBe(a)
    expect(scripts).toHaveLength(1)
  })
})

describe('applyStandaloneViewport', () => {
  it('appends viewport-fit=cover and keeps everything that was there', () => {
    applyStandaloneViewport(document)

    expect(viewportMeta().content).toBe(`${BASE_VIEWPORT}, viewport-fit=cover`)
  })

  it('REPEAT: idempotent -- applied twice, appended once', () => {
    applyStandaloneViewport(document)
    applyStandaloneViewport(document)

    expect(viewportMeta().content.match(/viewport-fit/g)).toHaveLength(1)
  })
})

describe('prepareHost -- the decision applied to the real host', () => {
  it('browser / installed app: NO telegram.org request, viewport gets cover', async () => {
    window.history.replaceState(null, '', '/practices/7')
    const append = vi.spyOn(document.head, 'appendChild')

    await prepareHost()

    // "no script" paired with "the standalone branch really ran".
    expect(append).not.toHaveBeenCalled()
    expect(document.querySelector('script')).toBeNull()
    expect(viewportMeta().content).toContain('viewport-fit=cover')
  })

  it('Telegram launch: loads the script, WAITS for it, viewport stays byte-identical', async () => {
    window.history.replaceState(null, '', '/#tgWebAppData=a&tgWebAppVersion=8.0')
    let captured: HTMLScriptElement | null = null
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      captured = node as unknown as HTMLScriptElement
      return node
    })
    let done = false

    const p = prepareHost().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(captured!.src).toBe(TELEGRAM_SCRIPT_URL)

    captured!.onload!(new Event('load'))
    await p
    expect(done).toBe(true)
    expect(viewportMeta().content).toBe(BASE_VIEWPORT)
  })

  it('reload inside Telegram (params gone, mark set): still the Telegram branch', async () => {
    sessionStorage.setItem(TELEGRAM_LAUNCH_KEY, '1')
    window.history.replaceState(null, '', '/practices/7')
    let captured: HTMLScriptElement | null = null
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      captured = node as unknown as HTMLScriptElement
      return node
    })

    const p = prepareHost()
    captured!.onload!(new Event('load'))
    await p

    expect(captured!.src).toBe(TELEGRAM_SCRIPT_URL)
    expect(viewportMeta().content).toBe(BASE_VIEWPORT)
  })
})

describe('loadInstanceConfig -- the runtime /config.json (FE-129)', () => {
  // apiBaseUrl is a live getter, so state applied in one test is visible in
  // the next -- every test resets the runtime config; the snapshot fields
  // (brand, locales, default locale) are pinned in instance.test.ts through
  // a fresh module import instead.
  afterEach(() => {
    vi.unstubAllGlobals()
    applyInstanceConfig(null)
  })

  it('requests exactly /config.json, without caching', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await loadInstanceConfig()

    expect(fetchMock).toHaveBeenCalledWith(INSTANCE_CONFIG_URL, { cache: 'no-store' })
  })

  it('a rendered config reaches the instance seams', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ apiBaseUrl: 'https://api.school.example' }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await loadInstanceConfig()

    expect(INSTANCE.apiBaseUrl).toBe('https://api.school.example')
  })

  it('an HTML answer (dev-server SPA fallback) is "no config", not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html><html lang="ru"></html>', {
            headers: { 'content-type': 'text/html' },
          }),
      ),
    )

    await expect(loadInstanceConfig()).resolves.toBeUndefined()
    expect(INSTANCE.apiBaseUrl).toBe('')
  })

  it('a non-200 answer is "no config" too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )

    await expect(loadInstanceConfig()).resolves.toBeUndefined()
  })

  it('a failed fetch (no config in dev) is tolerated silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )

    await expect(loadInstanceConfig()).resolves.toBeUndefined()
  })

  it('malformed JSON is tolerated: build-time defaults apply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{oops', { headers: { 'content-type': 'application/json' } })),
    )

    await expect(loadInstanceConfig()).resolves.toBeUndefined()
    expect(INSTANCE.apiBaseUrl).toBe('')
  })

  it('prepareHost includes the config load (browser branch)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"brand":"ШКОЛА"}', { headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/')

    await prepareHost()

    expect(fetchMock).toHaveBeenCalledWith(INSTANCE_CONFIG_URL, { cache: 'no-store' })
  })
})
