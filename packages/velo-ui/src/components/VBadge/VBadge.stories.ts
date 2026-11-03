// =============================================================================
// @velo/ui -- VBadge story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// Written in the transfer PR and checked against the component's Figma frame.
// One story per variant -- the badge has no logic, the variant IS the design.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VBadge from './VBadge.vue'

const meta: Meta<typeof VBadge> = {
  title: 'VBadge',
  component: VBadge,
}

export default meta

type Story = StoryObj<typeof meta>

export const Info: Story = {
  render: () => ({
    components: { VBadge },
    template: '<VBadge>Info</VBadge>',
  }),
}

export const Success: Story = {
  render: () => ({
    components: { VBadge },
    template: '<VBadge variant="success">Confirmed</VBadge>',
  }),
}

export const Warning: Story = {
  render: () => ({
    components: { VBadge },
    template: '<VBadge variant="warning">Pending</VBadge>',
  }),
}

export const Error: Story = {
  render: () => ({
    components: { VBadge },
    template: '<VBadge variant="error">Cancelled</VBadge>',
  }),
}

export const Blue: Story = {
  render: () => ({
    components: { VBadge },
    template: '<VBadge variant="blue">Free</VBadge>',
  }),
}

export const Muted: Story = {
  render: () => ({
    components: { VBadge },
    template: '<VBadge variant="muted">No show</VBadge>',
  }),
}
