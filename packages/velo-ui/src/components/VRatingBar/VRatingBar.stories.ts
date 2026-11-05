// =============================================================================
// @velo/ui -- VRatingBar story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The rating-distribution row of the admin feedback detail: the three canon
// colours with their icons, the absolute-count suffix, and the stub state.
// Checked against the operator SVG "Rating distribution" frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VRatingBar from './VRatingBar.vue'

const meta: Meta<typeof VRatingBar> = {
  title: 'VRatingBar',
  component: VRatingBar,
}

export default meta

type Story = StoryObj<typeof meta>

export const Fire: Story = {
  render: () => ({
    components: { VRatingBar },
    template:
      '<VRatingBar label="Fire" :value="45" bar-color="var(--velo-peach-300)" icon-color="var(--velo-peach-500)"><template #icon><span>🔥</span></template></VRatingBar>',
  }),
}

export const Good: Story = {
  render: () => ({
    components: { VRatingBar },
    template:
      '<VRatingBar label="Good" :value="30" bar-color="var(--velo-teal-300)"><template #icon><span>👍</span></template></VRatingBar>',
  }),
}

export const QuestionsWithCount: Story = {
  render: () => ({
    components: { VRatingBar },
    template:
      '<VRatingBar label="Questions" :value="25" suffix="(5)" bar-color="var(--velo-pink-300)"><template #icon><span>❓</span></template></VRatingBar>',
  }),
}

export const Stub: Story = {
  render: () => ({
    components: { VRatingBar },
    template: '<VRatingBar label="Fire" :value="null" />',
  }),
}
