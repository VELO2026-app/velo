// =============================================================================
// VELO Frontend -- instance checklist (FE-114, F5.4 / tz-whitelabel §6.4)
// =============================================================================
// The §6.4 acceptance checklist, automated where a machine can see it:
// manifest identity (name/short_name/lang; description reported -- it has no
// passport seam yet), theme-color (index.html meta == manifest == the skin/
// golden source), icons (present + declared dimensions), the bot URL (the
// one the build actually inlined), and the locale set. Every fact carries its
// SOURCE (skin brand.json / passport env / golden default) -- the §6.4
// question "everything from config, nothing in code" is answered by the
// source column.
//
// The maskable safe-zone needs pixel inspection and stays MANUAL (owner's
// acceptance, same as in validate-skin.mjs).
//
// Runs against an EXISTING dist/ produced from the current working tree
// (public/skin/ + .env / process.env are read as the build read them):
//   node scripts/instance-checklist.mjs [distDir]     (default: dist)
// Exit 1 on any FAIL. evaluateChecklist() is exported for the unit suite
// (src/platform/instance-checklist.test.ts).
// =============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv } from 'vite'
import { pngInfo } from './validate-skin.mjs'

// Lazy: under vitest import.meta.url is not file:// (see build-matrix.mjs);
// the unit suite imports this module for evaluateChecklist() only.
const frontendDir = () => resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The §1 priority order the build itself uses: skin brand.json > passport
 *  env (process.env > .env files) > golden default. Returns the expected
 *  values (and, per field, the winning source) every dist fact is checked
 *  against. Pure data -- the unit suite feeds evaluateChecklist() directly. */
export function expectedFromSources() {
  const env = {
    ...loadEnv('production', frontendDir(), 'VITE_'),
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))),
  }
  const brandPath = join(frontendDir(), 'public', 'skin', 'brand.json')
  const skin = existsSync(brandPath) ? JSON.parse(readFileSync(brandPath, 'utf8')) : null
  const pick = (skinValue, envKey, golden) =>
    skinValue !== undefined
      ? { value: skinValue, source: 'skin/brand.json' }
      : env[envKey] !== undefined
        ? { value: env[envKey], source: 'passport env' }
        : { value: golden, source: 'golden default' }
  const brand = skin?.displayName !== undefined ? pick(skin.displayName) : pick(undefined, 'VITE_BRAND', 'VELO')
  return {
    skin,
    brand: brand.value,
    brandSource: brand.source,
    shortBrand: (skin ? pick(skin.shortName) : pick(undefined, 'VITE_BRAND', 'VELO')).value,
    themeColor: pick(skin?.themeColor, undefined, '#334D6E').value,
    themeSource: pick(skin?.themeColor, undefined, '#334D6E').source,
    defaultLocale: pick(undefined, 'VITE_DEFAULT_LOCALE', 'ru').value,
    locales: (env.VITE_LOCALES ?? 'ru').split(',').map((s) => s.trim()).filter(Boolean),
    botUrl: env.VITE_TELEGRAM_BOT_URL || 'https://telegram.me/veloappbot',
    botUrlSource: env.VITE_TELEGRAM_BOT_URL ? 'passport env' : 'golden default',
  }
}

/** Pure evaluation: dist `facts` vs `expected` (expectedFromSources()).
 *  Returns { rows, fails }; status is PASS | FAIL | INFO | MANUAL. */
export function evaluateChecklist({ facts, expected }) {
  const rows = []
  const fails = []
  const add = (item, ok, fact, expect, source) => {
    rows.push({ item, status: ok === true ? 'PASS' : ok === false ? 'FAIL' : ok, fact, expect: expect ?? '-', source: source ?? '-' })
    if (ok === false) fails.push(`${item}: got "${fact}", expected "${expect}"`)
  }

  const m = facts.manifest ?? {}
  add('manifest name', m.name === expected.brand, m.name, expected.brand, expected.brandSource)
  add(
    'manifest short_name',
    m.short_name === expected.shortBrand,
    m.short_name,
    expected.shortBrand,
    expected.brandSource,
  )
  // No passport seam exists for description yet (pwaManifestWithPassport
  // overrides identity+colours only) -- report the fact, don't gate it.
  add('manifest description', 'INFO', m.description, '-', 'golden default (no seam yet)')
  add('manifest lang', m.lang === expected.defaultLocale, m.lang, expected.defaultLocale, 'passport env / golden')
  add(
    'index.html lang',
    facts.htmlLang === expected.defaultLocale,
    facts.htmlLang,
    expected.defaultLocale,
    'passport env / golden',
  )
  add('index.html title', facts.title === expected.brand, facts.title, expected.brand, expected.brandSource)
  add(
    'theme-color (index.html)',
    facts.themeMeta === expected.themeColor,
    facts.themeMeta,
    expected.themeColor,
    expected.themeSource,
  )
  add(
    'theme_color (manifest)',
    m.theme_color === expected.themeColor,
    m.theme_color,
    expected.themeColor,
    expected.themeSource,
  )
  add(
    'theme-color single source',
    facts.themeMeta === m.theme_color,
    `${facts.themeMeta} vs ${m.theme_color}`,
    'equal',
    expected.themeSource,
  )

  // Icons: every manifest entry resolves in dist with the declared size; the
  // iOS home-screen icon and the favicon arrive via index.html, not manifest.
  const iconFails = []
  for (const icon of m.icons ?? []) {
    const info = facts.distIcons[icon.src]
    if (!info) {
      iconFails.push(`${icon.src} missing from dist`)
      continue
    }
    if (info === 'svg') continue
    const [w, h] = icon.sizes.split('x').map(Number)
    if (info.width !== w || info.height !== h) iconFails.push(`${icon.src}: ${info.width}x${info.height}`)
  }
  const apple = facts.distIcons['/icons/apple-touch-icon-180.png']
  if (!apple) iconFails.push('apple-touch-icon-180.png missing (index.html link)')
  else if (apple !== 'svg' && (apple.width !== 180 || apple.height !== 180))
    iconFails.push(`apple-touch-icon-180.png: ${apple.width}x${apple.height}`)
  if (!facts.distIcons['/icons/favicon.svg']) iconFails.push('favicon.svg missing (index.html link)')
  add(
    'icons',
    iconFails.length === 0,
    iconFails.length === 0 ? `${(m.icons ?? []).length} manifest entries + iOS/favicon` : iconFails.join('; '),
    'present, declared sizes',
    'skin assets / golden',
  )

  add(
    'bot URL (inlined)',
    facts.botUrlFound,
    facts.botUrlFound ? expected.botUrl : `${expected.botUrl} NOT found in dist JS`,
    'present in dist JS',
    expected.botUrlSource,
  )
  add(
    'locales',
    'INFO',
    `default ${expected.defaultLocale}; passport ${expected.locales.join(',')}; catalogs shipped: ${facts.catalogs.join(',')}`,
    '-',
    'passport env + src/locales',
  )
  rows.push({
    item: 'maskable safe-zone',
    status: 'MANUAL',
    fact: 'icon-maskable-512.png: the 80% safe zone needs pixel inspection',
    expect: '-',
    source: "owner's acceptance",
  })
  return { rows, fails }
}

// -- CLI ----------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const distDir = resolve(frontendDir(), process.argv[2] ?? 'dist')
  if (!existsSync(join(distDir, 'index.html'))) {
    console.error(`instance-checklist: no index.html in ${distDir} -- build first (pnpm build)`)
    process.exit(1)
  }

  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const distIcons = {}
  const iconsDir = join(distDir, 'icons')
  if (existsSync(iconsDir)) {
    for (const name of readdirSync(iconsDir)) {
      const p = `/icons/${name}`
      if (name.endsWith('.svg')) distIcons[p] = 'svg'
      else {
        const info = pngInfo(join(iconsDir, name))
        if (info) distIcons[p] = info
      }
    }
  }
  // The bot URL is inlined into the JS bundle via INSTANCE.telegramBotUrl.
  const expected = expectedFromSources()
  const js = existsSync(join(distDir, 'assets'))
    ? readdirSync(join(distDir, 'assets'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(distDir, 'assets', f), 'utf8'))
        .join('\n')
    : ''
  const localesDir = join(frontendDir(), 'src', 'locales')
  const catalogs = existsSync(localesDir) ? readdirSync(localesDir).filter((n) => !n.endsWith('.ts')) : []

  const { rows, fails } = evaluateChecklist({
    facts: {
      title: html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '?',
      htmlLang: html.match(/<html lang="([^"]*)/)?.[1] ?? '?',
      themeMeta: html.match(/theme-color" content="([^"]*)/)?.[1] ?? '?',
      manifest: existsSync(join(distDir, 'manifest.webmanifest'))
        ? JSON.parse(readFileSync(join(distDir, 'manifest.webmanifest'), 'utf8'))
        : {},
      distIcons,
      botUrlFound: js.includes(expected.botUrl),
      catalogs,
    },
    expected,
  })

  const widths = [34, 7, 46, 26]
  console.log(
    rows
      .map((r) =>
        [r.item, r.status, r.fact, r.expect, r.source]
          .map((v, i) => String(v).slice(0, widths[i] ?? 20).padEnd(widths[i] ?? 20))
          .join('  '),
      )
      .join('\n'),
  )
  if (fails.length > 0) {
    console.error(`\ninstance-checklist: ${fails.length} FAIL(s):`)
    for (const f of fails) console.error('  FAIL ' + f)
    process.exit(1)
  }
  console.log('\ninstance-checklist: green (maskable safe-zone stays MANUAL)')
}
