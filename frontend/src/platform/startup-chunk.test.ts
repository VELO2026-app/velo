import { describe, expect, it } from 'vitest'
import {
  checkStartupLayout,
  matchSpecifier,
  startupChunkName,
  usedClosure,
  type GraphModule,
  type LayoutChunk,
} from './startup-chunk'

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
  ])('puts %s into %s', (id, chunk) => {
    expect(name(id, ctx)).toBe(chunk)
  })

  it('computes the sets again for a new chunking pass (a new ModuleInfo of app.ts)', () => {
    const fresh = startupChunkName('/s/app.ts', '/s/main.ts', alias)
    expect(fresh('/s/z.ts', ctx)).toBeNull()
    const app = graph['/s/app.ts'] as GraphModule
    const next: Record<string, GraphModule> = {
      ...graph,
      '/s/app.ts': {
        code: `${app.code ?? ''}\nimport { z } from "./z";`,
        importedIds: [...app.importedIds, '/s/z.ts'],
      },
      '/s/z.ts': { code: 'export const z = 1', importedIds: [] },
    }
    expect(fresh('/s/z.ts', { getModuleInfo: (id) => next[id] ?? null })).toBe('app')
  })
})

describe('checkStartupLayout', () => {
  const chunk = (fileName: string, over: Partial<LayoutChunk> = {}): LayoutChunk => ({
    fileName,
    name: fileName.replace(/-.*$/, ''),
    isEntry: false,
    moduleIds: [],
    imports: [],
    ...over,
  })
  // The designed layout: entry -> host; facade -> app -> host + runtime helpers.
  const layout = (): LayoutChunk[] => [
    chunk('index-1.js', { isEntry: true, moduleIds: ['/s/main.ts'], imports: ['host-1.js'] }),
    chunk('host-1.js', { moduleIds: ['/s/platform/launch.ts'] }),
    chunk('start-1.js', { name: 'app', imports: ['app-1.js'] }),
    chunk('app-1.js', {
      moduleIds: ['/s/app.ts', '/s/App.vue'],
      imports: ['host-1.js', 'rolldown-runtime-1.js'],
    }),
    chunk('rolldown-runtime-1.js', { moduleIds: ['\0rolldown/runtime.js'] }),
    chunk('VHeader-1.js', { moduleIds: ['/s/VHeader.vue', '/s/VHeader.vue?vue&type=style'] }),
    chunk('Lazy-1.js', { moduleIds: ['/s/Lazy.vue'] }),
  ]
  const canaries = [/\/VHeader\.vue(\?|$)/]
  const check = (chunks: LayoutChunk[]): string[] =>
    checkStartupLayout(chunks, '/s/app.ts', canaries)
  const edit = (name: string, over: Partial<LayoutChunk>): LayoutChunk[] =>
    layout().map((c) => (c.fileName === name ? { ...c, ...over } : c))

  it('passes the designed layout', () => {
    expect(check(layout())).toEqual([])
  })

  it.each([
    ['an entry importing app', edit('host-1.js', { imports: ['app-1.js'] }), /before the host/],
    [
      'app importing a chunk other than host and the helpers',
      edit('app-1.js', { imports: ['host-1.js', 'Lazy-1.js'] }),
      /imports Lazy-1\.js statically/,
    ],
    [
      'a canary inside the app chunk',
      edit('app-1.js', { moduleIds: ['/s/app.ts', '/s/VHeader.vue', '/s/VHeader.vue?vue&type=x'] }),
      /^\/s\/VHeader\.vue is in the startup set \(app-1\.js\)$/,
    ],
    ['no chunk holding app.ts', edit('app-1.js', { moduleIds: ['/s/App.vue'] }), /no chunk holds/],
    [
      'a canary that matches no module (renamed component)',
      layout().filter((c) => c.fileName !== 'VHeader-1.js'),
      /canary .*VHeader.* matches no module/,
    ],
    [
      'an empty chunk taken for the runtime helpers',
      [...edit('app-1.js', { imports: ['host-1.js', 'empty-1.js'] }), chunk('empty-1.js')],
      /imports empty-1\.js statically/,
    ],
  ])('fails on %s', (_, chunks, message) => {
    const problems = check(chunks)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(message)
  })
})
