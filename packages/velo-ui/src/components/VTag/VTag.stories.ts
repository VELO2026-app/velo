// =============================================================================
// @velo/ui -- VTag story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// One story per variant, checked against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VTag from './VTag.vue'

const meta: Meta<typeof VTag> = {
  title: 'VTag',
  component: VTag,
}

export default meta

type Story = StoryObj<typeof meta>

export const Blue: Story = {
  render: () => ({
    components: { VTag },
    template: '<VTag variant="blue">Yoga</VTag>',
  }),
}

export const Pink: Story = {
  render: () => ({
    components: { VTag },
    template: '<VTag variant="pink">Meditation</VTag>',
  }),
}

export const Sand: Story = {
  render: () => ({
    components: { VTag },
    template: '<VTag variant="sand">Breathwork</VTag>',
  }),
}
