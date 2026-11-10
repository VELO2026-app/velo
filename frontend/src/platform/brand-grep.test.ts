// =============================================================================
// VELO Frontend -- brand-grep gate tests (tz-whitelabel §6.3, FE-114)
// =============================================================================
// brandGrepReport() is the pnpm lint grep gate: the brand word outside the
// reference set, and feature-flag sources outside the registry. Pinned here:
// synthetic violations fire, the sanctioned carriers stay clean, and the
// repo's own tree passes (same philosophy as validate-skin.test.ts pinning
// the reference skins).
// =============================================================================

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Plain ESM module (types loosely declared in env.d.ts).
// @ts-expect-error -- *.mjs modules carry no type information
import { brandGrepReport } from '../../scripts/brand-grep.mjs'

type Report = { brand: string[]; features: string[] }

const scan = (files: Array<[string, string]>): Report =>
  brandGrepReport(files.map(([path, content]) => ({ path, content }))) as Report

describe('brand-grep: the brand word (tz-i18n §7.2.3)', () => {
  it('a VELO literal in a view string/template/attr is a hit', () => {
    const report = scan([
      [
        'src/views/user/SomeView.vue',
        'const a = \'Войти в VELO\'\nconst b = "VELO"\nconst c = `Поддержка VELO`',
      ],
      [
        'src/views/user/TplView.vue',
        '<template>\n  <h1>Поддержка VELO</h1>\n  <span aria-label="VELO">x</span>\n</template>',
      ],
    ])
    expect(report.brand.length).toBe(5)
    expect(report.brand.every((h) => h.includes('VELO')))
  })

  it('comments, headers and non-user identifiers are not user strings', () => {
    const report = scan([
      [
        'src/composables/x.ts',
        "// VELO Frontend -- x\n/* VELO block */\nconst CLOSE_VELOCITY = 1\nconst url = 'https://.../veloappbot'",
      ],
      [
        'src/views/y.vue',
        '<template>\n  <!-- VELO Frontend header -->\n  <i class="velo-word-filled" />\n</template>',
      ],
    ])
    expect(report.brand).toEqual([])
  })

  it('the reference set carries the brand by contract', () => {
    const report = scan([
      [
        'src/locales/ru/common.json',
        '{ "brandName": "@:brand", "_comment": "VELO Frontend -- ru" }',
      ],
      ['src/pwa/manifest.ts', "export const pwaManifest = { name: 'VELO', short_name: 'VELO' }"],
      ['src/platform/skin.ts', "export const GOLDEN_SKIN = { displayName: 'VELO' }"],
      ['src/platform/instance.ts', "brand: import.meta.env.VITE_BRAND ?? 'VELO',"],
    ])
    expect(report.brand).toEqual([])
  })

  it('build-seam markers are technical tokens, not brand copy', () => {
    const report = scan([
      [
        'src/platform/passport-html.ts',
        "const a = '<!--VELO:FONT-->'\nconst b = '<!--/VELO:FONT-->'\nhtml.replace(/%VELO_THEME_COLOR%/g, x)",
      ],
      ['src/other.ts', "const name = `__VELO_FEATURE_${x}__`\nconst lit = '__VELO_FEATURE_AI__'"],
    ])
    expect(report.brand).toEqual([])
  })
})

describe('brand-grep: the feature registry monopoly (tz-whitelabel §4)', () => {
  it('a VITE_FEATURES read outside the registry is a hit', () => {
    const report = scan([
      [
        'src/views/user/SomeView.vue',
        "const on = (import.meta.env.VITE_FEATURES ?? '').includes('payments')",
      ],
    ])
    expect(report.features).toHaveLength(1)
    expect(report.features[0]).toContain('VITE_FEATURES outside the registry')
  })

  it('a gate literal outside router/index.ts is a hit', () => {
    const report = scan([
      ['src/views/user/GateView.vue', 'const routes = __VELO_FEATURE_PAYMENTS__ ? r : []'],
    ])
    expect(report.features).toHaveLength(1)
    expect(report.features[0]).toContain('__VELO_FEATURE_PAYMENTS__')
  })

  it('featureDefines materialized outside the vite configs is a hit', () => {
    const report = scan([
      [
        'src/worker/preview.ts',
        "import { featureDefines } from '@/platform/features'\nconst d = featureDefines('ai')",
      ],
    ])
    expect(report.features).toHaveLength(1)
    expect(report.features[0]).toContain('featureDefines')
  })

  it('the sanctioned readers stay clean', () => {
    const report = scan([
      [
        'src/platform/features.ts',
        'export function featureEnabled(n) { return featureFlags(import.meta.env.VITE_FEATURES)[n] }\nconst k = `__VELO_FEATURE_${name}__`',
      ],
      ['src/platform/instance.ts', 'features: parseFeatures(import.meta.env.VITE_FEATURES),'],
      ['src/router/index.ts', '...(__VELO_FEATURE_PAYMENTS__ ? PAYMENTS_USER_ROUTES : []),'],
      ['env.d.ts', 'declare const __VELO_FEATURE_AI__: boolean\nreadonly VITE_FEATURES?: string'],
      ['vite.config.ts', 'const defines = featureDefines(instanceEnv.VITE_FEATURES)'],
      ['vitest.config.ts', 'define: featureDefines(undefined),'],
    ])
    expect(report.features).toEqual([])
  })

  it('a commented-out flag stays a comment, not a violation', () => {
    const report = scan([
      [
        'src/views/user/SomeView.vue',
        "// const on = import.meta.env.VITE_FEATURES.includes('payments')",
      ],
    ])
    expect(report.features).toEqual([])
  })
})

describe('brand-grep: the repo tree', () => {
  it('passes both gates today', () => {
    const files: Array<{ path: string; content: string }> = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|vue)$/.test(name) && !name.includes('.test.'))
          files.push({ path: p.replaceAll('\\', '/'), content: readFileSync(p, 'utf8') })
      }
    }
    walk('src')
    for (const p of ['env.d.ts', 'vite.config.ts', 'vitest.config.ts'])
      files.push({ path: p, content: readFileSync(p, 'utf8') })

    const report = brandGrepReport(files) as Report
    expect(report.brand).toEqual([])
    expect(report.features).toEqual([])
  })
})
