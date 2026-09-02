<!--
  VELO Frontend -- DiaryComposer (Diary redesign)

  Thin per-consumer wrapper over the shared `Composer.vue` (PROMPT №740,
  track 2 -- the extraction that also serves ChatThreadScreen). This file
  keeps DiaryComposer's OWN public contract byte-identical (props: entryType;
  emits: created, composingChange) so DiaryFeedView needs no changes at all --
  it supplies diary's three consumer-specific things the shared component
  does not know about: which store persists an entry (`send`), which
  localStorage key holds the draft (`draftKey`), and the collapsed-preview
  opt-in (`showDraftPreview`, diary-only, pre-dates this extraction).

  [FE-42] The mic is TEMPORARILY HIDDEN in the diary: this wrapper no longer
  passes `voice-stub`, and the shared Composer's mic disc is a v-if on that
  prop -- off means fully unmounted, zero reserved space (the field spans the
  whole line; nothing changes with text). Text input, drafts and text send
  are untouched -- every other behaviour below is as before. ChatThreadScreen
  still passes COMPOSER_VOICE_STUB (constants keep it); when the real voice
  recorder lands, re-add `:voice-stub="COMPOSER_VOICE_STUB"` here.

  Visual/behavioural changes from before this extraction (owner-approved via
  .tmp/composer-unification.html): the send button now sits INSIDE the
  bordered field instead of beside it (B38); the field is solid white in
  every state instead of a translucent rail that frosts on focus (B50).
  The autogrow cap went flat (--velo-textarea-autogrow-max, 240px) in track 2
  and is VIEWPORT-AWARE AGAIN as of track 3 (PROMPT №741) via
  `useComposerGrowCap` -- same formula, same constants, same numbers as
  before this extraction (see that file). Everything else (draft persistence,
  the collapsed preview, the composingChange contract, the send/failure/
  in-flight guards) is unchanged in shape, now living in the shared component.
-->

<template>
  <Composer
    :placeholder="placeholder"
    :max-length="MAX_LEN"
    :send="handleSend"
    :draft-key="draftKey"
    :grow-cap="growCap"
    show-draft-preview
    @sent="emit('created')"
    @composing-change="onComposingChange"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Composer, { type ComposerSendResult } from './Composer.vue'
import { useDiaryStore } from '@/stores/diary'
import { useComposerGrowCap } from '@/composables/useComposerGrowCap'

const MAX_LEN = 10000

const props = withDefaults(
  defineProps<{
    /** Target diary entry type, decided by the parent from the active filter. */
    entryType?: 'note' | 'dream'
  }>(),
  { entryType: 'note' },
)

const emit = defineEmits<{
  created: []
  /** Field focused / blurred -- the parent toggles its dim scrim. */
  composingChange: [composing: boolean]
}>()

const diaryStore = useDiaryStore()

const placeholder = computed(() =>
  props.entryType === 'dream' ? 'Запишите сон...' : 'Начните писать...',
)

// (b): diary keeps its existing per-target localStorage key, unchanged shape.
const draftKey = computed(() => `velo:diary:draft:${props.entryType}`)

// PROMPT №741: mirrors what composingChange used to drive locally before the
// extraction -- this wrapper needs its OWN copy of `composing` to feed
// useComposerGrowCap, independent of the shared Composer's internal one.
const composing = ref(false)
const growCap = useComposerGrowCap(composing)

function onComposingChange(value: boolean): void {
  composing.value = value
  emit('composingChange', value)
}

// (a): the shared component owns nothing about persistence -- this is the
// whole reason `send` is a prop.
async function handleSend(content: string): Promise<ComposerSendResult> {
  const result = await diaryStore.createEntry({
    content,
    entry_type: props.entryType,
  })
  return { ok: result.ok, error: result.error }
}
</script>
