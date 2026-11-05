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
