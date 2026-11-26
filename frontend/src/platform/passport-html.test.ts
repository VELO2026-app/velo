// =============================================================================
// VELO Frontend -- passportHtmlDefaults (tz-whitelabel F1, §2.2)
// =============================================================================
// index.html ships %VELO_BRAND% / %VELO_DEFAULT_LOCALE% passport
// placeholders (FE-153: no longer %VITE_*% -- Vite's own html pass warned on
// every env-less build). The post-transform (build-side seam in
// platform/passport-html.ts) is their only resolver: the VITE_* env var, else
// the golden default. This suite pins that contract: undefined -> golden,
// process.env -> wins, unknown placeholder -> untouched.
// =============================================================================

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { passportHtmlDefaults } from '@/platform/passport-html'
import { CORE_SKIN, type SkinPackage } from '@/platform/skin'
import { fakeSkin } from '@/platform/skin.test.fixture'

// The plugin under Vite's own types is an ObjectHook maze; the test only
// needs its structural shape.
interface HtmlPlugin {
  name: string
  configResolved(config: { mode: string; root: string; envDir?: string }): void
  transformIndexHtml: { order: 'post'; handler: (html: string) => string }
}

const plugin = passportHtmlDefaults() as unknown as HtmlPlugin

// A directory that does not exist: loadEnv finds no .env files there, so the
// suite never reads the developer's real frontend/.env (a local
// VITE_DEFAULT_LOCALE would otherwise flip the golden-default test).
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
  it('no env and no skin: the default lang and the core name, never a literal placeholder', () => {
    resolveWithRoot()
    vi.stubEnv('VITE_DEFAULT_LOCALE', undefined)
    expect(transform('<html lang="%VELO_DEFAULT_LOCALE%"><title>%VELO_BRAND%</title>')).toBe(
      `<html lang="ru"><title>${CORE_SKIN.displayName}</title>`,
    )
  })

  it('a configured lang wins over the default (two .env -> two builds, §2.4)', () => {
    resolveWithRoot()
    vi.stubEnv('VITE_DEFAULT_LOCALE', 'en')
    expect(transform('<html lang="%VELO_DEFAULT_LOCALE%">')).toBe('<html lang="en">')
  })

  it('an unknown placeholder is left as is (not our contract, not our business)', () => {
    resolveWithRoot()
    vi.stubEnv('VITE_SOMETHING_ELSE', undefined)
    expect(transform('%VELO_SOMETHING_ELSE%')).toBe('%VELO_SOMETHING_ELSE%')
    // A VITE_-spelled one is Vite's own html env pass, never this plugin's.
    expect(transform('%VITE_BRAND%')).toBe('%VITE_BRAND%')
  })
})

describe('passportHtmlDefaults -- skin derivatives (tz-whitelabel F2, §1/§3)', () => {
  const FONT_HTML =
    '<!--VELO:FONT--><link href="https://fonts.googleapis.com/css2?family=Marmelad&display=swap" rel="stylesheet" /><!--/VELO:FONT-->'

  it('no skin: %VELO_THEME_COLOR% is the core default, the font block is untouched', () => {
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
      '<meta name="theme-color" content="#4c4c4c" />',
    )
    expect(transformSkin(FONT_HTML)).toBe(FONT_HTML)
  })

  it('a skin: themeColor and the font preload materialize from the brand record (§1 single source)', () => {
    resolveWithRoot()
    const plugin = passportHtmlDefaults(
      fakeSkin({
        displayName: 'ШКОЛА',
        shortName: 'Школа',
        themeColor: '#1B2A41',
        backgroundColor: '#F5F1EA',
        fonts: [
          { family: 'Rubik', file: 'assets/fonts/rubik-400.woff2', weight: 400, style: 'normal' },
        ],
      }),
    )
    const transformSkin = (html: string): string => {
      const hook = (plugin as unknown as HtmlPlugin).transformIndexHtml
      return hook.handler(html)
    }
    expect(transformSkin('<meta name="theme-color" content="%VELO_THEME_COLOR%" />')).toBe(
      '<meta name="theme-color" content="#1B2A41" />',
    )
    const out = transformSkin(FONT_HTML)
    // FE-131: the package's own font, no external request
    expect(out).toContain('href="/skin/assets/fonts/rubik-400.woff2" as="font"')
    expect(out).not.toContain('Marmelad')
    expect(out).not.toContain('googleapis')
    // the tab title is the skin display name (FE-231: its only source)
    expect(transformSkin('<title>%VELO_BRAND%</title>')).toBe('<title>ШКОЛА</title>')
  })

  /** The font block of a skin that ships these faces. */
  function fontBlockOf(fonts: SkinPackage['fonts'], headingWeight: number | null = null): string {
    const plugin = passportHtmlDefaults(
      fakeSkin({
        displayName: 'VELO',
        shortName: 'VELO',
        themeColor: '#334D6E',
        backgroundColor: '#ffffff',
        fonts,
        headingWeight,
      }),
    )
    return (plugin as unknown as HtmlPlugin).transformIndexHtml.handler(FONT_HTML)
  }

  it('several faces: only the regular one is preloaded, the others wait for their @font-face (FE-278)', () => {
    resolveWithRoot()
    const out = fontBlockOf([
      { family: 'VELO Marmelad', file: 'assets/fonts/v-bold.woff2', weight: 700, style: 'normal' },
      { family: 'VELO Marmelad', file: 'assets/fonts/v-light.woff2', weight: 300, style: 'normal' },
      {
        family: 'VELO Marmelad',
        file: 'assets/fonts/v-regular.woff2',
        weight: 400,
        style: 'normal',
      },
      {
        family: 'VELO Marmelad',
        file: 'assets/fonts/v-medium.woff2',
        weight: 500,
        style: 'normal',
      },
    ])
    expect(out).toContain('href="/skin/assets/fonts/v-regular.woff2" as="font"')
    expect(out.match(/rel="preload"/g)).toHaveLength(1)
  })

  /** The golden skin's faces, in a scrambled order. */
  const MARMELAD = [
    { family: 'VELO Marmelad', file: 'assets/fonts/v-bold.woff2', weight: 700, style: 'normal' },
    { family: 'VELO Marmelad', file: 'assets/fonts/v-regular.woff2', weight: 400, style: 'normal' },
    { family: 'VELO Marmelad', file: 'assets/fonts/v-medium.woff2', weight: 500, style: 'normal' },
  ] as SkinPackage['fonts']

  it.each([
    ['the exact face', 500, ['v-regular', 'v-medium']],
    ['the next heavier face when none is exact', 600, ['v-regular', 'v-bold']],
    ['the heaviest face when none is heavier', 800, ['v-regular', 'v-bold']],
    ['Regular alone when headings are Regular too', 400, ['v-regular']],
    ['the regular face when it is the nearest', 300, ['v-regular']],
  ])('headings and Regular are preloaded together: %s (FE-278)', (_, headingWeight, files) => {
    resolveWithRoot()
    const out = fontBlockOf(MARMELAD, headingWeight)
    const preloaded = [...out.matchAll(/href="\/skin\/assets\/fonts\/([\w-]+)\.woff2"/g)].map(
      (m) => m[1],
    )
    expect(preloaded).toEqual(files)
  })

  it('no 400 face (variable fonts): the first file is the one preloaded, not the last (FE-278)', () => {
    resolveWithRoot()
    const out = fontBlockOf([
      { family: 'Manrope', file: 'assets/fonts/manrope.woff2', weight: '200 800', style: 'normal' },
      {
        family: 'Manrope',
        file: 'assets/fonts/manrope-italic.woff2',
        weight: '200 800',
        style: 'italic',
      },
    ])
    expect(out).toContain('href="/skin/assets/fonts/manrope.woff2" as="font"')
    expect(out.match(/rel="preload"/g)).toHaveLength(1)
  })

  it('the display name is escaped and never expands as a replace pattern', () => {
    resolveWithRoot()
    const plugin = passportHtmlDefaults(
      fakeSkin({
        displayName: 'A & B $& <i>',
        shortName: 'AB',
        themeColor: '#1B2A41',
        backgroundColor: '#F5F1EA',
        fonts: [],
      }),
    )
    const hook = (plugin as unknown as HtmlPlugin).transformIndexHtml
    expect(hook.handler('<title>%VELO_BRAND%</title>')).toBe(
      '<title>A &amp; B $&amp; &lt;i&gt;</title>',
    )
  })
})

describe('real index.html font block -- no webfont in the core, the skin brings its own (FE-230)', () => {
  const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
  const run = (skin: Parameters<typeof passportHtmlDefaults>[0]): string => {
    const p = passportHtmlDefaults(skin) as unknown as HtmlPlugin
    p.configResolved({ mode: 'production', root: process.cwd(), envDir: NO_ENV_DIR })
    return p.transformIndexHtml.handler(INDEX_HTML)
  }

  it('the core build preloads no font and requests none from a third party', () => {
    expect(run(null)).not.toContain('googleapis')
  })

  it('skin fonts still replace the block: their preloads in, ours out (FE-131)', () => {
    const out = run(
      fakeSkin({
        displayName: 'ШКОЛА',
        shortName: 'Школа',
        themeColor: '#1B2A41',
        backgroundColor: '#F5F1EA',
        fonts: [
          { family: 'Rubik', file: 'assets/fonts/rubik-400.woff2', weight: 400, style: 'normal' },
        ],
      }),
    )
    expect(out).toContain(
      '<link rel="preload" href="/skin/assets/fonts/rubik-400.woff2" as="font" type="font/woff2" crossorigin />',
    )
    expect(out.match(/rel="preload"/g)).toHaveLength(1)
  })
})
