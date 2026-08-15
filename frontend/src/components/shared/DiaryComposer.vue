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

  Visual/behavioural changes from before this extraction (owner-approved via
  .tmp/composer-unification.html): the send button now sits INSIDE the
  bordered field instead of beside it (B38); the field is solid white in
  every state instead of a translucent rail that frosts on focus (B50); the
  autogrow cap is the flat DS token (--velo-textarea-autogrow-max, 240px) in
  every state instead of the old two-tier 120/300-viewport-bound formula --
  the viewport-aware version is track 3's job (B37/B39/B45/B46), not
  reproduced here. Everything else (draft persistence, the collapsed preview,
  the composingChange contract, the send/failure/in-flight guards) is
  unchanged in shape, now living in the shared component.
-->

<template>
  <Composer
    :placeholder="placeholder"
    :max-length="MAX_LEN"
    :send="handleSend"
    :draft-key="draftKey"
    show-draft-preview
    @sent="emit('created')"
    @composing-change="emit('composingChange', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Composer, { type ComposerSendResult } from './Composer.vue'
import { useDiaryStore } from '@/stores/diary'

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
