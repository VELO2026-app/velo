// =============================================================================
// @velo/ui -- VModal story (FE-145 P6b, the modal family; tz-ui-package.md
// §4 P6)
// =============================================================================
// The centered dialog over its frosted scrim: the canonical open state
// (with the pure `closeLabel` prop the host barrel anchors its localized
// default onto), the × -less variant, and the tap-proof one. The dialog
// teleports to body -- in the canvas it covers the story area, which is
// the point.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VModal from './VModal.vue'

const meta: Meta<typeof VModal> = {
  title: 'VModal',
  component: VModal,
}

export default meta

type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: () => ({
    components: { VModal },
    template: `
      <VModal :open="true" close-label="Close">
        <h2>Delete the practice?</h2>
        <p>The centered dialog canon: white sheet, all corners rounded, an × in the corner.</p>
      </VModal>
    `,
  }),
}

export const WithoutCloseButton: Story = {
  render: () => ({
    components: { VModal },
    template: `
      <VModal :open="true" :show-close="false">
        <h2>No × corner</h2>
        <p>Content-only sheet -- the caller drives every close path itself.</p>
      </VModal>
    `,
  }),
}

export const TapProof: Story = {
  render: () => ({
    components: { VModal },
    template: `
      <VModal :open="true" close-label="Close" :close-on-overlay="false">
        <h2>Tap-proof</h2>
        <p>The scrim tap is off -- only the × (or Escape) closes this one.</p>
      </VModal>
    `,
  }),
}
