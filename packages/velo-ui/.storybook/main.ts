// =============================================================================
// @velo/ui -- Storybook main config (FE-116 skeleton, tz-ui-package.md §3.4)
// =============================================================================
// The витрина is up in P1, not P7: every migrating batch (P2-P6) writes its
// stories in the same переносной PR -- "стории пишутся в батчах, не в
// конце" -- and checks each one against the component's Figma frame.
// =============================================================================

import type { StorybookConfig } from '@storybook/vue3-vite'

const config: StorybookConfig = {
  // The token registry page (§3.7) lives HERE, not in src/: it reads the
  // host's variables.css and the skin files as build-time ?raw inputs --
  // showcase tooling, which the boundary law (the kit never imports the
  // host) deliberately scopes OUT of src/**.
  stories: ['../src/**/*.stories.ts', '../.storybook/**/*.stories.ts'],
  framework: {
    name: '@storybook/vue3-vite',
    options: {},
  },
}

export default config
