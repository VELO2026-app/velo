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
