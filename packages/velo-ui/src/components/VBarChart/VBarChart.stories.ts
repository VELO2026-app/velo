// =============================================================================
// @velo/ui -- VBarChart story (FE-118 P3; tz-ui-package.md §4 P3)
// =============================================================================
// The admin check-in weekly bars: alternating primary / blue-grey fills and
// the stub state (empty series renders the localized ui.noData fallback
// injected by the Storybook preview). Checked against the operator SVG
// "Check-in rate" frame.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VBarChart from './VBarChart.vue'

const meta: Meta<typeof VBarChart> = {
  title: 'VBarChart',
  component: VBarChart,
}

export default meta

type Story = StoryObj<typeof meta>

export const Weekly: Story = {
  render: () => ({
    components: { VBarChart },
    template:
      "<VBarChart :bars=\"[{ label: 'MO', value: 58 }, { label: 'TU', value: 72 }, { label: 'WE', value: 100 }, { label: 'TH', value: 64 }, { label: 'FR', value: 88 }, { label: 'SA', value: 31 }, { label: 'SU', value: 12 }]\" />",
  }),
}

export const Empty: Story = {
  render: () => ({
    components: { VBarChart },
    template: '<VBarChart :bars="[]" />',
  }),
}
