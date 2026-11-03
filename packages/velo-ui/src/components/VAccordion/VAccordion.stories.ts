// =============================================================================
// @velo/ui -- VAccordion story (FE-118 P3; tz-ui-package.md §4 P3)
// =============================================================================
// The DS-3 expandable row: collapsed and pre-opened states, the additive
// #icon slot, and a #chevron slot override driving its own rotation.
// Checked against the DS-3 detail blocks (the master practice detail
// sections render this component).

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import VAccordion from './VAccordion.vue'

const meta: Meta<typeof VAccordion> = {
  title: 'VAccordion',
  component: VAccordion,
}

export default meta

type Story = StoryObj<typeof meta>

export const Collapsed: Story = {
  render: () => ({
    components: { VAccordion },
    template:
      '<VAccordion title="Description"><p>Hidden content: the description of the practice, terms and contraindications.</p></VAccordion>',
  }),
}

export const StartedOpen: Story = {
  render: () => ({
    components: { VAccordion },
    template:
      '<VAccordion title="Description" default-open><p>The body renders on first paint when default-open is set.</p></VAccordion>',
  }),
}

export const WithLeadingIcon: Story = {
  render: () => ({
    components: { VAccordion },
    template:
      '<VAccordion title="Schedule"><template #icon><span>🕐</span></template><p>The #icon slot is additive: without it the row renders exactly as before.</p></VAccordion>',
  }),
}

export const CustomChevron: Story = {
  render: () => ({
    components: { VAccordion },
    template:
      '<VAccordion title="Description"><template #chevron="{ open }"><span>{{ open ? "−" : "+" }}</span></template><p>The #chevron override receives { open } and drives its own glyph.</p></VAccordion>',
  }),
}
