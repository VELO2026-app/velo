/// <reference types="vite/client" />

// Vue Single File Components -- the same shim frontend/env.d.ts carries:
// vue-tsc resolves real SFCs natively and shadows this declaration, while
// the eslint program (plain TS + extraFileExtensions) needs it to type
// .vue imports in .ts files.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// The storybook skin switcher's data (.storybook/main.ts, FE-131): the skin
// packages listed in VELO_SKINS as their token layer CSS, keyed by name.
declare module 'virtual:velo-skins' {
  const layers: Record<string, string>
  export default layers
}
