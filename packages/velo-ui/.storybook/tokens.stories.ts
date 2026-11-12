// =============================================================================
// @velo/ui -- the token registry page (§3.7, шаг 1 витрины)
// =============================================================================
// "Доки токенов -- страница с живыми --velo-* пакета (значения = данные,
// смена скина перекрашивает стори сама)". The page parses the GOLDEN
// variables.css (the host's token layer -- the package owns none, принцип
// 2) and renders one row per declaration: a LIVE swatch (background:
// var(--name) -- resolved by the browser, so the Skin toolbar repaints it)
// next to the name and the authored value text.
//
// This story lives in .storybook/ ON PURPOSE (main.ts scans it too): it
// reads the host's variables.css and the skin files as build-time ?raw
// inputs by the same pinned relative paths preview.ts uses -- showcase
// tooling, which the boundary law (the kit never imports the host) scopes
// OUT of src/**. The parse is deliberately dumb (declaration lines only,
// comments skipped): the byte-for-byte roundtrip test in the app owns the
// file's correctness; this page only needs to SHOW it.
// =============================================================================

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import goldenCss from '../../../frontend/src/styles/variables.css?raw'

interface TokenRow {
  name: string
  value: string
  /** A family key for grouping: the segment right after --velo- (or the
   *  bare family's own name). */
  family: string
}

function parseDeclarations(css: string): TokenRow[] {
  const rows: TokenRow[] = []
  for (const line of css.split('\n')) {
    const m = line.match(/^\s*(--[A-Za-z0-9-]+)\s*:\s*(.+?);/)
    if (!m) continue
    // Match groups always participate when the regex matched; the ?? keeps
    // noUncheckedIndexedAccess honest.
    const name = m[1] ?? ''
    const value = (m[2] ?? '').trim()
    let family: string
    if (name.startsWith('--velo-')) {
      family = name.replace(/^--velo-/, '').split('-', 1)[0] ?? name
    } else {
      // The bare frozen family: --space-2 -> 'space'.
      family = /^--([a-z]+)-/.exec(name)?.[1] ?? 'bare'
    }
    rows.push({ name, value, family })
  }
  return rows
}

// Stable family order = first-appearance order in the golden file (the
// authored order, not an alphabet that would reshuffle on every retheme).
const TOKENS = parseDeclarations(goldenCss)
const FAMILIES = [...new Set(TOKENS.map((t) => t.family))]

const meta: Meta = {
  title: 'Design Tokens/Registry',
  parameters: {
    docs: {
      description: {
        component:
          'Живой реестр токенов хоста: свотч = `var(--имя)`, поэтому переключатель Skin (тулбар) перекрашивает страницу и все стории. Файл-источник — `frontend/src/styles/variables.css` (golden); пакет значений не носит.',
      },
    },
  },
}

export default meta

type Story = StoryObj<typeof meta>

export const Registry: Story = {
  render: () => ({
    data() {
      return { families: FAMILIES, tokens: TOKENS }
    },
    template: `
<div style="font-family: var(--font-body, sans-serif); color: var(--velo-text-primary, #333); padding: 16px;">
  <h1 style="font-size: 20px; margin: 0 0 4px;">Token registry -- golden</h1>
  <p style="font-size: 13px; margin: 0 0 16px; opacity: 0.7;">
    {{ tokens.length }} declarations · {{ families.length }} families · live var() swatches (the Skin toolbar repaints)
  </p>
  <section v-for="family in families" :key="family" style="margin-bottom: 20px;">
    <h2 style="font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 8px; opacity: 0.6;">{{ family }}</h2>
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 6px;">
      <div
        v-for="token in tokens.filter((t) => t.family === family)"
        :key="token.name"
        style="display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid var(--velo-border-light, #e5e5e5); border-radius: 8px; background: var(--velo-bg-card-solid, #fff);"
      >
        <span
          style="width: 36px; height: 36px; flex: none; border-radius: 8px; border: 1px solid var(--velo-border-light, #e5e5e5);"
          :style="{ background: 'var(' + token.name + ')' }"
        />
        <span style="min-width: 0;">
          <code style="display: block; font-size: 12px; font-weight: 600;">{{ token.name }}</code>
          <code style="display: block; font-size: 11px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ token.value }}</code>
        </span>
      </div>
    </div>
  </section>
</div>
`,
  }),
}
