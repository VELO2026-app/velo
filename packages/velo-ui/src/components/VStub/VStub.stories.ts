// =============================================================================
// @velo/ui -- VStub story (the ONE story of the P1 skeleton, FE-116 §3.4)
// =============================================================================
// Storybook is up in P1, not P7: every following batch (P2-P6) writes its
// stories IN the переносной PR and checks them against the Figma frame --
// "стории пишутся в батчах, не в конце". This story exists so the skeleton
// itself is proven; it goes away with VStub in batch A.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VStub from './VStub.vue'

const meta: Meta<typeof VStub> = {
  title: 'VStub',
  component: VStub,
}

export default meta

export const Default: StoryObj<typeof meta> = {
  render: () => ({
    components: { VStub },
    template: '<VStub>@velo/ui pipeline specimen</VStub>',
  }),
}
