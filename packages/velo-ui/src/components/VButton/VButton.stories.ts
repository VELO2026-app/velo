// =============================================================================
// @velo/ui -- VButton story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// Every variant x the canonical sizes, plus the block/disabled/loading
// states -- the spinner slot carries the default spinner in all of them.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VButton from './VButton.vue'

const meta: Meta<typeof VButton> = {
  title: 'VButton',
  component: VButton,
}

export default meta

type Story = StoryObj<typeof meta>

export const Primary: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton>Save</VButton>',
  }),
}

export const Secondary: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton variant="secondary">Cancel</VButton>',
  }),
}

export const Danger: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton variant="danger">Delete</VButton>',
  }),
}

export const Ghost: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton variant="ghost">Show more</VButton>',
  }),
}

export const OutlineAlias: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton variant="outline">Outline (alias of secondary)</VButton>',
  }),
}

export const Small: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton size="sm">Small</VButton>',
  }),
}

export const LargeAlias: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton size="lg">Large (alias of md)</VButton>',
  }),
}

export const Block: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton block>Full width</VButton>',
  }),
}

export const Disabled: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton disabled>Disabled</VButton>',
  }),
}

export const Loading: Story = {
  render: () => ({
    components: { VButton },
    template: '<VButton loading>Loading</VButton>',
  }),
}
