// =============================================================================
// @velo/ui -- VSegment story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The two-pill filter strip: full-width default, the compact inline toggle,
// the scrollable many-tabs variant, and the optional count badge. Checked
// against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VSegment from './VSegment.vue'

const meta: Meta<typeof VSegment> = {
  title: 'VSegment',
  component: VSegment,
}

export default meta

type Story = StoryObj<typeof meta>

const OPTIONS = [
  { value: 'upcoming', label: 'Upcoming', badge: 3 },
  { value: 'past', label: 'Past' },
]

const MANY = [
  { value: 'new', label: 'New' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'done', label: 'Done' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'archived', label: 'Archived' },
]

export const FilterStrip: Story = {
  render: () => ({
    components: { VSegment },
    setup: () => ({ options: OPTIONS }),
    template: '<VSegment model-value="upcoming" :options="options" />',
  }),
}

export const CompactToggle: Story = {
  render: () => ({
    components: { VSegment },
    setup: () => ({ options: OPTIONS }),
    template: '<VSegment model-value="past" :options="options" compact />',
  }),
}

export const ScrollableTabs: Story = {
  render: () => ({
    components: { VSegment },
    setup: () => ({ options: MANY }),
    template:
      '<div style="max-width: 320px"><VSegment model-value="confirmed" :options="options" scrollable /></div>',
  }),
}
