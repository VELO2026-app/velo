// =============================================================================
// @velo/ui -- VStatCard story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The dashboard stat card: default column layout, row layout, icon + trend
// lines, the value tones, and the pending placeholder (§7.2 `pending` slot
// with the canonical fallback). Checked against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VStatCard from './VStatCard.vue'

const meta: Meta<typeof VStatCard> = {
  title: 'VStatCard',
  component: VStatCard,
}

export default meta

type Story = StoryObj<typeof meta>

export const Plain: Story = {
  render: () => ({
    components: { VStatCard },
    template: '<VStatCard value="156" label="participants" />',
  }),
}

export const WithIconAndDelta: Story = {
  render: () => ({
    components: { VStatCard },
    template:
      '<VStatCard value="€1,280" label="income" delta="+12%"><template #icon><span>💶</span></template></VStatCard>',
  }),
}

export const RowLayout: Story = {
  render: () => ({
    components: { VStatCard },
    template: '<VStatCard value="42" label="reviews" layout="row" />',
  }),
}

export const ValueTones: Story = {
  render: () => ({
    components: { VStatCard },
    template:
      '<div style="display: flex; gap: 12px"><VStatCard value="48" label="attended" value-tone="teal" /><VStatCard value="3" label="no-show" value-tone="rose" /></div>',
  }),
}

export const Pending: Story = {
  render: () => ({
    components: { VStatCard },
    template: '<VStatCard value="156" label="participants" value-pending />',
  }),
}
