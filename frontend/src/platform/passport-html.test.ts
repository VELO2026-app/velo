// =============================================================================
// VELO Frontend -- passportHtmlDefaults (tz-whitelabel F1, §2.2)
// =============================================================================
// index.html ships %VITE_*% passport placeholders; Vite replaces only DEFINED
// env vars, and CI builds without a .env. The post-transform (build-side
// seam in platform/passport-html.ts) resolves the leftovers to the golden
// defaults. This suite pins that contract: undefined -> golden,
// process.env -> wins, unknown placeholder -> untouched.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

import { passportHtmlDefaults } from '@/platform/passport-html'

// The plugin under Vite's own types is an ObjectHook maze; the test only
// needs its structural shape.
interface HtmlPlugin {
  name: string
  configResolved(config: { mode: string; root: string; envDir?: string }): void
  transformIndexHtml: { order: 'post'; handler: (html: string) => string }
}

const plugin = passportHtmlDefaults() as unknown as HtmlPlugin

// A directory that does not exist: loadEnv finds no .env files there, so the
// suite never reads the developer's real frontend/.env (a local VITE_BRAND
// would otherwise flip the golden-default test).
const NO_ENV_DIR = new URL('./passport-html-test-env/', import.meta.url).pathname

function resolveWithRoot(): void {
  plugin.configResolved({ mode: 'production', root: process.cwd(), envDir: NO_ENV_DIR })
}

function transform(html: string): string {
  return plugin.transformIndexHtml.handler(html)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('passportHtmlDefaults (tz-whitelabel F1)', () => {
  it('an undefined var resolves to the golden default, never a literal placeholder', () => {
    resolveWithRoot()
    vi.stubEnv('VITE_BRAND', undefined)
    vi.stubEnv('VITE_DEFAULT_LOCALE', undefined)
    expect(transform('<html lang="%VITE_DEFAULT_LOCALE%"><title>%VITE_BRAND%</title>')).toBe(
      '<html lang="ru"><title>VELO</title>',
    )
  })

  it('a configured var wins over the default (two .env -> two builds, §2.4)', () => {
    resolveWithRoot()
    vi.stubEnv('VITE_BRAND', 'ШКОЛА')
    vi.stubEnv('VITE_DEFAULT_LOCALE', 'en')
    expect(transform('<html lang="%VITE_DEFAULT_LOCALE%"><title>%VITE_BRAND%</title>')).toBe(
      '<html lang="en"><title>ШКОЛА</title>',
    )
  })

  it('an unknown placeholder is left as is (not our contract, not our business)', () => {
    resolveWithRoot()
    vi.stubEnv('VITE_SOMETHING_ELSE', undefined)
    expect(transform('%VITE_SOMETHING_ELSE%')).toBe('%VITE_SOMETHING_ELSE%')
  })
})

describe('passportHtmlDefaults -- skin derivatives (tz-whitelabel F2, §1/§3)', () => {
  const FONT_HTML =
    '<!--VELO:FONT--><link href="https://fonts.googleapis.com/css2?family=Marmelad&display=swap" rel="stylesheet" /><!--/VELO:FONT-->'

  it('no skin: %VELO_THEME_COLOR% is the golden default, the font block is untouched', () => {
    resolveWithRoot()
    const plugin = passportHtmlDefaults()
    ;(plugin as unknown as HtmlPlugin).configResolved({
      mode: 'production',
      root: process.cwd(),
      envDir: NO_ENV_DIR,
    })
    const transformSkin = (html: string): string => {
      const hook = (plugin as unknown as HtmlPlugin).transformIndexHtml
      return hook.handler(html)
    }
    expect(transformSkin('<meta name="theme-color" content="%VELO_THEME_COLOR%" />')).toBe(
      '<meta name="theme-color" content="#334D6E" />',
    )
    expect(transformSkin(FONT_HTML)).toBe(FONT_HTML)
  })

  it('a skin: themeColor and the font link materialize from brand.json (§1 single source)', () => {
    resolveWithRoot()
    const plugin = passportHtmlDefaults({
      displayName: 'ШКОЛА',
      shortName: 'Школа',
      themeColor: '#1B2A41',
      backgroundColor: '#F5F1EA',
      fontUrl: 'https://fonts.example.com/rubik.css',
    })
    const transformSkin = (html: string): string => {
      const hook = (plugin as unknown as HtmlPlugin).transformIndexHtml
      return hook.handler(html)
    }
    expect(transformSkin('<meta name="theme-color" content="%VELO_THEME_COLOR%" />')).toBe(
      '<meta name="theme-color" content="#1B2A41" />',
    )
    const out = transformSkin(FONT_HTML)
    expect(out).toContain('https://fonts.example.com/rubik.css')
    expect(out).not.toContain('Marmelad')
  })
})
