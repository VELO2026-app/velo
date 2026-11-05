// =============================================================================
// @velo/ui -- VListRow story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// The row alone and with its lead/trailing slots (VAvatar as the lead
// visual -- cross-kit composition stays a relative import inside the kit).

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VListRow from './VListRow.vue'
import VAvatar from '../VAvatar/VAvatar.vue'

const meta: Meta<typeof VListRow> = {
  title: 'VListRow',
  component: VListRow,
}

export default meta

type Story = StoryObj<typeof meta>

export const Basic: Story = {
  render: () => ({
    components: { VListRow },
    template: '<VListRow title="Anna K." subtitle="15 practices - 3 masters" />',
  }),
}

export const WithLead: Story = {
  render: () => ({
    components: { VListRow, VAvatar },
    template:
      '<VListRow title="Anna K." subtitle="15 practices"><template #lead><VAvatar name="Anna K." /></template></VListRow>',
  }),
}

export const WithTrailing: Story = {
  render: () => ({
    components: { VListRow },
    template:
      '<VListRow title="Anna K." subtitle="Top loyal user"><template #trailing>€24,300</template></VListRow>',
  }),
}

export const Clickable: Story = {
  render: () => ({
    components: { VListRow },
    template: '<VListRow title="Anna K." subtitle="Tap to open" clickable />',
  }),
}
