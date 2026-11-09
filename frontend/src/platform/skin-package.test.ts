// =============================================================================
// VELO Frontend -- skin package engine + gen-1 converter tests (FE-131)
// =============================================================================
// scripts/lib/skin-package.mjs reads the deploy machine's package format
// (primer-package.yaml + DTCG tokens + assets) and converts it to the CSS the
// build ships; scripts/skin-to-dtcg.mjs migrates a generation-1 skin into it.
// Pinned here: the manifest rules of contract 3 (a quoted point, schema 1),
// the "data only" file rule, DTCG value forms, and the conversion round trip
// -- a gen-1 tokens.css and the CSS of its converted package declare the SAME
// overrides, so the migration changes no pixel.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  goldenTokenMap,
  loadSkinPackage,
  parseManifest,
  readGoldenTokens,
  skinCss,
} from '../../scripts/lib/skin-package.mjs'
// @ts-expect-error -- *.mjs modules carry no type information
import { parseFlatTokens, writePackage } from '../../scripts/skin-to-dtcg.mjs'
import { cleanupSkinFixtures, png, tempDir, writeSkinPackage } from './skin.test.fixture'

afterEach(cleanupSkinFixtures)

const FRONTEND = process.cwd()
const GOLDEN = readGoldenTokens(FRONTEND)
const problemsOf = (dir: string): string => loadSkinPackage(dir, GOLDEN).problems.join('\n')

describe('primer-package.yaml (contract 3 rule 10)', () => {
  it('reads the block form, comments included', () => {
    expect(parseManifest('# a skin\nschema: 1\ncontract: "1.0" # point\n').fields).toEqual({
      schema: '1',
      contract: '"1.0"',
    })
  })

  it('the contract is a quoted point of major 1', () => {
    expect(problemsOf(writeSkinPackage({ manifest: 'schema: 1\ncontract: 1.0\n' }))).toContain(
      'contract must be a quoted point',
    )
    expect(problemsOf(writeSkinPackage({ manifest: 'schema: 1\ncontract: ">=1,<2"\n' }))).toContain(
      'contract must be a quoted point',
    )
    expect(problemsOf(writeSkinPackage({ manifest: 'schema: 1\ncontract: "2.0"\n' }))).toContain(
      'this product reads contract 1.x',
    )
    expect(problemsOf(writeSkinPackage({ manifest: 'schema: 2\ncontract: "1.0"\n' }))).toContain(
      'schema must be 1',
    )
  })
})

describe('the package is data (no code, nothing else)', () => {
  it('an unknown file, an executable and a symlink are refused', () => {
    const dir = writeSkinPackage({ extra: { 'build.sh': 'echo', 'assets/Logo.SVG': '<svg/>' } })
    chmodSync(join(dir, 'build.sh'), 0o755)
    symlinkSync('/etc/hosts', join(dir, 'assets', 'link.svg'))
    const problems = problemsOf(dir)
    expect(problems).toContain('build.sh: not a file of the skin format')
    expect(problems).toContain('build.sh: executable')
    expect(problems).toContain('assets/Logo.SVG: not a file of the skin format')
    expect(problems).toContain('assets/link.svg: a symlink')
  })

  it('OS litter (.DS_Store) is read past, not refused', () => {
    const dir = writeSkinPackage({ extra: { '.DS_Store': 'x', 'assets/.DS_Store': 'x' } })
    expect(problemsOf(dir)).toBe('')
  })

  it.each([
    ['<svg><script>alert(1)</script></svg>', 'has a script'],
    ['<svg onload="alert(1)"/>', 'has an event handler'],
    ['<svg><a href="https://evil.example">x</a></svg>', 'has a link out of the file'],
    ['<svg style="fill:url(https://evil.example/x)"/>', 'has a url() out of the file'],
    ['<svg><foreignObject/></svg>', 'has foreignObject'],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', 'not an SVG image'],
    ['<html></html>', 'not an SVG image'],
    // review bypasses: a prefix, an entity, CSS in <style>, animation, src=
    [
      '<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
      'has a namespace-prefixed element',
    ],
    [
      '<svg><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="https://evil"/></svg>',
      'has a namespace-prefixed element',
    ],
    [
      '<svg><a><animate attributeName="href" values="javascr&#105;pt:alert(1)"/></a></svg>',
      'has a numeric character reference',
    ],
    ['<svg><a><set attributeName="href" to="#x"/></a></svg>', 'has an animation element'],
    ['<svg><style>rect{fill:u\\72l(https://evil/x)}</style></svg>', 'has a <style> element'],
    ['<svg><rect style="fill:image-set(x 1x)"/></svg>', 'has a style attribute'],
    ['<svg><image src="https://evil/x.png"/></svg>', 'has a src attribute'],
  ])('an unsafe SVG is refused: %s', (svg, reason) => {
    const dir = writeSkinPackage({ extra: { 'assets/logo-white.svg': svg } })
    expect(problemsOf(dir)).toContain(`assets/logo-white.svg: ${reason}`)
  })

  it('a local fragment link in an SVG is fine', () => {
    const svg =
      '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>'
    expect(problemsOf(writeSkinPackage({ extra: { 'assets/logo-white.svg': svg } }))).toBe('')
  })

  it('markup in the display name is refused (it lands in index.html)', () => {
    const dir = writeSkinPackage({
      brand: {
        displayName: '</title><script>alert(1)</script>',
        shortName: 'X',
        themeColor: '#1b2a41',
        backgroundColor: '#ffffff',
      },
    })
    expect(problemsOf(dir)).toContain('displayName: no < > & " or control characters')
  })

  it('optional asset dirs and a README pass', () => {
    const dir = writeSkinPackage({
      bg: true,
      extra: { 'README.md': '# skin', 'assets/onboarding/master-space.svg': '<svg/>' },
    })
    expect(problemsOf(dir)).toBe('')
  })

  it('a missing mandatory asset is named', () => {
    const dir = writeSkinPackage()
    writeFileSync(join(dir, 'assets', 'icon-192.png'), png(192, 192))
    expect(problemsOf(dir)).toBe('')
    const bare = tempDir('velo-skin-bare-')
    writeFileSync(join(bare, 'primer-package.yaml'), 'schema: 1\ncontract: "1.0"\n')
    expect(problemsOf(bare)).toContain('assets/logo-white.svg: missing')
    expect(problemsOf(bare)).toContain('no brand record')
  })
})

describe('DTCG values -> CSS', () => {
  it('verbatim CSS, references, numbers and family lists', () => {
    const dir = writeSkinPackage({
      tokens: {
        velo: {
          tg: { header: { $value: '#1b2a41' } },
          primary: { $value: 'rgba(44, 74, 110, 0.9)', dark: { $value: '{velo.tg.header}' } },
        },
        bare: { 'font-body': { $value: ['Rubik', 'sans-serif'] } },
      },
    })
    const pkg = loadSkinPackage(dir, GOLDEN)
    expect(pkg.problems).toEqual([])
    // golden cascade order: primary, primary-dark come before tg-header
    expect(pkg.decls.map(([name]) => name).slice(0, 2)).toEqual([
      '--velo-primary',
      '--velo-primary-dark',
    ])
    const css = skinCss(pkg)
    expect(css).toContain('  --velo-primary: rgba(44, 74, 110, 0.9);')
    expect(css).toContain('  --velo-primary-dark: var(--velo-tg-header);')
    expect(css).toContain('  --font-body: Rubik, sans-serif;')
  })

  it('a value that would break out of its declaration is refused', () => {
    const dir = writeSkinPackage({
      tokens: { velo: { primary: { $value: 'red; } body { display: none' } } },
    })
    expect(problemsOf(dir)).toContain('no quotes, backslashes')
  })

  it.each([
    ['image-set("https://evil.example/t.png" 1x)', 'no quotes'],
    ['image-set(x 1x)', 'the function image-set() is not allowed'],
    ['url(https://evil.example/t.png)', 'only letters, digits'],
    ['url(evil.example/t.png)', 'the function url() is not allowed'],
    ['u\\72l(https://evil.example/t.png)', 'no quotes, backslashes'],
    ['red /*', 'no CSS comments'],
    ['rgba(0, 0, 0', 'unbalanced parentheses'],
  ])('a request or a breakout in a value is refused: %s', (value, reason) => {
    const dir = writeSkinPackage({ tokens: { velo: { primary: { $value: value } } } })
    expect(problemsOf(dir)).toContain(reason)
  })

  it('every golden value is a valid skin value (the alphabet does not cut real skins)', () => {
    const doc: Record<string, unknown> = {}
    for (const [path, token] of goldenTokenMap(GOLDEN)) {
      if (!path.startsWith('velo.') && path !== 'bare.font-body') continue
      let node = doc
      for (const key of path.split('.')) node = (node[key] ??= {}) as Record<string, unknown>
      node.$value = token.value
    }
    const dir = writeSkinPackage({
      tokens: doc,
      brand: {
        displayName: 'X',
        shortName: 'X',
        themeColor: '#334d6e',
        backgroundColor: '#ffffff',
      },
    })
    expect(problemsOf(dir)).toBe('')
  })

  it.each([
    ['a newline', ['Rubik', 'x\n} body { background: red } :root { --z: 1']],
    ['a backslash', ['a\\', '} body { background: red } :root { --z: y']],
    ['a quote', ["x', serif; } body {"]],
  ])('a font family list cannot inject CSS (%s)', (_, list) => {
    const dir = writeSkinPackage({
      tokens: {
        velo: { tg: { header: { $value: '#1b2a41' } } },
        bare: { 'font-body': { $value: list } },
      },
    })
    expect(problemsOf(dir)).toContain('is not a plain family name')
  })

  it('the CSS string form of a family list is parsed and checked name by name', () => {
    const dir = writeSkinPackage({
      tokens: {
        velo: { tg: { header: { $value: '#1b2a41' } } },
        bare: { 'font-body': { $value: `'Rubik', "Noto Sans", sans-serif` } },
      },
    })
    const pkg = loadSkinPackage(dir, GOLDEN)
    expect(pkg.problems).toEqual([])
    expect(skinCss(pkg)).toContain("  --font-body: Rubik, 'Noto Sans', sans-serif;")
  })

  it.each([
    ['a self-reference', { velo: { primary: { $value: '{velo.primary}' } } }],
    [
      'a cycle through two tokens',
      {
        velo: {
          primary: { $value: '{velo.text.primary}' },
          text: { primary: { $value: 'var(--velo-primary)' } },
        },
      },
    ],
    // golden --velo-glass-border is var(--velo-white): close the loop
    [
      'a cycle through a golden var() chain',
      { velo: { white: { $value: '{velo.glass.border}' } } },
    ],
  ])('%s is refused (the color would silently vanish)', (_, tokens) => {
    expect(problemsOf(writeSkinPackage({ tokens }))).toContain('a reference cycle')
  })

  it('a dangling reference and a duplicate path are named', () => {
    const dir = writeSkinPackage({
      tokens: { velo: { primary: { $value: '#000', dark: { $value: '{velo.nope}' } } } },
      extra: {
        'tokens/more.tokens.json': JSON.stringify({ velo: { primary: { $value: '#111' } } }),
      },
    })
    const problems = problemsOf(dir)
    expect(problems).toContain('reference {velo.nope} names no token')
    expect(problems).toContain('velo.primary: declared twice')
  })
})

/** 'Marmelad' and Marmelad name the same family: compare without the quotes
 *  a one-word name does not need. */
const unquote = (decl: string): string => decl.replace(/'([A-Za-z-]+)'/g, '$1')

describe('skin-to-dtcg: generation 1 -> package, no pixel changes', () => {
  /** A gen-1 skin carrying the shapes the old reference skins used. */
  function gen1(fontUrl?: string): string {
    const dir = tempDir('velo-gen1-')
    writeFileSync(
      join(dir, 'brand.json'),
      JSON.stringify({
        displayName: 'Contrast',
        shortName: 'Contrast',
        themeColor: '#14213d',
        backgroundColor: '#ffffff',
        ...(fontUrl ? { fontUrl } : {}),
      }),
    )
    writeFileSync(
      join(dir, 'tokens.css'),
      [
        '/* a high-contrast reference skin */',
        '--velo-tg-header: #14213d;',
        '--velo-primary: #fca311;',
        '--velo-primary-dark: #e5940f;',
        '--velo-text-primary: #000000;',
        '--velo-nav-active-bg: rgba(252, 163, 17, 0.25);',
        '--velo-glass-border: rgba(255, 255, 255, 0.55);',
        "--font-body: 'Marmelad', 'Noto Sans', sans-serif;",
      ].join('\n'),
    )
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    for (const name of ['velo-word-filled', 'velo-word-blue', 'logo-white', 'favicon'])
      writeFileSync(join(dir, `${name}.svg`), svg)
    for (const [name, size] of [
      ['mandala-white', 64],
      ['mandala-blue', 64],
      ['icon-192', 192],
      ['icon-512', 512],
      ['icon-maskable-512', 512],
    ] as const)
      writeFileSync(join(dir, `${name}.png`), png(size, size, 6))
    writeFileSync(join(dir, 'apple-touch-icon-180.png'), png(180, 180, 2))
    mkdirSync(join(dir, 'bg'))
    writeFileSync(join(dir, 'bg', 'background.png'), png(1080, 1920))
    return dir
  }

  it('the converted package declares exactly the gen-1 overrides', () => {
    const from = gen1()
    const out = join(tempDir('velo-dtcg-'), 'pkg')
    const pkg = writePackage(from, out, FRONTEND)
    const before = (parseFlatTokens(readFileSync(join(from, 'tokens.css'), 'utf8')) as string[][])
      .map(([n, v]) => unquote(`${n}: ${v}`))
      .sort()
    const after = pkg.decls.map(([n, v]: [string, string]) => unquote(`${n}: ${v}`)).sort()
    expect(after).toEqual(before)
    // paths come from tokens.json, not string surgery
    const doc = JSON.parse(readFileSync(join(out, 'tokens', 'skin.tokens.json'), 'utf8'))
    expect(doc.velo.primary.dark.$value).toBe('#e5940f')
    expect(doc.velo.nav.active.bg.$value).toBe('rgba(252, 163, 17, 0.25)')
    expect(doc.bare['font-body'].$value).toBe("'Marmelad', 'Noto Sans', sans-serif")
    // the brand record moved into the package's data carrier
    const brand = JSON.parse(readFileSync(join(out, 'tokens', 'brand.tokens.json'), 'utf8'))
    expect(brand.$extensions['velo-skin'].displayName).toBe('Contrast')
    expect(readFileSync(join(out, 'primer-package.yaml'), 'utf8')).toContain('contract: "1.0"')
    expect(pkg.files).toContain('assets/bg/background.png')
  })

  it('a gen-1 fontUrl stops the conversion: self-host the font', () => {
    const from = gen1('https://fonts.googleapis.com/css2?family=Rubik')
    const out = join(tempDir('velo-dtcg-'), 'pkg')
    expect(() => writePackage(from, out, FRONTEND)).toThrow(/no external request/)
  })

  it('an unknown gen-1 token stops the conversion, named', () => {
    const from = gen1()
    writeFileSync(join(from, 'tokens.css'), '--velo-primari: #000;\n--space-1: 2px;\n')
    const out = join(tempDir('velo-dtcg-'), 'pkg')
    expect(() => writePackage(from, out, FRONTEND)).toThrow(
      /--velo-primari: not a token[\s\S]*--space-1: a frozen bare/,
    )
  })
})
