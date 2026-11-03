// =============================================================================
// @velo/ui -- VMetricHero story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The admin metric-detail hero: real value and the stub-friendly dash, both
// with the glass-teal icon circle. Checked against the operator SVG
// check-in/feedback/return frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VMetricHero from './VMetricHero.vue'

const meta: Meta<typeof VMetricHero> = {
  title: 'VMetricHero',
  component: VMetricHero,
}

export default meta

type Story = StoryObj<typeof meta>

export const CheckInRate: Story = {
  render: () => ({
    components: { VMetricHero },
    template:
      '<VMetricHero value="78%" label="Average check-in rate"><template #icon><span>✅</span></template></VMetricHero>',
  }),
}

export const Feedback: Story = {
  render: () => ({
    components: { VMetricHero },
    template:
      '<VMetricHero value="4.6" label="Average rating"><template #icon><span>⭐</span></template></VMetricHero>',
  }),
}

export const Stub: Story = {
  render: () => ({
    components: { VMetricHero },
    template:
      '<VMetricHero value="—" label="Return rate"><template #icon><span>↩️</span></template></VMetricHero>',
  }),
}
