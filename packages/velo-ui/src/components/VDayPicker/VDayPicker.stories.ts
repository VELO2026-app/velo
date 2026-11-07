// =============================================================================
// @velo/ui -- VDayPicker story (FE-118 P3; tz-ui-package.md §4 P3)
// =============================================================================
// The master notifications day-of-week row: empty, workdays, and the full
// week. Day names render through the host translator injected by the
// Storybook preview (ui.dayShort / ui.dayFull families). Checked against
// the operator SVG "6 Notifications 3" frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VDayPicker from './VDayPicker.vue'

const meta: Meta<typeof VDayPicker> = {
  title: 'VDayPicker',
  component: VDayPicker,
}

export default meta

type Story = StoryObj<typeof meta>

export const NoneSelected: Story = {
  render: () => ({
    components: { VDayPicker },
    template: '<VDayPicker v-model="days" />',
    setup() {
      return { days: [] }
    },
  }),
}

export const Workdays: Story = {
  render: () => ({
    components: { VDayPicker },
    template: '<VDayPicker v-model="days" />',
    setup() {
      return { days: ['mon', 'tue', 'wed', 'thu', 'fri'] }
    },
  }),
}

export const FullWeek: Story = {
  render: () => ({
    components: { VDayPicker },
    template: '<VDayPicker v-model="days" aria-label="Every day" />',
    setup() {
      return { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }
    },
  }),
}
