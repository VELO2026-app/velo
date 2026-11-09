// =============================================================================
// @velo/ui -- VTextarea story (FE-153; tz-ui-package.md §4 P6/P8)
// =============================================================================
// The multiline field in its states: plain, required (empty / filled),
// error, autogrow, bordered-at-rest, disabled, plus the FE-153 slots --
// #trailing (the app puts its voice mic there) and #takeover (the app's
// recording panel replaces the field for the span of a take).

import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { ref } from 'vue'

import VTextarea from './VTextarea.vue'

const meta: Meta<typeof VTextarea> = {
  title: 'VTextarea',
  component: VTextarea,
}

export default meta

type Story = StoryObj<typeof meta>

/** A two-way bound field; the template is the variant. */
function field(template: string, initial = ''): Story {
  return {
    render: () => ({
      components: { VTextarea },
      setup: () => ({ text: ref(initial) }),
      template,
    }),
  }
}

export const Default = field(
  '<VTextarea v-model="text" label="About" :rows="4" placeholder="Tell us about yourself" />',
)

export const RequiredEmpty = field('<VTextarea v-model="text" label="Description" required />')

export const RequiredFilled = field(
  '<VTextarea v-model="text" label="Description" required />',
  'Morning practice by the sea.',
)

export const WithError = field(
  '<VTextarea v-model="text" label="Reason" error="Please describe the reason" />',
)

export const Autogrow = field(
  '<VTextarea v-model="text" label="Thoughts" autogrow :rows="1" placeholder="Type -- the field grows" />',
)

export const BorderedAtRest = field(
  '<VTextarea v-model="text" label="Message" bordered-at-rest placeholder="Write a message" />',
)

export const Disabled = field(
  '<VTextarea v-model="text" label="About" disabled />',
  'Read-only text',
)

/** #trailing: the row's right end. The app's VoiceTextarea puts the mic disc
 *  here; a plain button stands in for it. */
export const TrailingSlot = field(
  `<VTextarea v-model="text" label="Thoughts" :rows="5" maxlength="2000">
    <template #trailing>
      <button type="button" aria-label="Trailing action">+</button>
    </template>
  </VTextarea>`,
  'Text already present',
)

/** #takeover: while `takeover` is on, the slot holds the field's place
 *  (fixed-rows: on the field's own plate). The app renders its voice
 *  recording panel here. */
export const Takeover = field(
  `<VTextarea v-model="text" label="Thoughts" :rows="5" takeover>
    <template #takeover>
      <span>Recording... 0:07</span>
    </template>
  </VTextarea>`,
  'Hidden while the takeover owns the row',
)
