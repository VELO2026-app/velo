// =============================================================================
// @velo/ui -- VSwitch story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The notifications toggle in every state: off, on, on+disabled. Checked
// against the component's Figma frame (Profile redesign Screen E).

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VSwitch from './VSwitch.vue'

const meta: Meta<typeof VSwitch> = {
  title: 'VSwitch',
  component: VSwitch,
}

export default meta

type Story = StoryObj<typeof meta>

export const Off: Story = {
  render: () => ({
    components: { VSwitch },
    template: '<VSwitch :model-value="false" aria-label="Push notifications" />',
  }),
}

export const On: Story = {
  render: () => ({
    components: { VSwitch },
    template: '<VSwitch :model-value="true" aria-label="Push notifications" />',
  }),
}

export const OnDisabled: Story = {
  render: () => ({
    components: { VSwitch },
    template: '<VSwitch :model-value="true" disabled aria-label="Push notifications" />',
  }),
}
