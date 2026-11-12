// =============================================================================
// @velo/ui -- VLoader story (FE-140 -- tail of FE-117 batch A)
// =============================================================================
// The three sizes of the CSS-only spinner. The aria-label is host territory
// (§7.2: attrs land on the root); the showcase itself stays unlabeled.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VLoader from './VLoader.vue'

const meta: Meta<typeof VLoader> = {
  title: 'VLoader',
  component: VLoader,
}

export default meta

type Story = StoryObj<typeof meta>

export const Sm: Story = {
  render: () => ({
    components: { VLoader },
    template: '<VLoader size="sm" />',
  }),
}

export const Md: Story = {
  render: () => ({
    components: { VLoader },
    template: '<VLoader />',
  }),
}

export const Lg: Story = {
  render: () => ({
    components: { VLoader },
    template: '<VLoader size="lg" />',
  }),
}
