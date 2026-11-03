// =============================================================================
// @velo/ui -- VChip story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// The two roles (static tag / selectable filter chip) and every visual state
// of the selectable role, checked against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VChip from './VChip.vue'

const meta: Meta<typeof VChip> = {
  title: 'VChip',
  component: VChip,
}

export default meta

type Story = StoryObj<typeof meta>

export const StaticSm: Story = {
  render: () => ({
    components: { VChip },
    template: '<VChip>Meditation</VChip>',
  }),
}

export const StaticMd: Story = {
  render: () => ({
    components: { VChip },
    template: '<VChip size="md">Meditation</VChip>',
  }),
}

export const Clickable: Story = {
  render: () => ({
    components: { VChip },
    template: '<VChip size="md" clickable>Notes</VChip>',
  }),
}

export const Active: Story = {
  render: () => ({
    components: { VChip },
    template: '<VChip size="md" clickable active :aria-pressed="true">Notes</VChip>',
  }),
}

export const Existing: Story = {
  render: () => ({
    components: { VChip },
    template: '<VChip size="md" clickable existing :aria-pressed="true">Notes</VChip>',
  }),
}
