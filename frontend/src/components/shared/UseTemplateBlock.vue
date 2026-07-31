<!--
  VELO Frontend -- UseTemplateBlock (CreatePracticeView «Использовать шаблон»)

  Collapsible block at the top of the create-practice form: pick one of the
  master's own past practices as a template to prefill the form.

  Redesign (operator SVG «2 New practice 2/3», NP-5…9, 2026-06-30):
    - ONE merged container (white plate, --radius-md) holds the «Вы создавали
      ранее…» header AND the cards — not separate bubbles (NP-9).
    - Each card = compact bordered row (--velo-primary border): direction icon +
      title + «дата, время» on the secondary line. NO participant count (NP-5/6/7).
    - The list shows ~3 cards then scrolls with a VISIBLE scrollbar (NP-8;
      scrollbars are thinned/hidden elsewhere app-wide).

  States:
    - Collapsed: just the header row inside the plate.
    - Expanded, no practices: muted «Данных пока нет…» hint.
    - Expanded, has practices: the master's practices (newest-first) as cards.

  Selecting a card emits `select` and collapses the block; the parent prefills.
  Data source = masterStore.practices (real). No backend dependency.
-->

<template>
  <!-- One merged plate: header + cards live in the SAME container (NP-9). -->
  <div class="use-template">
    <button
      type="button"
      class="use-template__head"
      :class="{ 'use-template__head--open': open }"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="use-template__head-text">Вы создавали ранее…</span>
      <svg class="use-template__chev" viewBox="0 0 16 10" fill="none" aria-hidden="true">
        <path d="M2 2L8 8L14 2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    </button>

    <!-- Empty: master has no practices yet. -->
    <div v-if="open && practices.length === 0" class="use-template__empty">
      Данных пока нет — создайте первую практику
    </div>

    <!-- List: compact bordered cards (NP-5/6/7); ~3 tall then scroll. The native
         ::-webkit-scrollbar is not painted by the iOS/Telegram webview for a
         touch-scroll container, so the block read as non-scrollable — a custom
         always-visible thumb (item 6, PROMPT №233) shows position + that it scrolls. -->
    <div v-else-if="open" class="use-template__scrollwrap">
      <div ref="listEl" class="use-template__list" @scroll="syncScrollbar">
        <button
          v-for="p in practices"
          :key="p.id"
          type="button"
          class="use-template__card"
          @click="select(p)"
        >
          <span class="use-template__card-icon">
            <component :is="iconFor(p)" :size="46" />
          </span>
          <span class="use-template__card-text">
            <span class="use-template__card-title">{{ p.title }}</span>
            <span class="use-template__card-meta">{{ cardWhen(p) }}</span>
          </span>
        </button>
      </div>
      <div v-show="hasOverflow" class="use-template__scrollbar" aria-hidden="true">
        <div class="use-template__scrollbar-thumb" :style="thumbStyle" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount, type Component } from 'vue'
import { practiceIconFor } from '@/utils/displayHelpers'
import { formatShortDate, formatTime } from '@/utils/format'
import type { PracticeResponse } from '@/api/types'

const props = defineProps<{
  /** The master's own practices (newest-first), used as templates. */
  practices: PracticeResponse[]
}>()

const emit = defineEmits<{ select: [practice: PracticeResponse] }>()

const open = ref(false)

// -- Custom scroll indicator (item 6): the iOS/Telegram webview does not paint
//    ::-webkit-scrollbar for a touch-scroll container, so we drive a thin thumb
//    from the scroll ratio. Non-interactive — the user scrolls the list itself;
//    the thumb only shows the position + that the block scrolls. --
const listEl = ref<HTMLElement | null>(null)
const hasOverflow = ref(false)
const thumbTopPct = ref(0)
const thumbHeightPct = ref(0)
const thumbStyle = computed(() => ({
  top: `${thumbTopPct.value}%`,
  height: `${thumbHeightPct.value}%`,
}))

function syncScrollbar(): void {
  const el = listEl.value
  if (!el) {
    hasOverflow.value = false
    return
  }
  const { scrollHeight, clientHeight, scrollTop } = el
  if (scrollHeight - clientHeight <= 1) {
    hasOverflow.value = false
    return
  }
  hasOverflow.value = true
  thumbHeightPct.value = (clientHeight / scrollHeight) * 100
  thumbTopPct.value = (scrollTop / scrollHeight) * 100
}

// Keep the thumb accurate as the list resizes (late layout / font load).
let ro: ResizeObserver | null = null
function observeList(): void {
  ro?.disconnect()
  const el = listEl.value
  if (el && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => syncScrollbar())
    ro.observe(el)
  }
}

// Recompute when the block opens (the list mounts) or the template set changes.
watch(open, async (isOpen) => {
  if (!isOpen) {
    ro?.disconnect()
    hasOverflow.value = false
    return
  }
  await nextTick()
  syncScrollbar()
  observeList()
})
watch(
  () => props.practices.length,
  async () => {
    if (!open.value) return
    await nextTick()
    syncScrollbar()
  },
)

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** Direction icon (carries its own circle outline). */
function iconFor(p: PracticeResponse): Component {
  return practiceIconFor(p)
}

/** Secondary line «25 янв, 07:00» — date + time, no participant count (NP-5/6). */
function cardWhen(p: PracticeResponse): string {
  return `${formatShortDate(p.scheduled_at, p.timezone)}, ${formatTime(p.scheduled_at, p.timezone)}`
}

function select(p: PracticeResponse): void {
  emit('select', p)
  open.value = false
}
</script>

<style scoped>
/* Merged container (NP-9): white plate holds the header + cards. */
.use-template {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

/* Header row — lives INSIDE the plate now (no own background). */
.use-template__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--space-1) var(--space-2);
  background: transparent;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  cursor: pointer;
}

.use-template__head-text {
  letter-spacing: 0.02em;
}

.use-template__chev {
  width: 16px;
  height: 10px;
  flex-shrink: 0;
  color: var(--velo-text-primary);
  transition: transform var(--transition-base);
}

.use-template__head--open .use-template__chev {
  transform: rotate(180deg);
}

/* Empty-state hint. */
.use-template__empty {
  text-align: center;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  padding: var(--space-2) var(--space-2) var(--space-3);
}

/* Positioning context for the custom scroll indicator. */
.use-template__scrollwrap {
  position: relative;
}

/* List: ~3 compact cards then scroll. Native scrollbar hidden — the webview does
   not paint ::-webkit-scrollbar for a touch-scroll container, so the custom thumb
   below is the visible affordance (item 6). */
.use-template__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* ~3 cards (icon 46 + card padding + border) + 2 gaps, then scroll. */
  max-height: calc((46px + var(--space-3) * 2 + 2px) * 3 + var(--space-2) * 2);
  overflow-y: auto;
  /* Room on the right for the custom thumb so card text never sits under it. */
  padding-right: var(--space-3);
  scrollbar-width: none; /* Firefox: hide native (custom thumb below) */
}
.use-template__list::-webkit-scrollbar {
  display: none;
}

/* Custom always-visible scroll indicator (item 6, PROMPT №233): a faint track +
   a --velo-primary thumb positioned from the scroll ratio (JS). Non-interactive
   (pointer-events:none) — it only signals position + that the block scrolls. */
.use-template__scrollbar {
  position: absolute;
  top: var(--space-1);
  bottom: var(--space-1);
  right: 3px;
  width: 4px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
  pointer-events: none;
}
.use-template__scrollbar-thumb {
  position: absolute;
  left: 0;
  width: 100%;
  min-height: 24px;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
}

/* Card (NP-5/6/7): bordered compact row — icon + title + date·time. */
.use-template__card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-primary);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  text-align: left;
  font-family: var(--font-body);
  color: var(--velo-text-primary);
  cursor: pointer;
}

.use-template__card:active {
  opacity: 0.85;
}

.use-template__card-icon {
  flex-shrink: 0;
  display: flex;
  color: var(--velo-text-primary);
}

.use-template__card-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.use-template__card-title {
  font-size: var(--text-base);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.use-template__card-meta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}
</style>
