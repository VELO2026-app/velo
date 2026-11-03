// =============================================================================
// @velo/ui -- VCard story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// The white card canon with its padding variants and the clickable state.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VCard from './VCard.vue'

const meta: Meta<typeof VCard> = {
  title: 'VCard',
  component: VCard,
}

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => ({
    components: { VCard },
    template: '<VCard>Card content (padding md)</VCard>',
  }),
}

export const PaddingSm: Story = {
  render: () => ({
    components: { VCard },
    template: '<VCard padding="sm">Compact card (padding sm)</VCard>',
  }),
}

export const NoPadding: Story = {
  render: () => ({
    components: { VCard },
    template: '<VCard padding="none">Edge-to-edge (own padding on the class)</VCard>',
  }),
}

export const Clickable: Story = {
  render: () => ({
    components: { VCard },
    template: '<VCard clickable>Clickable card</VCard>',
  }),
}
