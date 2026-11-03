// =============================================================================
// @velo/ui -- VPaginationDots story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The canonical screen-switch dots: 3-step and 5-step rows with different
// active positions. Checked against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VPaginationDots from './VPaginationDots.vue'

const meta: Meta<typeof VPaginationDots> = {
  title: 'VPaginationDots',
  component: VPaginationDots,
}

export default meta

type Story = StoryObj<typeof meta>

export const ThreeSteps: Story = {
  render: () => ({
    components: { VPaginationDots },
    template: '<VPaginationDots :total="3" :active="1" />',
  }),
}

export const FiveSlidesFirstActive: Story = {
  render: () => ({
    components: { VPaginationDots },
    template: '<VPaginationDots :total="5" :active="0" />',
  }),
}

export const FiveSlidesLastActive: Story = {
  render: () => ({
    components: { VPaginationDots },
    template: '<VPaginationDots :total="5" :active="4" />',
  }),
}
