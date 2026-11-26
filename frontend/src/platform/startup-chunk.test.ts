import { describe, expect, it } from 'vitest'
import { matchSpecifier, startupChunkName, usedClosure, type GraphModule } from './startup-chunk'

// A module graph in Rolldown's shape: transformed code + resolved static imports.
const graph: Record<string, GraphModule> = {
  '/s/main.ts': {
    code: 'import { boot } from "./platform/launch";\nimport("./app")',
    importedIds: ['/s/platform/launch.ts'],
  },
  '/s/platform/launch.ts': {
    code: 'import { inst } from "./instance";\nexport const boot = 1',
    importedIds: ['/s/platform/instance.ts'],
  },
  '/s/platform/instance.ts': { code: 'export const inst = 1', importedIds: [] },
  '/s/app.ts': {
    code: [
      'import { inst } from "@/platform/instance";',
      'import { VA, IconX } from "@kit";',
      'import * as all from "./icons";',
      'import { createApp } from "vue";',
      'import { strange } from "./generated?raw";',
    ].join('\n'),
    importedIds: [
      '/s/platform/instance.ts',
      '/kit/index.ts',
      '/s/icons/index.ts',
      '/nm/.pnpm/vue@3/node_modules/vue/index.js',
      '/s/generated.ts',
    ],
  },
  // The kit barrel: named re-exports, a nested component barrel, `export *`.
  '/kit/index.ts': {
    code: [
      'export { default as VA } from "./components/VA";',
      'export { default as VB } from "./components/VB";',
      'export * from "./icons";',
    ].join('\n'),
    importedIds: [
      '/kit/components/VA/index.ts',
      '/kit/components/VB/index.ts',
      '/kit/icons/index.ts',
    ],
  },
  '/kit/components/VA/index.ts': {
    code: 'export { default } from "./VA.vue"',
    importedIds: ['/kit/components/VA/VA.vue'],
  },
  '/kit/components/VA/VA.vue': { code: 'export default {}', importedIds: [] },
  '/kit/components/VB/index.ts': {
    code: 'export { default } from "./VB.vue"',
    importedIds: ['/kit/components/VB/VB.vue'],
  },
  '/kit/components/VB/VB.vue': { code: 'export default {}', importedIds: [] },
  '/kit/icons/index.ts': {
    code: 'export { default as IconX } from "./IconX.vue";\nexport { default as IconY } from "./IconY.vue"',
    importedIds: ['/kit/icons/IconX.vue', '/kit/icons/IconY.vue'],
  },
  '/kit/icons/IconX.vue': { code: 'export default {}', importedIds: [] },
  '/kit/icons/IconY.vue': { code: 'export default {}', importedIds: [] },
  // An app barrel taken whole through `import * as`.
  '/s/icons/index.ts': {
    code: 'export { default as IconP } from "./IconP.vue"',
    importedIds: ['/s/icons/IconP.vue'],
  },
  '/s/icons/IconP.vue': { code: 'export default {}', importedIds: [] },
  '/nm/.pnpm/vue@3/node_modules/vue/index.js': {
    code: 'export const createApp = 1',
    importedIds: [],
  },
  // A module the parse cannot map to its specifier: followed whole.
  '/s/generated.ts': {
    code: 'export { strange } from "./deep"',
    importedIds: ['/s/deep.ts'],
  },
  '/s/deep.ts': { code: 'export const strange = 1', importedIds: [] },
}
const lookup = (id: string): GraphModule | null => graph[id] ?? null
const alias = (spec: string): string | null =>
  spec === '@kit' ? '/kit/index.ts' : spec.startsWith('@/') ? `/s/${spec.slice(2)}` : null

describe('usedClosure', () => {
  it('follows a barrel re-export only for the names its importers use', () => {
    const closure = usedClosure('/s/app.ts', lookup, alias)
    expect(closure).toContain('/kit/components/VA/VA.vue')
    expect(closure).toContain('/kit/icons/IconX.vue')
    expect(closure).not.toContain('/kit/components/VB/VB.vue')
    expect(closure).not.toContain('/kit/icons/IconY.vue')
  })

  it('takes a namespace import and an unmapped import whole', () => {
    const closure = usedClosure('/s/app.ts', lookup, alias)
    expect(closure).toContain('/s/icons/IconP.vue')
    expect(closure).toContain('/s/deep.ts')
  })
})

describe('matchSpecifier', () => {
  const ids = ['/s/a/index.ts', '/s/b.vue', '/nm/.pnpm/x@1/node_modules/@scope/pkg/dist/i.js']
  it.each([
    ['./a', '/s/a/index.ts'],
    ['../s/b.vue', '/s/b.vue'],
    ['@scope/pkg/sub', '/nm/.pnpm/x@1/node_modules/@scope/pkg/dist/i.js'],
    ['./missing', null],
  ])('maps %s', (spec, id) => {
    expect(matchSpecifier(spec, '/s/main.ts', ids, () => null)).toBe(id)
  })
})

describe('startupChunkName', () => {
  const name = startupChunkName('/s/app.ts', '/s/main.ts', alias)
  const ctx = { getModuleInfo: lookup }

  it.each([
    // What main.ts loads stays out of `app`, even when app.ts imports it too:
    // the entry chunk must never import `app` statically.
    ['/s/platform/instance.ts', 'host'],
    ['/s/platform/launch.ts', 'host'],
    ['/s/main.ts', null],
    ['/s/app.ts', 'app'],
    ['/kit/components/VA/VA.vue', 'app'],
    ['/kit/components/VB/VB.vue', null],
  ])('puts %s into %s', (id, chunk) => {
    expect(name(id, ctx)).toBe(chunk)
  })
})
