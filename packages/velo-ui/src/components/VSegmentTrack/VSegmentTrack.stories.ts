// =============================================================================
// @velo/ui -- VSegmentTrack story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The operator-approved track+thumb idiom in both shapes (compact toggle
// pills / full-width equal tabs) plus the scrollable many-tabs composition.
// Checked against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VSegmentTrack from './VSegmentTrack.vue'

// No `component` in the meta: the SFC is generic (`generic="T extends
// string"`), which Meta<typeof ...> cannot type; the stories are
// render-based, so the untyped meta loses nothing.
const meta: Meta = {
  title: 'VSegmentTrack',
}

export default meta

type Story = StoryObj<typeof meta>

const PERIODS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

const TABS = [
  { value: 'practices', label: 'Practices' },
  { value: 'analytics', label: 'Analytics' },
]

export const Toggle: Story = {
  render: () => ({
    components: { VSegmentTrack },
    setup: () => ({ options: PERIODS }),
    template: '<VSegmentTrack model-value="week" :options="options" variant="toggle" />',
  }),
}

export const Tabs: Story = {
  render: () => ({
    components: { VSegmentTrack },
    setup: () => ({ options: TABS }),
    template: '<VSegmentTrack model-value="practices" :options="options" variant="tabs" />',
  }),
}

export const TabsScrollable: Story = {
  render: () => ({
    components: { VSegmentTrack },
    setup: () => ({
      options: [...TABS, { value: 'income', label: 'Income' }, { value: 'promo', label: 'Promo' }],
    }),
    template:
      '<div style="max-width: 320px"><VSegmentTrack model-value="analytics" :options="options" variant="tabs" scrollable /></div>',
  }),
}
