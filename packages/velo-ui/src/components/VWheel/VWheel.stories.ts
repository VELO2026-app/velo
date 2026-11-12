// =============================================================================
// @velo/ui -- VWheel story (FE-140 batch B; tz-ui-package.md §4 P2)
// =============================================================================
// The iOS-style snap wheel as the date/time pickers use it: a 24-hour column
// and a month column (interactive -- scroll or tap; the centred row is the
// selection). Checked against the component's Figma frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import { ref } from 'vue'

import VWheel from './VWheel.vue'

const meta: Meta<typeof VWheel> = {
  title: 'VWheel',
  component: VWheel,
}

export default meta

type Story = StoryObj<typeof meta>

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: String(h) }))

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((label, i) => ({ value: String(i), label }))

export const Hours: Story = {
  render: () => ({
    components: { VWheel },
    setup: () => ({ hour: ref('14'), hours: HOURS }),
    template: '<VWheel v-model="hour" :options="hours" />',
  }),
}

export const Months: Story = {
  render: () => ({
    components: { VWheel },
    setup: () => ({ month: ref('9'), months: MONTHS }),
    template: '<VWheel v-model="month" :options="months" />',
  }),
}
