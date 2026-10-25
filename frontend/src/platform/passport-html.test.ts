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

function resolveWithRoot(root: string): void {
  plugin.configResolved({ mode: 'production', root, envDir: undefined })
}

function transform(html: string): string {
  return plugin.transformIndexHtml.handler(html)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('passportHtmlDefaults (tz-whitelabel F1)', () => {
  it('an undefined var resolves to the golden default, never a literal placeholder', () => {
    resolveWithRoot(process.cwd())
    vi.stubEnv('VITE_BRAND', undefined)
    vi.stubEnv('VITE_DEFAULT_LOCALE', undefined)
    expect(transform('<html lang="%VITE_DEFAULT_LOCALE%"><title>%VITE_BRAND%</title>')).toBe(
      '<html lang="ru"><title>VELO</title>',
    )
  })

  it('a configured var wins over the default (two .env -> two builds, §2.4)', () => {
    resolveWithRoot(process.cwd())
    vi.stubEnv('VITE_BRAND', 'ШКОЛА')
    vi.stubEnv('VITE_DEFAULT_LOCALE', 'en')
    expect(transform('<html lang="%VITE_DEFAULT_LOCALE%"><title>%VITE_BRAND%</title>')).toBe(
      '<html lang="en"><title>ШКОЛА</title>',
    )
  })

  it('an unknown placeholder is left as is (not our contract, not our business)', () => {
    resolveWithRoot(process.cwd())
    vi.stubEnv('VITE_SOMETHING_ELSE', undefined)
    expect(transform('%VITE_SOMETHING_ELSE%')).toBe('%VITE_SOMETHING_ELSE%')
  })
})
