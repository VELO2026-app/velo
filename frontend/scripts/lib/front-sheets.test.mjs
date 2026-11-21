// =============================================================================
// FE-224 -- unit tests for the «Фронт» sheet mapping (Vitest, the `scripts`
// project; part of `pnpm test`). One miniature repo drives every case.
// =============================================================================
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  affectedSheets,
  createGraph,
  isVisualChange,
  parseModule,
  staleSheets,
  toManifest,
} from './front-sheets.mjs'

// --- a miniature repo -----------------------------------------------------------
const SRC = {
  'packages/velo-ui/src/index.ts': [
    "export { default as VButton } from './components/VButton'",
    "export { default as VModal } from './components/VModal'",
  ].join('\n'),
  'packages/velo-ui/src/components/VButton/index.ts': "export { default } from './VButton.vue'",
  'packages/velo-ui/src/components/VButton/VButton.vue': '<template><button /></template>',
  'packages/velo-ui/src/components/VModal/index.ts': "export { default } from './VModal.vue'",
  'packages/velo-ui/src/components/VModal/VModal.vue': '<template><dialog /></template>',
  // the app barrel: a re-export plus a local wrapper next to an unrelated one
  'frontend/src/components/ui/index.ts': [
    "import { h } from 'vue'",
    "import { VModal as VModalKit } from '@velo/ui'",
    "import { t } from '@/locales'",
    'const VModal = (p) => h(VModalKit, { label: t("x") })',
    'const VNote = () => h("p")',
    "export { VButton } from '@velo/ui'",
    'export { VModal, VNote }',
  ].join('\n'),
  'frontend/src/components/shared/PracticeCard.vue':
    "<script setup lang=\"ts\">\nimport { VButton } from '@/components/ui'\nimport { iconFor } from '@/utils/icons'\nimport type { Practice } from '@/api/types'\n</script>",
  'frontend/src/components/shared/NoteRow.vue':
    "<script setup>\nimport { VNote } from '@/components/ui'\n</script>\n<style>@import '../../styles/rows.css';</style>",
  'frontend/src/styles/rows.css': '.row {}',
  'frontend/src/utils/icons.ts':
    "import IconStar from '@/components/icons/IconStar.vue'\nexport const iconFor = () => IconStar\nexport const plain = 1",
  'frontend/src/components/icons/IconStar.vue': '<template><svg /></template>',
  'frontend/src/components/icons/IconMoon.vue': '<template><svg /></template>',
  'frontend/src/views/user/HomeView.vue':
    "<script setup>\nimport PracticeCard from '@/components/shared/PracticeCard.vue'\nimport { useStore } from '@/stores/main'\nconst Sheet = () => import('@/components/shared/NoteRow.vue')\n</script>",
  'frontend/src/views/user/OtherView.vue': '<template><div /></template>',
  // behaviour, outside the graph: a store that imports every view must not leak into a screen
  'frontend/src/stores/main.ts':
    "import Other from '@/views/user/OtherView.vue'\nexport const useStore = () => Other",
  'frontend/src/locales/index.ts': 'export const t = (k) => k',
  'frontend/src/styles/global.css': 'body {}',
  'frontend/tokens.json': '{}',
}
const FILES = [
  ...Object.keys(SRC),
  'frontend/public/bg/background.webp',
  'frontend/src/views/user/HomeView.test.ts',
]
const repo = { files: new Set(FILES), read: (p) => (p in SRC ? SRC[p] : null) }

const SHEETS = [
  {
    key: 'screen:user.home',
    id: '1:1',
    page: 'Фронт · Экраны',
    name: 'Screen / user.home / Home',
    sources: ['frontend/src/views/user/HomeView.vue'],
  },
  {
    key: 'component:Actions',
    id: '1:2',
    page: 'Фронт · Kit и токены',
    name: 'Component / Actions',
    sources: ['packages/velo-ui/src/components/VButton'],
  },
  {
    key: 'component:Overlays',
    id: '1:3',
    page: 'Фронт · Kit и токены',
    name: 'Component / Overlays',
    sources: ['name:VModal'],
  },
  // a source that moved into the kit keeps its file name
  {
    key: 'component:Legacy',
    id: '1:4',
    page: 'Фронт · Kit и токены',
    name: 'Component / Legacy',
    sources: ['frontend/src/components/ui/VButton.vue'],
  },
  {
    key: 'component:Icons',
    id: '1:5',
    page: 'Фронт · Kit и токены',
    name: 'Component / Icons',
    sources: ['frontend/src/components/icons'],
  },
  {
    key: 'registry:velo',
    id: '1:6',
    page: 'Фронт · Kit и токены',
    name: 'Registry / velo',
    sources: [],
  },
  {
    key: 'asset:app-background',
    id: '1:7',
    page: 'Фронт · Скины',
    name: 'Asset / App background',
    sources: [],
  },
  { key: 'templates', id: '1:8', page: 'Фронт · Kit и токены', name: 'Templates', sources: [] },
]
const manifest = { sheets: SHEETS }
const keysFor = (files) => affectedSheets(files, manifest, repo).sheets.map((s) => s.key)

// --- parsing ---------------------------------------------------------------------
test('parseModule: bindings, whole-module imports and re-exports; type-only imports are skipped', () => {
  const m = parseModule(
    [
      "import A, { b as c, type T } from './a'",
      "import type { U } from './types'",
      "import * as ns from './ns'",
      "import './side.css'",
      "const L = () => import('./lazy.vue')",
      "export { default as V, w } from './v'",
      "export * from './all'",
      '<style>@import "./s.css";</style>',
    ].join('\n'),
  )
  assert.deepEqual(m.imports, [
    {
      spec: './a',
      bindings: [
        { imported: 'default', local: 'A' },
        { imported: 'b', local: 'c' },
      ],
    },
    { spec: './ns', bindings: null },
    { spec: './side.css', bindings: null },
    { spec: './lazy.vue', bindings: null },
    { spec: './s.css', bindings: null },
  ])
  assert.deepEqual(
    m.reexports.map((r) => [r.spec, r.map && [...r.map]]),
    [
      [
        './v',
        [
          ['V', 'default'],
          ['w', 'w'],
        ],
      ],
      ['./all', null],
    ],
  )
})

// --- the import graph ------------------------------------------------------------
test('closure: a named barrel import depends on the defining file, not on the whole barrel', () => {
  const g = createGraph(repo)
  const c = g.closure('frontend/src/components/shared/PracticeCard.vue')
  assert.ok(c.has('packages/velo-ui/src/components/VButton/VButton.vue'))
  assert.ok(!c.has('packages/velo-ui/src/components/VModal/VModal.vue'))
})

test('closure: a wrapper declared in a barrel follows only the imports it uses', () => {
  const g = createGraph(repo)
  assert.ok(
    !g
      .closure('frontend/src/components/shared/NoteRow.vue')
      .has('packages/velo-ui/src/components/VModal/VModal.vue'),
  )
  const withModal = {
    ...SRC,
    'frontend/src/components/shared/NoteRow.vue':
      "<script setup>\nimport { VModal } from '@/components/ui'\n</script>",
  }
  const g2 = createGraph({ files: repo.files, read: (p) => (p in withModal ? withModal[p] : null) })
  assert.ok(
    g2
      .closure('frontend/src/components/shared/NoteRow.vue')
      .has('packages/velo-ui/src/components/VModal/VModal.vue'),
  )
})

test('closure: follows dynamic and CSS imports and utils, but not stores', () => {
  const c = createGraph(repo).closure('frontend/src/views/user/HomeView.vue')
  assert.ok(c.has('frontend/src/components/shared/NoteRow.vue'))
  assert.ok(c.has('frontend/src/styles/rows.css'))
  assert.ok(c.has('frontend/src/components/icons/IconStar.vue'))
  assert.ok(!c.has('frontend/src/views/user/OtherView.vue'))
})

// --- which changes count -----------------------------------------------------------
test('isVisualChange: markup, styles, tokens and skin assets count; logic, tests and docs do not', () => {
  for (const f of [
    'frontend/src/a/B.vue',
    'frontend/src/styles/x.css',
    'frontend/tokens.json',
    'frontend/public/bg/bg.webp',
  ]) {
    assert.equal(isVisualChange(f), true, f)
  }
  for (const f of [
    'frontend/src/utils/icons.ts',
    'frontend/src/views/user/HomeView.test.ts',
    'docs/figma-protocol.md',
  ]) {
    assert.equal(isVisualChange(f), false, f)
  }
})

// --- PR -> sheets ------------------------------------------------------------------
test('affectedSheets: a kit component change reaches its kit sheet and the screens that render it', () => {
  assert.deepEqual(keysFor(['packages/velo-ui/src/components/VButton/VButton.vue']), [
    'screen:user.home',
    'component:Actions',
    'component:Legacy',
  ])
})

test('affectedSheets: a `name:` source and a component folder map to their sheets', () => {
  assert.deepEqual(keysFor(['packages/velo-ui/src/components/VModal/VModal.vue']), [
    'component:Overlays',
  ])
  assert.deepEqual(keysFor(['frontend/src/components/icons/IconMoon.vue']), ['component:Icons'])
})

test('affectedSheets: tokens map to the registry and raise the variable-sync flag; assets to their sheet', () => {
  const r = affectedSheets(['frontend/tokens.json'], manifest, repo)
  assert.deepEqual(
    r.sheets.map((s) => s.key),
    ['registry:velo'],
  )
  assert.equal(r.tokens, true)
  assert.deepEqual(keysFor(['frontend/public/bg/background.webp']), ['asset:app-background'])
})

test('affectedSheets: a change without UI gives nothing to do', () => {
  const r = affectedSheets(
    ['frontend/src/utils/icons.ts', 'frontend/src/views/user/HomeView.test.ts', 'docs/x.md'],
    manifest,
    repo,
  )
  assert.deepEqual(r.sheets, [])
  assert.equal(r.tokens, false)
})

test('affectedSheets: a changed view without a sheet is listed, not resnapped', () => {
  const r = affectedSheets(['frontend/src/views/user/OtherView.vue'], manifest, repo)
  assert.deepEqual(r.sheets, [])
  assert.deepEqual(r.screensWithoutSheet, ['frontend/src/views/user/OtherView.vue'])
})

// --- weekly check -------------------------------------------------------------------
test('staleSheets: sorts sheets by their commit and reports manifest drift', () => {
  const inventory = {
    sheets: [
      { ...SHEETS[0], commit: 'aaa1111', intact: true },
      { ...SHEETS[1], commit: 'bbb2222', intact: false },
      { ...SHEETS[4] },
      { ...SHEETS[5], commit: 'ccc3333' },
      { ...SHEETS[7] },
      {
        key: 'screen:user.new',
        id: '9:9',
        page: 'Фронт · Экраны',
        name: 'Screen / user.new / New',
        sources: ['frontend/src/views/user/OtherView.vue'],
        commit: 'aaa1111',
      },
    ],
  }
  const changes = {
    aaa1111: ['frontend/src/components/icons/IconStar.vue', 'frontend/src/utils/icons.ts'],
    bbb2222: ['docs/x.md'],
  }
  const r = staleSheets(inventory, manifest, repo, (c) => changes[c] ?? null)
  assert.deepEqual(
    r.stale.map((s) => [s.key, s.reasons]),
    [['screen:user.home', ['frontend/src/components/icons/IconStar.vue']]],
  )
  assert.deepEqual(
    r.fresh.map((s) => s.key),
    ['component:Actions', 'screen:user.new'],
  )
  assert.deepEqual(
    r.unknown.map((s) => [s.key, s.why]),
    [
      ['component:Icons', 'no c2f:commit'],
      ['registry:velo', 'commit ccc3333 not in the repo'],
    ],
  )
  assert.deepEqual(
    r.edited.map((s) => s.key),
    ['component:Actions'],
  )
  assert.deepEqual(
    r.notMirroring.map((s) => s.key),
    ['templates'],
  )
  assert.ok(r.drift.includes('screen:user.new: in Figma (9:9), not in the manifest'))
  assert.ok(r.drift.includes('asset:app-background: in the manifest, not in Figma'))
})

test('toManifest: keeps the sheet identity and sources, drops the per-capture fields', () => {
  const m = toManifest(
    { file: 'F', sheets: [{ ...SHEETS[0], commit: 'aaa1111', seal: 'v1:1:0', intact: true }] },
    '2026-11-21',
  )
  assert.deepEqual(m.sheets, [SHEETS[0]])
  assert.equal(m.generated, '2026-11-21')
})
