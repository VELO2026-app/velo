// =============================================================================
// @velo/ui -- icon family story (FE-119, tz-ui-package.md §4 P4)
// =============================================================================
// The whole 12-glyph family on one sheet: every icon rides currentColor,
// so the sheet paints them over the showcase's text color and a size
// sweep. IconRequiredDone's white check is the one token dependency of
// the family (inline `stroke: var(--velo-white)` -- an SVG presentation
// attribute cannot read var()); the host paints it through the cascade.
// Figma frame check of the sheet deferred: no Dev Mode MCP in this run.

import type { Meta, StoryObj } from '@storybook/vue3-vite'

import {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconClose,
  IconDots,
  IconFile,
  IconGroup,
  IconList,
  IconRequired,
  IconRequiredDone,
  IconSuccess,
  IconWarning,
} from './index'

// No `component` in the meta: the sheet showcases a family, not one SFC;
// the stories are render-based, the untyped meta loses nothing (the
// VSegmentTrack precedent).
const meta: Meta = {
  title: 'Icons',
}

export default meta

type Story = StoryObj<typeof meta>

const FAMILY = {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconClose,
  IconDots,
  IconFile,
  IconGroup,
  IconList,
  IconRequired,
  IconRequiredDone,
  IconSuccess,
  IconWarning,
}

export const Default24: Story = {
  render: () => ({
    components: FAMILY,
    template: `
      <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 16px;">
        <IconArrowRight /><IconCalendar /><IconCheck /><IconClose /><IconDots />
        <IconFile /><IconGroup /><IconList /><IconRequired /><IconRequiredDone />
        <IconSuccess /><IconWarning />
      </div>
    `,
  }),
}

export const SizeSweep: Story = {
  render: () => ({
    components: FAMILY,
    template: `
      <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; padding: 16px;">
        <IconCheck :size="16" /><IconCheck :size="20" /><IconCheck />
        <IconCheck :size="32" /><IconClose :size="16" /><IconClose :size="20" />
        <IconClose /><IconClose :size="32" />
      </div>
    `,
  }),
}
