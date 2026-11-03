// =============================================================================
// @velo/ui -- Storybook preview (FE-116 skeleton, tz-ui-package.md §3.3)
// =============================================================================
// The витрина acts as the HOST for tokens: the package itself carries no
// theme values (принцип 2: токены не уезжают), so the showcase imports the
// GOLDEN variables.css from the application by a pinned relative path --
// exactly what the app's cascade hands the package in a golden build
// (variables.css -> @velo/ui css -> skin-tokens.css). A skinned showcase,
// if ever wanted, is a storybook build-time concern, never a package one.
// =============================================================================

import type { Preview } from '@storybook/vue3-vite'

import '../../../frontend/src/styles/variables.css'

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
}

export default preview
