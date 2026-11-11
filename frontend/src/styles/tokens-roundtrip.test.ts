// FE-124 track T, step 1: tokens.json is the SOURCE, variables.css is
// GENERATED from it by scripts/generate-variables.mjs. This test pins the
// pipeline BYTE FOR BYTE, so a hand edit to EITHER side goes red until the
// source (tokens.json) and the output agree again. It also proves the
// migration itself lossless: tokens.json was extracted from the original
// hand-written file (scripts/extract-variables-tokens.mjs, one-time) and
// this assertion is the standing proof that nothing was lost or altered.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Paths are cwd-relative (vitest runs from frontend/) -- the brand-grep
// test's idiom; import.meta.url is NOT file-scheme under vitest.
const doc = JSON.parse(readFileSync('tokens.json', 'utf8'))
const css = readFileSync('src/styles/variables.css', 'utf8')

// The *.mjs shim in env.d.ts has no named-export types: dynamic import + cast.
async function generate(): Promise<string> {
  const mod = (await import('../../scripts/generate-variables.mjs')) as unknown as {
    generateVariables: (doc: unknown) => string
  }
  return mod.generateVariables(doc)
}

describe('token pipeline round trip (FE-124 track T)', () => {
  it('variables.css is byte-for-byte the generator output of tokens.json', async () => {
    expect(await generate()).toBe(css)
  })

  it('a $deprecated token gets its note as a comment line above the declaration (FE-150)', async () => {
    // Gen-2 emptied the real registry of deprecated tokens, so the emit is
    // pinned on a miniature: before-lines first, then the note, then the decl.
    const mini = {
      $extensions: {
        pridem: { header: '/* h */\n:root {', trailingComment: [], mediaBlock: '/* m */' },
      },
      root: {
        velo: {
          a: { $value: ' 1px', $extensions: { pridem: { order: 1, cssName: '--velo-a' } } },
          b: {
            $value: ' 2px',
            $deprecated: '2026-11-10: test, delete in Gen-3',
            $extensions: {
              pridem: {
                order: 2,
                cssName: '--velo-b',
                before: ['', '  /* group */'],
                trailing: 'note',
              },
            },
          },
        },
      },
    }
    const mod = (await import('../../scripts/generate-variables.mjs')) as unknown as {
      generateVariables: (doc: unknown) => string
    }
    expect(mod.generateVariables(mini)).toBe(
      [
        '/* h */',
        ':root {',
        '  --velo-a: 1px;',
        '',
        '  /* group */',
        '  /* @deprecated 2026-11-10: test, delete in Gen-3 */',
        '  --velo-b: 2px; /* note */',
        '}',
        '',
        '/* m */',
      ].join('\n'),
    )
  })

  it('tokens.json keeps the DTCG shape the skin packages and Figma share', () => {
    // The skin contract (variables.css, GENERATION 1 section) and step 2 of
    // track T (Figma Variables sync) both speak this document; the root
    // groups the pipeline depends on must exist.
    expect(doc.$extensions?.pridem?.header).toBeTruthy()
    expect(Object.keys(doc.root)).toEqual(['velo', 'bare', '__media'])
  })
})
