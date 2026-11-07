// =============================================================================
// @velo/ui -- VBottomSheet story (FE-145 P6b, the modal family;
// tz-ui-package.md §4 P6)
// =============================================================================
// The flush bottom sheet: content-only, the lone save footer, and the
// paired cancel/save row (the owner's position-based colours plus the one
// ruled inversion), with the compact/strong title modifiers. Every label
// is caller copy -- the component is pure by design, no seam to showcase.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VBottomSheet from './VBottomSheet.vue'

const meta: Meta<typeof VBottomSheet> = {
  title: 'VBottomSheet',
  component: VBottomSheet,
}

export default meta

type Story = StoryObj<typeof meta>

export const Plain: Story = {
  render: () => ({
    components: { VBottomSheet },
    template: `
      <VBottomSheet :open="true" title="Practice date">
        <p>The flush sheet canon: grab handle, big title, content, rounded top only -- dismissed by the scrim.</p>
      </VBottomSheet>
    `,
  }),
}

export const WithSave: Story = {
  render: () => ({
    components: { VBottomSheet },
    template: `
      <VBottomSheet :open="true" title="Practice date" save-label="Save">
        <p>The lone full-width save footer.</p>
      </VBottomSheet>
    `,
  }),
}

export const PairedActions: Story = {
  render: () => ({
    components: { VBottomSheet },
    template: `
      <VBottomSheet
        :open="true"
        title="Report the user"
        compact-title
        title-strong
        save-label="Send"
        cancel-label="Cancel"
      >
        <p>The paired row (cancel blue left, save coral right) with the compact strong title.</p>
      </VBottomSheet>
    `,
  }),
}

export const PairedActionsInverted: Story = {
  render: () => ({
    components: { VBottomSheet },
    template: `
      <VBottomSheet
        :open="true"
        title="Add to the group"
        save-label="Add"
        cancel-label="Cancel"
        cancel-variant="danger"
        save-variant="primary"
      >
        <p>The one owner-ruled inversion: cancel coral left, save blue right.</p>
      </VBottomSheet>
    `,
  }),
}
