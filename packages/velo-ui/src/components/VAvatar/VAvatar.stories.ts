// =============================================================================
// @velo/ui -- VAvatar story (FE-117 batch A; tz-ui-package.md §4 P2)
// =============================================================================
// Every size, the square mark, and the initials->photo fade path (the image
// is an inline data URI so the showcase never depends on a network host).

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VAvatar from './VAvatar.vue'

const meta: Meta<typeof VAvatar> = {
  title: 'VAvatar',
  component: VAvatar,
}

export default meta

type Story = StoryObj<typeof meta>

const IMG_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23627a9c'/%3E%3C/svg%3E"

export const Sm: Story = {
  render: () => ({
    components: { VAvatar },
    template: '<VAvatar name="Maria K." size="sm" />',
  }),
}

export const Md: Story = {
  render: () => ({
    components: { VAvatar },
    template: '<VAvatar name="Maria K." size="md" />',
  }),
}

export const Lg: Story = {
  render: () => ({
    components: { VAvatar },
    template: '<VAvatar name="Maria K." size="lg" />',
  }),
}

export const Xl: Story = {
  render: () => ({
    components: { VAvatar },
    template: '<VAvatar name="Maria K." size="xl" />',
  }),
}

export const Square: Story = {
  render: () => ({
    components: { VAvatar },
    template: '<VAvatar name="Maria K." size="lg" square />',
  }),
}

export const WithImage: Story = {
  render: () => ({
    components: { VAvatar },
    setup: () => ({ imgUrl: IMG_DATA_URL }),
    template: '<VAvatar name="Maria K." size="lg" :url="imgUrl" />',
  }),
}
