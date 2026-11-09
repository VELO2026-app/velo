// =============================================================================
// FE-153 -- unit tests for the build-log gate engine
// (node:test; run by `pnpm test` -- vitest globs src/** only).
// The fixture lines are verbatim from the pre-FE-153 `pnpm build` output.
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findBuildLogWarnings } from './build-log-gate.mjs'

const CYCLE =
  'Export "default" of module "src/components/ui/VTextarea.vue" was reexported through module "src/components/ui/index.ts" while both modules are dependencies of each other and will end up in different chunks by current Rollup settings. This scenario is not well supported at the moment as it will produce a circular dependency between chunks and will likely lead to broken execution order.'
const HTML_ENV =
  '(!) %VITE_BRAND% is not defined in env variables found in /index.html. Is the variable mistyped?'
const LOCALE_NOTE =
  '(!) /x/frontend/src/locales/ru/admin.json is dynamically imported by /x/frontend/src/locales/index.ts but also statically imported by /x/frontend/src/locales/index.ts, dynamic import will not move module into another chunk.'

test('a clean log has no findings', () => {
  const log = [
    'vite v6.4.4 building for production...',
    '✓ 1351 modules transformed.',
    'dist/index.html  4.1 kB',
  ].join('\n')
  assert.deepEqual(findBuildLogWarnings(log), [])
})

test('the cyclic cross-chunk re-export is found', () => {
  assert.deepEqual(findBuildLogWarnings(`transforming...\n${CYCLE}\n`), [
    { rule: 'cyclic-reexport', line: CYCLE },
  ])
})

test('an undefined html env placeholder is found', () => {
  assert.deepEqual(findBuildLogWarnings(HTML_ENV), [{ rule: 'html-env', line: HTML_ENV }])
})

test('ANSI colour codes do not hide a finding', () => {
  const coloured = `\u001b[33m\u001b[1m${HTML_ENV}\u001b[22m\u001b[39m`
  assert.equal(findBuildLogWarnings(coloured).length, 1)
})

test('out-of-scope notices (the locale catalogs) are not findings', () => {
  assert.deepEqual(findBuildLogWarnings(LOCALE_NOTE), [])
})
