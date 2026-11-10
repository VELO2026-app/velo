// =============================================================================
// FE-150 -- token usage audit: unit tests on a miniature registry, plus the
// standing guard on the real tree (node:test; part of `pnpm test`).
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditTokens,
  auditViolations,
  readTree,
  stripCssComments,
  stripJsComments,
  stripVueComments,
} from './token-audit.mjs'

const leaf = (cssName, value, order, extra = {}) => ({
  $value: ` ${value}`,
  ...extra,
  $extensions: { pridem: { cssName, order } },
})

const DOC = {
  root: {
    velo: {
      blue: leaf('--velo-blue', '#627a9c', 1),
      primary: leaf('--velo-primary', 'var(--velo-blue)', 2),
      pink: leaf('--velo-pink', '#f795a2', 3),
      orphan: leaf('--velo-orphan', 'var(--velo-pink)', 4),
      fog: { pd: { top: leaf('--velo-fog-pd-top', '25px', 5) } },
      tg: leaf('--velo-tg-bg', '#ffffff', 6),
      prose: leaf('--velo-prose', '1px', 7),
      tested: leaf('--velo-tested', '2px', 8),
      old: leaf('--velo-old', '3px', 9, { $deprecated: '2026-11-09: test, delete in Gen-2' }),
    },
  },
}

const FILES = [
  {
    file: 'src/A.vue',
    src: '<template><!-- var(--velo-prose) --></template>\n<style>.a { color: var(--velo-primary); }</style>',
  },
  {
    file: 'src/b.ts',
    src: "tokenColor('--velo-tg-bg', '#fff') // --velo-prose\nconst x = `--velo-fog-pd-${name}`",
  },
  { file: 'src/c.css', src: '/* --velo-prose */ .c { background: url(https://x/y.png); }' },
  { file: 'src/d.test.ts', src: "expect(css).toContain('--velo-tested')" },
]

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.cssName, r]))

test('direct, by-name, dynamic and chained consumers make a token alive', () => {
  const rows = byName(auditTokens(DOC, FILES))
  assert.equal(rows['--velo-primary'].prod, 1)
  assert.equal(rows['--velo-primary'].alive, true)
  assert.equal(rows['--velo-blue'].alive, true, 'primitive behind an alive alias')
  assert.equal(rows['--velo-tg-bg'].alive, true, 'tokenColor by-name read')
  assert.equal(rows['--velo-fog-pd-top'].dynamic, true, 'template-literal prefix')
  assert.equal(rows['--velo-fog-pd-top'].alive, true)
})

test('comments, tests and dead aliases do not keep a token alive', () => {
  const rows = byName(auditTokens(DOC, FILES))
  assert.equal(rows['--velo-prose'].prod, 0, 'named only in html/js/css comments')
  assert.equal(rows['--velo-tested'].test, 1)
  assert.equal(rows['--velo-tested'].alive, false, 'a test is not a product consumer')
  assert.equal(rows['--velo-orphan'].alive, false)
  assert.equal(rows['--velo-pink'].alive, false, 'referenced only by a dead alias')
})

test('violations: dead and undeprecated is red; deprecated and consumed is red', () => {
  const v = auditViolations(auditTokens(DOC, FILES))
  for (const name of ['--velo-prose', '--velo-tested', '--velo-orphan', '--velo-pink'])
    assert.ok(
      v.some((line) => line.startsWith(`${name} has no consumer`)),
      name,
    )
  assert.ok(!v.some((line) => line.startsWith('--velo-old')), 'dead + deprecated is the goal state')

  const consumed = [...FILES, { file: 'src/e.css', src: '.e { width: var(--velo-old); }' }]
  const v2 = auditViolations(auditTokens(DOC, consumed))
  assert.ok(
    v2.some((line) => line.startsWith('--velo-old is $deprecated but consumed by src/e.css')),
  )
})

test('strippers: CSS keeps //, JS keeps strings, a "-->"-closed CSS comment runs on', () => {
  assert.match(stripCssComments('a { b: url(//cdn/x); }'), /url\(\/\/cdn\/x\)/)
  assert.match(stripJsComments("const u = 'https://x/*' // c\n"), /'https:\/\/x\/\*'/)
  // The ReportUserSheet defect: the browser reads the rule as comment text.
  const vue = '<style>\n/* note -->\n.a { r: var(--velo-x); }\n/* next */\n.b {}\n</style>'
  assert.doesNotMatch(stripVueComments(vue), /--velo-x/)
  assert.match(stripVueComments(vue), /\.b \{\}/)
})

test('a dynamic builder in a test, or one wide enough to blanket a branch, keeps nothing alive', () => {
  // In a test: the builder is not product code (src/b.ts, the product
  // builder of the miniature, is left out here).
  const inTest = byName(
    auditTokens(DOC, [{ file: 'src/z.test.ts', src: 'const v = `--velo-fog-pd-${n}`' }]),
  )
  assert.equal(inTest['--velo-fog-pd-top'].dynamic, false)
  assert.equal(inTest['--velo-fog-pd-top'].alive, false)
  // A blanket: --velo-${x} would cover every --velo-* token.
  const many = { root: { velo: {} } }
  for (let i = 0; i < 20; i++) many.root.velo[`t${i}`] = leaf(`--velo-t${i}`, '1px', i)
  const rows = auditTokens(many, [{ file: 'src/b.ts', src: 'const v = `var(--velo-${n})`' }])
  assert.equal(rows.filter((r) => r.alive).length, 0)
  assert.deepEqual(rows.broadDynamic, [{ prefix: '--velo-', files: ['src/b.ts'], covers: 20 }])
  assert.match(
    auditViolations(rows).join('\n'),
    /a dynamic name builder `--velo-\$\{…\}` in src\/b\.ts would cover 20 tokens/,
  )
})

test('$deprecated: one shape only -- a non-empty string on a token', () => {
  const bad = {
    root: {
      velo: {
        flag: leaf('--velo-flag', '1px', 1, { $deprecated: true }),
        empty: leaf('--velo-empty', '1px', 2, { $deprecated: '' }),
        grp: { $deprecated: 'x', a: leaf('--velo-grp-a', '1px', 3) },
      },
    },
  }
  const files = [{ file: 'src/a.css', src: '.a { a: var(--velo-grp-a); }' }]
  const v = auditViolations(auditTokens(bad, files), bad).join('\n')
  assert.match(v, /--velo-flag: \$deprecated must be a non-empty string/)
  assert.match(v, /--velo-empty: \$deprecated must be a non-empty string/)
  assert.match(v, /velo\.grp: \$deprecated on a group/)
  assert.match(v, /--velo-flag has no consumer/, 'a malformed flag does not excuse a dead token')
})

test('a "<style>" quoted in a template comment does not open a block', () => {
  const vue = [
    '<template>',
    '  <!-- the mask (in <style>) is the mechanism -->',
    '  <div />',
    '</template>',
    '<script setup lang="ts">',
    '// --velo-prose is named only in this comment',
    "const a = 'x'",
    '</script>',
    '<style>',
    '.a { color: var(--velo-primary); }',
    '</style>',
  ].join('\n')
  const code = stripVueComments(vue)
  assert.doesNotMatch(code, /--velo-prose/)
  assert.match(code, /var\(--velo-primary\)/)
})

// --- the standing guard on the real tree --------------------------------------

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('real registry: every token is consumed or $deprecated, no deprecated token is consumed', () => {
  const { doc, files } = readTree(FRONTEND)
  const rows = auditTokens(doc, files)
  assert.ok(rows.length > 200, `registry read (${rows.length} tokens)`)
  assert.ok(files.length > 300, `sources read (${files.length} files)`)
  assert.deepEqual(
    auditViolations(rows, doc),
    [],
    'run `node scripts/token-audit.mjs` for the full report',
  )
})
