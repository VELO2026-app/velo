// =============================================================================
// FE-224 -- unit tests for the Figma mirror sheet mapping (Vitest, the
// `scripts` project; part of `pnpm test`). One miniature repo drives every case.
// =============================================================================
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  affectedSheets,
  createGraph,
  isVisualChange,
  parseCatFileBatch,
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
  'frontend/src/components/ui/VeloLogo.vue':
    '<script setup>\nconst src = \'/icons/logo.svg\'\n</script>\n<template><img :src="src" /></template>',
  'frontend/src/components/shared/PracticeCard.vue':
    "<script setup lang=\"ts\">\nimport { VButton } from '@/components/ui'\nimport { iconFor } from '@/utils/icons'\nimport type { Practice } from '@/api/types'\n</script>\n<template><p>{{ t('card.title') }}</p></template>",
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
  // the role shell is mounted by the router, not imported by the view
  // a glob in an HTML comment must not hide the imports below it (FE-224 review)
  'frontend/src/views/shells/UserShell.vue':
    "<!-- Layout for all /user/* routes; see the legacy /* note -->\n<script setup>\nimport MobileLayout from '@/components/layout/MobileLayout.vue'\n/** The shell. */\nconst tabs = []\n</script>",
  'frontend/src/views/shells/MasterShell.vue': '<template><main /></template>',
  'frontend/src/components/layout/MobileLayout.vue':
    "<script setup>\nimport VTabBar from './VTabBar.vue'\n</script>",
  'frontend/src/components/layout/VTabBar.vue': '<template><nav /></template>',
  // the tab table is a root outside the graph: its own imports must be followed
  'frontend/src/router/tabs.ts':
    "import i18n from '@/locales'\nimport IconTab from '@/components/icons/IconTab.vue'\nexport const TABS = [IconTab]",
  'frontend/src/components/icons/IconTab.vue': '<template><svg /></template>',
  // behaviour, outside the graph: a store that imports every view must not leak into a screen
  'frontend/src/stores/main.ts':
    "import Other from '@/views/user/OtherView.vue'\nexport const useStore = () => Other",
  'frontend/src/api/types.ts': 'export type Practice = { id: string }',
  'frontend/src/locales/index.ts': 'export const t = (k) => k',
  // texts: PracticeCard renders t('card.title'); nothing renders the `other` namespace
  'frontend/src/locales/ru/user.json': '{ "card": { "title": "Практика" } }',
  'frontend/src/locales/ru/other.json': '{ "other": { "x": "y" } }',
  'frontend/src/styles/global.css': 'body {}',
  'frontend/tokens.json': '{}',
}
const FILES = [
  ...Object.keys(SRC),
  'frontend/public/bg/background.webp',
  'frontend/public/icons/logo.svg',
  'frontend/src/views/user/HomeView.test.ts',
]
const repo = { files: new Set(FILES), read: (p) => (p in SRC ? SRC[p] : null) }

const sheet = (key, id, sources, page = 'Kit и токены') => ({
  key,
  id,
  page,
  name: key,
  sources,
})
const SHEETS = [
  sheet('screen:user.home', '1:1', ['frontend/src/views/user/HomeView.vue'], 'Gold · Приложение'),
  sheet('component:Actions', '1:2', ['packages/velo-ui/src/components/VButton']),
  sheet('component:Overlays', '1:3', ['name:VModal']),
  // a source that moved into the kit keeps its file name
  sheet('component:Legacy', '1:4', ['frontend/src/components/ui/VButton.vue']),
  sheet('component:Icons', '1:5', ['frontend/src/components/icons']),
  sheet('registry:velo', '1:6', []),
  sheet('asset:app-background', '1:7', [], 'Скины'),
  sheet('templates', '1:8', []),
  sheet('component:Brand', '1:9', ['frontend/src/components/ui/VeloLogo.vue']),
]
const manifest = { sheets: SHEETS }
const keysFor = (files) => affectedSheets(files, manifest, repo).sheets.map((s) => s.key)
const KIT_AND_SCREENS = [
  'screen:user.home',
  'component:Actions',
  'component:Overlays',
  'component:Legacy',
  'component:Icons',
  'component:Brand',
]

// --- parsing ---------------------------------------------------------------------
test('parseModule: bindings, whole-module imports, public assets and re-exports; type-only imports are skipped', () => {
  const m = parseModule(
    [
      "import A, { b as c, type T } from './a'",
      "import type { U } from './types'",
      "import * as ns from './ns'",
      "import './side.css'",
      "const L = () => import('./lazy.vue')",
      "export { default as V, w } from './v'",
      "export * from './all'",
      '<style>@import "./s.css"; .x { background: url(/bg/b.webp) }</style>',
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
    { spec: '/bg/b.webp', bindings: null },
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

test('parseCatFileBatch: splits contents by the header sizes and skips missing objects', () => {
  const buf = Buffer.from('aa blob 5\nhello\nbb missing\ncc blob 5\nпр\n\n', 'utf8')
  const out = parseCatFileBatch(buf, ['x.vue', 'gone.ts', 'y.css'])
  assert.deepEqual(
    [...out],
    [
      ['x.vue', 'hello'],
      ['y.css', 'пр\n'],
    ],
  )
  assert.throws(() => parseCatFileBatch(Buffer.from('aa blob five\n'), ['x.vue']), /bad header/)
})

// --- the import graph ------------------------------------------------------------
test('closure: a named barrel import depends on the defining file, not on the whole barrel', () => {
  const c = createGraph(repo).closure('frontend/src/components/shared/PracticeCard.vue')
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
  const g2 = createGraph({
    files: repo.files,
    read: (p) => (p in withModal ? withModal[p] : null),
  })
  assert.ok(
    g2
      .closure('frontend/src/components/shared/NoteRow.vue')
      .has('packages/velo-ui/src/components/VModal/VModal.vue'),
  )
})

test('closure: follows dynamic and CSS imports, utils and public assets, but not stores', () => {
  const g = createGraph(repo)
  const c = g.closure('frontend/src/views/user/HomeView.vue')
  assert.ok(c.has('frontend/src/components/shared/NoteRow.vue'))
  assert.ok(c.has('frontend/src/styles/rows.css'))
  assert.ok(c.has('frontend/src/components/icons/IconStar.vue'))
  assert.ok(!c.has('frontend/src/views/user/OtherView.vue'))
  assert.ok(
    g.closure('frontend/src/components/ui/VeloLogo.vue').has('frontend/public/icons/logo.svg'),
  )
})

// --- which changes count -----------------------------------------------------------
test('isVisualChange: markup, styles, fonts, tokens, ru texts, the tab table and skin assets count; logic, other locales, tests and docs do not', () => {
  for (const f of [
    'frontend/src/a/B.vue',
    'frontend/src/styles/x.css',
    'frontend/public/fonts/marmelad-subset.woff2',
    'frontend/tokens.json',
    'frontend/src/locales/ru/user.json',
    'packages/velo-ui/src/i18n.ts',
    'frontend/src/router/tabs.ts',
    'frontend/public/bg/bg.webp',
  ]) {
    assert.equal(isVisualChange(f), true, f)
  }
  for (const f of [
    'frontend/src/stores/main.ts',
    'frontend/src/router/guards.ts',
    'frontend/src/locales/en/user.json',
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

test('affectedSheets: a `name:` source, a component folder and a public asset map to their sheets', () => {
  assert.deepEqual(keysFor(['packages/velo-ui/src/components/VModal/VModal.vue']), [
    'component:Overlays',
  ])
  assert.deepEqual(keysFor(['frontend/src/components/icons/IconMoon.vue']), ['component:Icons'])
  assert.deepEqual(keysFor(['frontend/public/icons/logo.svg']), ['component:Brand'])
})

test('affectedSheets: the role shell, its layout and the tab table reach the screens of that role only', () => {
  for (const f of [
    'frontend/src/views/shells/UserShell.vue',
    'frontend/src/components/layout/VTabBar.vue',
    'frontend/src/router/tabs.ts',
  ]) {
    assert.deepEqual(keysFor([f]), ['screen:user.home'], f)
  }
  assert.ok(keysFor(['frontend/src/components/icons/IconTab.vue']).includes('screen:user.home'))
  assert.deepEqual(keysFor(['frontend/src/views/shells/MasterShell.vue']), [])
})

test('affectedSheets: a ru text file reaches only the sheets that render a key of its namespaces', () => {
  const r = affectedSheets(['frontend/src/locales/ru/user.json'], manifest, repo)
  assert.deepEqual(
    r.sheets.map((s) => s.key),
    ['screen:user.home'],
  )
  assert.equal(r.texts, true)
  assert.deepEqual(keysFor(['frontend/src/locales/ru/other.json']), [])
})

test('affectedSheets: tokens reach the registry and every screen and kit sheet; global styles the screens and the kit', () => {
  const r = affectedSheets(['frontend/tokens.json'], manifest, repo)
  assert.deepEqual(r.sheets.map((s) => s.key).sort(), [...KIT_AND_SCREENS, 'registry:velo'].sort())
  assert.equal(r.tokens, true)
  assert.deepEqual(keysFor(['frontend/src/styles/global.css']).sort(), [...KIT_AND_SCREENS].sort())
  assert.deepEqual(keysFor(['frontend/public/bg/background.webp']), ['asset:app-background'])
})

test('affectedSheets: a change without UI gives nothing to do', () => {
  const r = affectedSheets(
    [
      'frontend/src/stores/main.ts',
      'frontend/src/api/types.ts',
      'frontend/src/views/user/HomeView.test.ts',
      'docs/x.md',
    ],
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
test('staleSheets: sorts sheets by commit and seal and reports manifest drift', () => {
  const inventory = {
    sheets: [
      { ...SHEETS[0], commit: 'aaa1111', seal: 'v2:1:0', intact: true },
      { ...SHEETS[1], commit: 'bbb2222', seal: 'v2:1:1', intact: false },
      { ...SHEETS[2], commit: 'bbb2222' },
      { ...SHEETS[4] },
      { ...SHEETS[5], commit: 'ccc3333', seal: 'v2:1:2' },
      { ...SHEETS[7] },
      sheet('component:Ghost', '1:10', ['frontend/src/components/shared/Gone.vue']),
      {
        ...sheet(
          'screen:user.new',
          '9:9',
          ['frontend/src/views/user/OtherView.vue'],
          'Gold · Приложение',
        ),
        commit: 'aaa1111',
        seal: 'v2:1:3',
      },
    ],
  }
  const changes = {
    aaa1111: ['frontend/src/components/icons/IconStar.vue', 'frontend/src/stores/main.ts'],
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
    r.unsealed.map((s) => s.key),
    ['component:Overlays'],
  )
  assert.deepEqual(
    r.unknown.map((s) => [s.key, s.why]),
    [
      ['component:Icons', 'no c2f:commit'],
      ['registry:velo', 'commit ccc3333 not in the repo'],
      ['component:Ghost', 'no source resolves in the repo'],
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
    { file: 'F', sheets: [{ ...SHEETS[0], commit: 'aaa1111', seal: 'v2:1:0', intact: true }] },
    '2026-11-21',
  )
  assert.deepEqual(m.sheets, [SHEETS[0]])
  assert.equal(m.generated, '2026-11-21')
})
