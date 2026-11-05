// =============================================================================
// @velo/ui -- Vite library-mode build (FE-116, tz-ui-package.md §3.2/§3.3)
// =============================================================================
//
// One ES module bundle (dist/index.js) and ONE css bundle (dist/velo-ui.css).
// The css bundle is the package's only styling artifact: component styles
// travel inside the SFCs as-is, values are var(--velo-*) tokens ONLY -- the
// host paints the kit through its cascade
//   variables.css -> @velo/ui css bundle -> skin-tokens.css
// so the golden build and any skin color it identically (tz-whitelabel §3).
// vue is a peer dependency and stays external -- it is never bundled.
//
// d.ts types are NOT produced here: `pnpm build` runs vue-tsc with
// tsconfig.build.json (declaration/emitDeclarationOnly -> dist/types/).
// =============================================================================

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],

  resolve: {
    // Makes `@/components/...` resolve inside the package's own src/.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'velo-ui',
    },
    rollupOptions: {
      external: ['vue'],
      output: {
        globals: { vue: 'Vue' },
      },
    },
  },
})
