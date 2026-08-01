<!--
  VELO Frontend -- DiaryComposer (Diary redesign)

  Bottom composer for the diary feed. Creates a diary entry via the store; the
  target entry_type ('note' for Дневник, 'dream' for Сонник) is decided by the
  parent from the active filter and passed in as `entryType`.

  Behaviour (rebuilt PROMPT №629, owner rulings 1-7; T24-3 removed the mic):
  - Idle: a borderless "rail" field (translucent white outline + soft glow,
    matches the floating-glass chrome) plus ONE action slot on the right,
    constant width -- EMPTY while the field is empty, send once there is text.
  - Compose (field focused): the parent dims the feed (opacity fade, unchanged
    -- the owner's own tuning); the feed itself stays visible (T24-2 removed
    the feed-wide frost the parent used to show). The field itself carries a
    slight frost of its own now, so typed text stays readable over the visible
    feed behind it. Still one row with the slot button; the field grows in height,
    capped to ~1/3 of the on-screen keyboard's own height (see autogrow()),
    then scrolls internally. Emits `composingChange` so the parent can toggle
    its dim scrim.
  - Collapsed with a draft: when blurred with unsent text, the field shows the
    START of that text + ellipsis (single line) instead of the placeholder, so
    the frame does not stay expanded. Tapping it re-opens compose.
  - Enter inserts a newline (send is the slot button only).
  - The unsent draft is mirrored to localStorage (keyed by entryType) on every
    keystroke, so it survives keyboard collapse / accidental navigation on iOS,
    and an outside tap while composing (native blur -- no explicit handler
    here; the parent's scrim just happens to sit in the way).
  - The kb-collapse chevron is gone: closing the keyboard is an outside tap or
    the keyboard's own dismiss, matching Telegram's model.

  Emits `created` after a successful entry so the parent can react.
-->

<template>
  <div class="composer" :class="{ 'composer--composing': composing }">
    <div class="composer__field" @click="openCompose">
      <textarea
        v-show="!showPreview"
        ref="inputEl"
        v-model="text"
        class="composer__input"
        :placeholder="placeholder"
        rows="1"
        :maxlength="MAX_LEN"
        :disabled="submitting"
        @input="autogrow"
        @focus="onFocus"
        @blur="onBlur"
      />
      <span v-if="showPreview" class="composer__preview">{{ previewText }}</span>
    </div>

    <!-- T24-3: the mic is gone (voice input was never wired up and must not
         tease the user); the one action slot is EMPTY while the field is
         empty and holds ONLY the send button once there is text -- never a
         disabled placeholder (the owner's reasoning: a greyed-out button
         teases the same way the mic did). The wrapper holds a CONSTANT WIDTH
         either way so the row never jumps when the button appears. -->
    <div class="composer__slot">
      <button
        v-if="canSend"
        type="button"
        class="composer__btn"
        aria-label="Отправить"
        :disabled="submitting"
        @pointerdown.prevent
        @click="onSend"
      >
        <IconSend :size="20" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { IconSend } from '@/components/icons'
import { useDiaryStore } from '@/stores/diary'
import { useToast } from '@/composables/useToast'
import { visibleHeight } from '@/composables/useViewportGeometry'

const MAX_LEN = 10000

// Ruling 3 (owner, PROMPT №630 -- corrects PROMPT №629's keyboard-height read):
// the composing cap is the owner's OWN figure, ~1/3 of the SCREEN -- a fixed
// 300px, not derived from the keyboard at all. BOUND: on a short device 300px
// may not fit above the keyboard, and the field must never reach the header --
// so the effective cap is min(300, whatever the VISUAL viewport actually
// leaves above the composer chrome), the visual viewport already excluding the
// keyboard. COMPOSING_CHROME_OFFSET (96px composer chrome + 80px top gap) is
// the same geometry the pre-rebuild formula already cleared -- this bound is a
// physical limit, NOT a second guess at the owner's 300. FLOOR keeps a very
// short viewport from collapsing the field to one line.
const COMPOSING_HEIGHT_TARGET = 300
const COMPOSING_CHROME_OFFSET = 176
const COMPOSING_HEIGHT_FLOOR = 80
// Collapsed (non-composing) cap -- unchanged from before this rebuild.
const COLLAPSED_HEIGHT_CAP = 120

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
const toast = useToast()

const text = ref('')
const submitting = ref(false)
const composing = ref(false)
const inputEl = ref<HTMLTextAreaElement | null>(null)

const placeholder = computed(() =>
  props.entryType === 'dream' ? 'Запишите сон...' : 'Начните писать...',
)
const canSend = computed(() => text.value.trim().length > 0)

// Collapsed-with-draft preview: when not composing but there is unsent text,
// show its start (+ CSS ellipsis) instead of the empty placeholder.
const showPreview = computed(() => !composing.value && text.value.trim().length > 0)
const previewText = computed(() => text.value.replace(/\s*\n\s*/g, ' ').trim())

// -- Draft persistence (localStorage, keyed by target) -----------------------
// Survives keyboard collapse / navigation (iOS loses in-memory state); cleared
// on a successful send.
const draftKey = computed(() => `velo:diary:draft:${props.entryType}`)

function loadDraft(): void {
  try {
    text.value = localStorage.getItem(draftKey.value) ?? ''
  } catch {
    text.value = ''
  }
  void nextTick(autogrow)
}

watch(text, (val) => {
  try {
    if (val) localStorage.setItem(draftKey.value, val)
    else localStorage.removeItem(draftKey.value)
  } catch {
    /* storage unavailable (private mode / quota) -- ignore, draft is best-effort */
  }
})

// Switching Дневник <-> Сонник swaps to that target's own draft.
watch(() => props.entryType, loadDraft)

// Recompute the grow cap when the visual viewport changes (iOS keyboard show /
// hide), since the available space above the keyboard bounds the composing
// cap. PROMPT №657: reads the shared `visibleHeight` ref from
// useViewportGeometry.ts instead of its own visualViewport listener -- one
// less independent reader of the raw platform signal.
watch(visibleHeight, () => {
  if (composing.value) autogrow()
})

onMounted(() => {
  loadDraft()
})

// -- Compose focus state -----------------------------------------------------

function setComposing(on: boolean): void {
  if (composing.value === on) return
  composing.value = on
  emit('composingChange', on)
  // The grow cap depends on compose mode -- recompute once the class applies.
  void nextTick(autogrow)
}

function onFocus(): void {
  setComposing(true)
}

function onBlur(): void {
  setComposing(false)
}

// Open compose from a tap on the (possibly collapsed-preview) field: show the
// textarea first, then focus it (a display:none textarea can't be focused).
function openCompose(): void {
  if (composing.value) return
  setComposing(true)
  void nextTick(() => inputEl.value?.focus())
}

// Grow the textarea with content, then scroll internally past the cap.
// Collapsed: unchanged fixed cap. Composing: the owner's 300px screen-third
// figure, bounded by what the visual viewport actually leaves above the
// composer chrome -- a physical limit, not a second guess at his number.
function autogrow(): void {
  const el = inputEl.value
  if (!el) return
  // PROMPT №657: the shared visibleHeight ref (useViewportGeometry.ts), not
  // a bare window.visualViewport read -- falls back to innerHeight only if
  // the module never published (no visualViewport support at all; a real
  // published height is never 0).
  const vh = visibleHeight.value || window.innerHeight
  const cap = composing.value
    ? Math.max(
        COMPOSING_HEIGHT_FLOOR,
        Math.min(COMPOSING_HEIGHT_TARGET, vh - COMPOSING_CHROME_OFFSET),
      )
    : COLLAPSED_HEIGHT_CAP
  el.style.maxHeight = `${cap}px`
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, cap)}px`
}

async function onSend(): Promise<void> {
  if (!canSend.value || submitting.value) return
  submitting.value = true
  try {
    const result = await diaryStore.createEntry({
      content: text.value.trim(),
      entry_type: props.entryType,
    })
    if (result.ok) {
      text.value = '' // watch() clears the stored draft
      await nextTick()
      autogrow()
      emit('created')
    } else {
      toast.error(result.error)
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* Transparent flex container -- the field + slot button float on it; nothing
   opaque here so the feed shows through the gaps between them. One row in
   both states (ruling 4): idle centers it, composing bottom-aligns it so the
   growing field still sits level with the button. */
.composer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

/* The "rail" field: borderless, translucent white outline + soft glow (matches
   the floating-glass chrome). No solid fill -- keeps the airy look. */
.composer__field {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: var(--velo-size-50);
  padding: var(--space-2) var(--space-4);
  box-sizing: border-box;
  border: 1.26px solid rgba(255, 255, 255, 0.6);
  border-radius: var(--radius-full);
  box-shadow: 0 0 14px 2px rgba(255, 255, 255, 0.4);
  cursor: text;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
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
  max-height: 120px;
  overflow-y: auto;
  transition: color var(--transition-fast);
}

.composer__input::placeholder {
  color: var(--velo-text-primary);
  opacity: 0.6;
}

/* Collapsed-with-draft single-line preview (start of text + ellipsis). */
.composer__preview {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-primary);
  opacity: 0.85;
}

/* T24-3: fixed-width wrapper around the one action slot -- always reserves
   the button's own 44px footprint (even when the button isn't rendered), so
   the row never jumps when the send button appears on the first keystroke. */
.composer__slot {
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
}

/* SOLID round send button -- #627A9C, no glass; icon stays readable on any
   backdrop. 44px circle (Figma Group 2545). Renders ONLY once there is text
   (T24-3 removed the mic and the greyed-out-when-empty state alike -- the
   owner's reasoning: a disabled button teases the same way the mic did). */
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
    background var(--transition-fast),
    color var(--transition-fast);
}

.composer__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.composer__btn:not(:disabled):hover {
  opacity: 0.85;
}

/* -- Compose mode: still one row with the slot button (ruling 4); the field
   just grows taller and bottom-aligns against it. -- */
.composer--composing {
  align-items: flex-end;
}

.composer--composing .composer__field {
  min-height: 54px;
  align-items: flex-start;
  padding: var(--velo-card-padding-y) var(--velo-inset-row);
  border-color: var(--velo-nav-active-bg);
  box-shadow: none;
  border-radius: 20px;
  /* T24-2: the feed-wide frost moved OFF the feed and onto just this field, so
     typed text still reads clearly over the now-visible feed behind it. Same
     tokens the feed scrim used to use -- variables.css already documents
     --velo-write-blur as serving "scrim + composer field". */
  background: var(--velo-write-frost);
  -webkit-backdrop-filter: blur(var(--velo-write-blur));
  backdrop-filter: blur(var(--velo-write-blur));
}

.composer--composing .composer__input::placeholder {
  opacity: 0.55;
}
</style>
