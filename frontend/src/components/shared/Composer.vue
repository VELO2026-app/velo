<!--
  VELO Frontend -- Composer (shared, PROMPT №740, track 2)

  ONE composer serving both DiaryComposer (diary entries) and ChatThreadScreen
  (DM messages). Extracted after the .tmp/composer-unification.html preview
  was approved by the owner -- this component IS what that preview showed,
  built for real: B38 (bubble spans full width, send control lives INSIDE it,
  not as an outside sibling) / B47 (placeholder is a caller-supplied string,
  wired per consumer) / B48 (the send control renders only once there is
  text -- v-if, not a disabled state) / B50 (solid white fill via the
  existing --velo-bg-card-solid token) / B40 (bounded growth + internal
  scroll, `growCap`, structural to this component; see below).

  PROMPT №741 (track 3) restored what track 2 left as an unused extension
  point: `growCap` is now WIRED by both wrappers from
  `useComposerGrowCap.ts` (the live visual-viewport signal), and the field
  also scrolls itself into view on focus via `useKeyboardFieldScroll`
  (chat had this through VTextarea before track 2 removed the wrap; diary
  never had it -- both get it now, DS-wide default, additive only). Neither
  of these touches `#app-bg` / AppFrame's freeze mechanism (BG-ROOT, closed,
  do not reopen) -- both read an EXISTING published signal
  (`useViewportGeometry.ts`'s `visibleHeight`) or call the browser's own
  `scrollIntoView`, no new viewport machinery.

  What it absorbs from the two call sites it replaces (recon №735):
  (a) `send` is a PROP (text) => Promise<{ok, error?}> -- no store/API import
      here at all; each consumer supplies its own persistence.
  (b) `draftKey` is OPTIONAL. Set -> localStorage-persisted draft (diary's
      existing behaviour, unchanged in shape: `velo:diary:draft:${entryType}`
      lives in the DiaryComposer wrapper, not here). Unset -> no persistence
      at all -- chat drafts are NOT persisted, a deliberate decision, not an
      oversight (see the DONE report for why).
  (c) `composing-change` emits on focus/blur, unconditionally. DiaryFeedView
      depends on this from DiaryComposer; chat's wrapper simply does not
      listen to it. One emit, two consumers, one that uses it.
  (d) the viewport-aware autogrow diary had is NOT reproduced (track 3); what
      IS reproduced is the extensibility point (`growCap` as a prop, not a
      hardcoded formula) so track 3 can wire it in without touching this file
      again.

  `showDraftPreview` (diary-only, opt-in): when blurred with unsent text, show
  a single-line "start of the draft + ellipsis" instead of the placeholder --
  this is DiaryComposer's existing collapsed-preview behaviour (pre-dates this
  extraction, not one of B38/B47/B48/B50/B51, not shown in the approved
  preview). Preserved because nothing asked for its removal; off by default,
  chat does not use it.
-->

<template>
  <div class="composer" :class="{ 'composer--composing': composing }">
    <div class="composer__field" @click="focusField">
      <textarea
        v-show="!showingPreview"
        ref="inputEl"
        v-model="text"
        class="composer__input"
        :placeholder="placeholder"
        rows="1"
        :maxlength="maxLength"
        :disabled="submitting"
        :style="growCap != null ? { maxHeight: `${growCap}px` } : undefined"
        @input="autogrow"
        @focus="onTextareaFocus"
        @blur="onBlur"
      />
      <span v-if="showingPreview" class="composer__preview">{{ previewText }}</span>

      <!-- B38: the slot is now a CHILD of the bordered field, not an outside
           sibling. B48: v-if, not merely disabled -- absent while empty,
           exactly like the source this component replaces. -->
      <div class="composer__slot">
        <button
          v-if="canSend"
          type="button"
          class="composer__btn"
          aria-label="Отправить"
          :data-testid="sendTestId"
          :disabled="submitting"
          @pointerdown.prevent
          @click="onSend"
        >
          <IconSend :size="20" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { IconSend } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'

export interface ComposerSendResult {
  ok: boolean
  error?: string
}

const props = withDefaults(
  defineProps<{
    placeholder: string
    maxLength?: number
    /** (a): the consumer's own persistence -- this component calls it and
     *  interprets the result, never a store/API of its own. */
    send: (text: string) => Promise<ComposerSendResult>
    /** (b): set -> localStorage-persisted draft under this exact key;
     *  unset/null -> no persistence. */
    draftKey?: string | null
    /** (d): px cap for the bounded-growth textarea. Undefined leaves the CSS
     *  token (--velo-textarea-autogrow-max) as the sole mechanism -- the
     *  extension point for a future viewport-derived value, not exercised
     *  by either consumer today. */
    growCap?: number
    /** Diary-only opt-in, see file banner. */
    showDraftPreview?: boolean
    /** Preserves the `chat-send` test hook without a caller needing to know
     *  this component's internal class names. */
    sendTestId?: string
  }>(),
  {
    maxLength: 4000,
    draftKey: null,
    growCap: undefined,
    showDraftPreview: false,
    sendTestId: undefined,
  },
)

const emit = defineEmits<{
  sent: []
  composingChange: [composing: boolean]
}>()

const toast = useToast()
// DS-wide default (VInput/VSelect/VTextarea already use it): scrolls the
// field into view once the keyboard settles. Merge-safe -- Vue fires this
// AND the component's own `onFocus` below, same pattern those components use.
const { onFieldFocus } = useKeyboardFieldScroll()

const text = ref('')
const submitting = ref(false)
const composing = ref(false)
const inputEl = ref<HTMLTextAreaElement | null>(null)

const canSend = computed(() => text.value.trim().length > 0)

// (b) draft persistence -- opt-in via draftKey, unchanged shape from the
// diary composer this replaces.
function loadDraft(): void {
  if (!props.draftKey) {
    text.value = ''
    return
  }
  try {
    text.value = localStorage.getItem(props.draftKey) ?? ''
  } catch {
    text.value = ''
  }
  void nextTick(autogrow)
}

watch(text, (val) => {
  if (!props.draftKey) return
  try {
    if (val) localStorage.setItem(props.draftKey, val)
    else localStorage.removeItem(props.draftKey)
  } catch {
    /* storage unavailable (private mode / quota) -- ignore, draft is best-effort */
  }
})

watch(() => props.draftKey, loadDraft)

onMounted(() => {
  loadDraft()
})

// Diary-only: collapsed single-line preview when blurred with unsent text.
const showingPreview = computed(
  () => props.showDraftPreview && !composing.value && text.value.trim().length > 0,
)
const previewText = computed(() => text.value.replace(/\s*\n\s*/g, ' ').trim())

function setComposing(on: boolean): void {
  if (composing.value === on) return
  composing.value = on
  emit('composingChange', on)
}

function onFocus(): void {
  setComposing(true)
}

// Composes this component's own composingChange with the DS-wide
// scroll-into-view default -- both run off the same native focus event.
function onTextareaFocus(e: FocusEvent): void {
  onFocus()
  onFieldFocus(e)
}

function onBlur(): void {
  setComposing(false)
}

function focusField(): void {
  if (composing.value) return
  void nextTick(() => inputEl.value?.focus())
}

// B40: bounded growth, then internal scroll -- the CSS max-height (either the
// `growCap` inline style or the --velo-textarea-autogrow-max token) is the
// cap; this only feeds the textarea's own scrollHeight into it.
function autogrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

async function onSend(): Promise<void> {
  if (!canSend.value || submitting.value) return
  submitting.value = true
  try {
    const result = await props.send(text.value.trim())
    if (result.ok) {
      text.value = ''
      await nextTick()
      autogrow()
      emit('sent')
    } else {
      toast.error(result.error ?? 'Не удалось отправить')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.composer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

/* B38 + B50: one bordered, solid-white pill; the send slot lives INSIDE it.
   align-items: center at rest (single line); composing bottom-aligns so the
   growing field still sits level with the button (mirrors the pre-extraction
   diary composer's own idle/composing split). */
.composer__field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--velo-size-50);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  box-sizing: border-box;
  border: 1.26px solid rgba(255, 255, 255, 0.6);
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
  box-shadow: 0 0 14px 2px rgba(255, 255, 255, 0.4);
  cursor: text;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.composer__field:focus-within {
  border-color: var(--velo-border-input-focus);
  box-shadow: 0 0 0 3px var(--velo-glass-blue-60);
}

/* [FE-33] Focus must not MOVE anything. The old composing rule flipped the
   field's align-items center -> flex-end, which dropped the EMPTY field (and
   its placeholder + caret) a few px on tap -- felt as the whole input sinking.
   The field stays `align-items: center` at ALL times; only the SEND SLOT
   bottom-aligns once composing: the slot renders nothing while the field is
   empty (B48: the button is v-if'd on text), so the alignment change is
   invisible exactly when a jump would be noticeable, and pins the button to
   the bottom edge once the field grows multiline (the original intent). */
.composer--composing .composer__slot {
  align-self: flex-end;
}

.composer__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  line-height: 1.3;
  color: var(--velo-text-primary);
  /* [FE-33] Explicit caret colour: without it some engines fall back to a
     computed/inherit chain that renders the caret barely visible on the white
     pill. Same token as the text -- dark enough to read at a glance. */
  caret-color: var(--velo-text-primary);
  padding: var(--space-2) 0;
  /* B40: bounded growth, then internal scroll -- token by default, `growCap`
     overrides via inline style (see template). */
  max-height: var(--velo-textarea-autogrow-max);
  overflow-y: auto;
  transition: color var(--transition-fast);
}

/* [FE-25] Readable placeholder token. Was --velo-text-primary + opacity 0.6
   (≈2.57:1 on the white composer bar) -- readable now, and one source of
   truth with VInput/VTextarea instead of a hand-rolled fade. */
.composer__input::placeholder {
  color: var(--velo-text-placeholder);
}

.composer__preview {
  flex: 1;
  min-width: 0;
  align-self: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-primary);
  opacity: 0.85;
}

/* Fixed-width wrapper around the one action slot -- reserves the button's own
   footprint even when the button isn't rendered, so the row never jumps when
   it appears (B48). */
.composer__slot {
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
}

.composer__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  cursor: pointer;
  background: var(--velo-nav-active-bg);
  color: var(--velo-white);
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast);
}

.composer__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.composer__btn:not(:disabled):hover {
  opacity: 0.85;
}
</style>
