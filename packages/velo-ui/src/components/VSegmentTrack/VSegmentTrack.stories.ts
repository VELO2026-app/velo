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

/**
 * FE-240: equal tabs whose labels are wider than their share, on a 320 px
 * screen's rail (272 px): each tab keeps its share (min-width: 0) and the
 * label uses the side padding, instead of the last tab running past the
 * track -- the members screen with the goodo skin's wider font.
 */
export const TabsNarrowLongLabels: Story = {
  render: () => ({
    components: { VSegmentTrack },
    setup: () => ({
      options: [
        { value: 'students', label: 'Students' },
        { value: 'masters', label: 'Masters' },
        { value: 'removed', label: 'Removed' },
      ],
    }),
    template:
      '<div style="width: 272px"><VSegmentTrack model-value="students" :options="options" variant="tabs" /></div>',
  }),
}
