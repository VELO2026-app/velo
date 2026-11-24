// =============================================================================
// VELO Frontend -- the skin's mood icon set: engine rules (contract 2.3, FE-273)
// =============================================================================
// A package may carry the five mood icons in assets/mood/. The engine reads
// each file into a tree of a closed SVG vocabulary (parseMoodSvg) -- the check
// and the build read the same tree, so they cannot disagree. Pinned here: the
// set is optional (a package of any older minor without it reads as before),
// whole or nothing, newer than 2.2, and every file is a well-formed icon of
// the vocabulary: a broken one is a refusal naming the file.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'

import {
  MOOD_KEYS,
  loadSkinPackage,
  parseMoodSvg,
  readGoldenTokens,
} from '../../scripts/lib/skin-package.mjs'
import { MOOD_SCALE_KEYS } from '@/utils/moodScale'
import { cleanupSkinFixtures, moodIconFiles, moodSvg, writeSkinPackage } from './skin.test.fixture'

afterEach(cleanupSkinFixtures)

const GOLDEN = readGoldenTokens(process.cwd())
const MANIFEST_23 = 'schema: 1\ncontract: "2.3"\n'

const load = (extra: Record<string, string>, manifest = MANIFEST_23) =>
  loadSkinPackage(writeSkinPackage({ manifest, extra }), GOLDEN)
/** Problems of a package whose `neutral` icon is `svg` and the rest are valid. */
const problemsWith = (svg: string): string =>
  load({ ...moodIconFiles(), 'assets/mood/neutral.svg': svg }).problems.join('\n')

describe('the mood icon set of a package (contract 2.3)', () => {
  it('five valid icons read into five trees, sized by the client (no width, height or xmlns)', () => {
    const pkg = load(moodIconFiles())
    expect(pkg.problems).toEqual([])
    expect(Object.keys(pkg.moodIcons ?? {})).toEqual(MOOD_KEYS)
    const tree = pkg.moodIcons?.neutral
    expect(tree?.tag).toBe('svg')
    expect(tree?.attrs).toEqual({ viewBox: '4 4 32 32', fill: 'none' })
  })

  it('the file names are the same five keys the mood scale knows', () => {
    expect(MOOD_KEYS).toEqual(MOOD_SCALE_KEYS)
  })

  it('a package without the set reads null on every minor -- 2.0 to 2.3 pass as before', () => {
    for (const minor of ['2.0', '2.1', '2.2', '2.3']) {
      const pkg = loadSkinPackage(
        writeSkinPackage({ manifest: `schema: 1\ncontract: "${minor}"\n` }),
        GOLDEN,
      )
      expect(pkg.problems).toEqual([])
      expect(pkg.moodIcons).toBeNull()
    }
  })

  it('a 2.2 package may not carry it -- a 2.2 reader would refuse the files', () => {
    expect(load(moodIconFiles(), 'schema: 1\ncontract: "2.2"\n').problems).toContain(
      'assets/mood/: the mood icon set needs contract "2.3" or later, got "2.2"',
    )
  })

  it('four icons of five are refused, naming the missing one', () => {
    const files = moodIconFiles()
    delete files['assets/mood/fire.svg']
    expect(load(files).problems.join('\n')).toContain(
      'assets/mood/fire.svg: missing -- the mood icon set (bad, low, neutral, good, fire) ships whole or not at all',
    )
  })

  it('a file outside the five names is not a file of the skin format', () => {
    expect(load({ ...moodIconFiles(), 'assets/mood/happy.svg': moodSvg() }).problems).toContain(
      'assets/mood/happy.svg: not a file of the skin format (primer-package.yaml, tokens/*.tokens.json, assets/...)',
    )
  })

  it('an icon over 128 KiB is refused: the trees travel in a JS chunk', () => {
    const huge = moodSvg(`<path d="M0 0h1" fill="currentColor"/>${' '.repeat(128 * 1024)}`)
    expect(problemsWith(huge)).toContain('assets/mood/neutral.svg: larger than 131072 bytes')
  })
})

describe('one icon file: a closed SVG vocabulary, no half-read file', () => {
  it('the generic SVG rules still apply: a script is refused', () => {
    expect(problemsWith(moodSvg('<script>alert(1)</script><path d="M0 0h1"/>'))).toContain(
      'assets/mood/neutral.svg: has a script',
    )
  })

  it.each([
    ['a truncated file', '<svg viewBox="0 0 10 10"><path d="M0 0h1"/>', '<svg> is never closed'],
    [
      'mismatched tags',
      '<svg viewBox="0 0 10 10"><g><path d="M0 0h1"/></svg></g>',
      '</svg> closes <g>',
    ],
    [
      'text between tags',
      '<svg viewBox="0 0 10 10">hello<path d="M0 0h1"/></svg>',
      'text outside tags',
    ],
    [
      'no viewBox',
      '<svg><path d="M0 0h1"/></svg>',
      'the root <svg> needs a viewBox of four numbers',
    ],
    [
      'a viewBox that is not a square',
      '<svg viewBox="0 0 10 20"><path d="M0 0h1"/></svg>',
      'the viewBox 10 x 20 is not a square',
    ],
    [
      'a gradient that is not in the file',
      '<svg viewBox="0 0 10 10"><path d="M0 0h1" fill="url(#nope)"/></svg>',
      'url(#nope) points at no element of the file',
    ],
    [
      'an element outside the vocabulary',
      '<svg viewBox="0 0 10 10"><path d="M0 0h1"/><image width="1" height="1"/></svg>',
      'the element <image> is not allowed',
    ],
    [
      'an attribute outside the vocabulary',
      '<svg viewBox="0 0 10 10"><path d="M0 0h1" class="x"/></svg>',
      '<path> has the attribute "class", not allowed',
    ],
    [
      'a named color instead of currentColor or a hex',
      '<svg viewBox="0 0 10 10"><path d="M0 0h1" fill="red"/></svg>',
      '<path fill="red">: not a value of that attribute',
    ],
    ['a file that draws nothing', '<svg viewBox="0 0 10 10"></svg>', 'draws nothing'],
    ['not an SVG at all', '<html><body/></html>', 'not an SVG image'],
  ])('%s is refused', (_, svg, reason) => {
    expect(problemsWith(svg)).toContain(`assets/mood/neutral.svg: ${reason}`)
  })

  /** The engine's own reading of a string, error text or null. */
  const errorOf = (svg: string): string | null => {
    const result = parseMoodSvg(svg)
    return 'error' in result ? result.error : null
  }
  const box = (inner: string): string => `<svg viewBox="0 0 10 10">${inner}</svg>`
  const drawn = '<path d="M0 0h1"/>'

  it.each([
    ['a root that is not an svg', '<path d="M0 0h1"/>', 'not an SVG image'],
    ['a closing tag that closes nothing', '</svg>', '</svg> closes nothing'],
    ['a closing tag with content', box('<g></g x="1">'), 'a closing tag </g> with content'],
    [
      'markup after the root closed',
      `${box(drawn)}<svg viewBox="0 0 1 1"/>`,
      'content after the closing </svg>',
    ],
    ['an svg inside the svg', box(`<svg viewBox="0 0 5 5">${drawn}</svg>`), 'a nested <svg>'],
    ['an id declared twice', box(`<g id="a"/><g id="a"/>${drawn}`), 'the id "a" is declared twice'],
    ['an attribute written twice', box('<path d="M0 0h1" d="M1 1h1"/>'), '<path> has "d" twice'],
    [
      'a namespace that is not SVG',
      `<svg xmlns="http://example.test/x" viewBox="0 0 10 10">${drawn}</svg>`,
      'xmlns must be http://www.w3.org/2000/svg on <svg>',
    ],
    ['an unquoted attribute', box('<path d=M0/>'), 'unreadable markup'],
    ['more than 2000 elements', box(drawn.repeat(2000)), 'more than 2000 elements'],
    [
      'nesting deeper than 8',
      box(`${'<g>'.repeat(7)}${drawn}${'</g>'.repeat(7)}`),
      'nested deeper than 8',
    ],
  ])('the reader itself refuses %s', (_, svg, reason) => {
    expect(errorOf(svg)).toContain(reason)
  })

  it('the same reader accepts what the refusals above are not: the limit itself is fine', () => {
    expect(errorOf(box(drawn.repeat(1999)))).toBeNull()
    expect(errorOf(box(`${'<g>'.repeat(6)}${drawn}${'</g>'.repeat(6)}`))).toBeNull()
  })

  it('a file the vocabulary covers passes whatever the tool wrote around it', () => {
    const wrapped = `\uFEFF<?xml version="1.0"?>\n<!-- exported -->\n${moodSvg()}`
    expect(problemsWith(wrapped)).toBe('')
  })

  it('the tree keeps ids and the references to them, and drops what the client sets', () => {
    const result = parseMoodSvg(moodSvg())
    if (!('tree' in result)) throw new Error(result.error)
    const [defs, circle] = result.tree.children ?? []
    expect(defs?.children?.[0]?.attrs?.id).toBe('glow')
    expect(circle?.attrs?.fill).toBe('url(#glow)')
    expect(result.tree.attrs).not.toHaveProperty('width')
  })
})
