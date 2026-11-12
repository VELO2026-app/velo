// =============================================================================
// @velo/ui -- VConfirmDialog story (FE-145 P6b, the modal family;
// tz-ui-package.md §4 P6)
// =============================================================================
// The confirmation dialog over the shared VModal canon: the two-button
// row (labels are explicit -- the kit renders them pure, the host barrel
// anchors the localized defaults), the danger variant, and the peach
// warning panel.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VConfirmDialog from './VConfirmDialog.vue'

const meta: Meta<typeof VConfirmDialog> = {
  title: 'VConfirmDialog',
  component: VConfirmDialog,
}

export default meta

type Story = StoryObj<typeof meta>

export const Plain: Story = {
  render: () => ({
    components: { VConfirmDialog },
    template: `
      <VConfirmDialog
        :open="true"
        title="Delete the practice?"
        message="The schedule and every check-in will be lost."
        confirm-label="Delete"
        cancel-label="Not now"
      />
    `,
  }),
}

export const Danger: Story = {
  render: () => ({
    components: { VConfirmDialog },
    template: `
      <VConfirmDialog
        :open="true"
        message="Block this user for good?"
        confirm-label="Block"
        cancel-label="Cancel"
        danger
      />
    `,
  }),
}

export const WarningPanel: Story = {
  render: () => ({
    components: { VConfirmDialog },
    template: `
      <VConfirmDialog
        :open="true"
        title="Report the user?"
        message="The support team gets your report with this chat's history."
        confirm-label="Send"
        cancel-label="Cancel"
        warning-panel
        title-strong
      />
    `,
  }),
}
