<!--
  VELO Frontend -- DiarySearchBar (Diary redesign, screen 44; header-slot
  round, owner 2026-09-09)

  The diary's search input, living in the HEADER ROW'S SLOT while any search
  state is up (the parent swaps the back/"..." row out for it): a light pill
  field with a SMALL clear-x inside, and a larger plain x to the right that
  closes the search as a whole.

  Live search (2026-09-09): every debounced keystroke emits `live` with the
  trimmed query ('' = the field is empty = drop the filter). Enter just
  remembers the query and drops the keyboard (flushing any pending live
  pass); a recent tap applies its query immediately. The small inner x
  behaves like backspacing to empty; the OUTER x emits `cancel` -- the parent
  resets everything and returns the header row. Esc emits `close`.

  Recent queries persist in localStorage, capped at MAX_RECENTS,
  most-recent-first, de-duplicated case-insensitively (carried over from the
  modal verbatim). The recents panel shows only while the field is empty.

  Usage:
    <DiarySearchBar
      :initial="feedFilters.search ?? ''"
      @live="onLiveSearch"
      @cancel="onSearchCancel"
      @close="closeSearch"
    />
-->

<template>
  <div class="diary-search">
    <!-- [field (small clear-x inside)] [close X] -- owner 2026-09-09. The
         field is the composer's pill look ("аккуратный инпут, который был
         внизу"); submit is Enter / a recent (live search refetches as you
         type, so there is no go disc any more -- the magnifier ruling of
         2026-09-07 is superseded by this layout). -->
    <div class="diary-search__field">
      <input
        ref="inputEl"
        v-model="query"
        class="diary-search__input"
        type="text"
        placeholder="Искать..."
        enterkeyhint="search"
        aria-label="Поиск по дневнику"
        @input="onUserInput"
        @keydown.enter.prevent="commit"
      />
      <!-- The SMALL x lives INSIDE the field and clears the TEXT (and, like
           backspacing to empty, debounces a live('') that drops the filter)
           -- it never CLOSES the search: the bar and the focused field
           stay; closing is the outer x (owner 2026-09-09). -->
      <button
        v-if="query"
        type="button"
        class="diary-search__clear"
        aria-label="Очистить"
        @click="clear"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <!-- Recent searches: a glass panel under the field, only while the
           field is empty -- typing anything dismisses it. -->
      <section v-if="recentsVisible" class="diary-search__recents">
        <h3 class="diary-search__recent-label">Недавно вы искали:</h3>
        <button
          v-for="term in recents"
          :key="term"
          type="button"
          class="diary-search__recent-item"
          @click="applyRecent(term)"
        >
          <span class="diary-search__recent-text">{{ term }}</span>
          <svg
            class="diary-search__recent-arrow"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M7 17L17 7M17 7H9M17 7v8"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </section>
    </div>

    <!-- The OUTER x (owner 2026-09-09): a PLAIN ICON to the right of the
         field -- bigger than the field's own small clear x, but no chrome
         of its own (no disc, no border, no frost): the input is the
         surface, the x is just a glyph. It closes the search AS A WHOLE --
         the parent ends the mode, resets any active query / jump window
         and returns everything to its original state. -->
    <button
      type="button"
      class="diary-search__close"
      aria-label="Закрыть поиск"
      @click="emit('cancel')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M6 6l12 12M18 6L6 18"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { onDocumentEvent, offDocumentEvent } from '@/platform/dom'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps<{
  /** The ACTIVE search, to prefill/sync the field ('' = none). */
  initial?: string
}>()

const emit = defineEmits<{
  /**
   * Debounced as-you-type query (2026-09-09, Telegram-style live search).
   * '' means "the field is empty" and CLEARS the search -- an empty field
   * is no filter (owner 2026-09-09; supersedes the submit-only-era rule
   * that an erased field kept the committed query). Enter and a recent
   * tap emit it IMMEDIATELY (discrete actions, not typing).
   */
  live: [query: string]
  /** The outer x: close the search entirely (the parent resets everything). */
  cancel: []
  close: []
}>()

const RECENTS_KEY = 'velo:diary:recent-searches'
const MAX_RECENTS = 6
const LIVE_DEBOUNCE_MS = 300

const query = ref('')
const recents = ref<string[]>([])
const inputEl = ref<HTMLInputElement | null>(null)

const recentsVisible = computed(() => query.value.trim() === '' && recents.value.length > 0)

function loadRecents(): void {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    recents.value = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    // Corrupt / unavailable storage -- start empty, never throw.
  }
}

function saveRecents(): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.value))
  } catch {
    // Storage unavailable -- recents simply won't survive the session.
  }
}

function recordRecent(t: string): void {
  if (!t) return
  // Case-insensitive de-dup, most-recent-first, capped.
  const lower = t.toLowerCase()
  const next = [t, ...recents.value.filter((r) => r.toLowerCase() !== lower)]
  recents.value = next.slice(0, MAX_RECENTS)
  saveRecents()
}

loadRecents()

// Sync the field from the active search: initial mount and external resets
// (e.g. the contextual back clearing the filter while the bar is up).
watch(
  () => props.initial,
  (v) => {
    query.value = v ?? ''
  },
  { immediate: true },
)

// Esc closes the search mode. Listeners live only while mounted (the view
// v-ifs the whole bar, so unmount is the teardown).
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    inputEl.value?.blur()
    emit('close')
  }
}
onMounted(() => onDocumentEvent('keydown', onKeydown))
onBeforeUnmount(() => {
  offDocumentEvent('keydown', onKeydown)
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = null
  }
})

// -- Live search (2026-09-09) -------------------------------------------------
//
// USER input only: the @input handler fires for real keystrokes, never for
// the programmatic `initial` sync -- merely REOPENING the bar with an active
// query is not typing and must not refetch anything.
let liveTimer: ReturnType<typeof setTimeout> | null = null

function onUserInput(): void {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = setTimeout(() => {
    liveTimer = null
    emit('live', query.value.trim())
  }, LIVE_DEBOUNCE_MS)
}

/**
 * Enter: remember the query and drop the keyboard -- nothing else. The
 * results are already live; the old "commit the search" ritual (a `search`
 * event the parent used to end a mode with) died with the scrim: the bar
 * is up while any search state is, so there is nothing to commit TO. A
 * pending live pass is flushed NOW -- dropping it would leave a just-typed
 * query unfetched.
 */
function commit(): void {
  const trimmed = query.value.trim()
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = null
    emit('live', trimmed)
  }
  if (trimmed) recordRecent(trimmed)
  inputEl.value?.blur()
}

/**
 * A recent tap: set the query and apply it IMMEDIATELY (a discrete action,
 * not typing -- no debounce owed) and re-record it as most recent.
 */
function applyRecent(term: string): void {
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = null
  }
  query.value = term
  recordRecent(term)
  inputEl.value?.focus()
  emit('live', term)
}

function clear(): void {
  // The small inner x behaves EXACTLY like backspacing the text away: the
  // field empties and stays focused, and the debounced live('') drops the
  // filter (owner 2026-09-09 -- an empty field is no filter). It never
  // CLOSES the search: that is the outer x's job.
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = null
  }
  query.value = ''
  inputEl.value?.focus()
  onUserInput()
}

function focus(): void {
  inputEl.value?.focus()
}

defineExpose({ focus })
</script>

<style scoped>
.diary-search {
  display: flex;
  align-items: center;
  /* Tight: the outer x is a bare glyph, it hugs the pill like a suffix
     rather than sitting as a separate column. */
  gap: var(--space-1);
}

/* The OUTER close x (owner 2026-09-09, round 2: "иконка крестика" -- a PLAIN
   glyph, deliberately NOT a button disc): the pill is the surface; the x is
   just an icon with a generous touch target (the pill's own 50px height, so
   vertical centring is free). Visibly larger than the field's inner clear
   x (14px) so the two never read as the same control. */
.diary-search__close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: var(--velo-size-50);
  border: none;
  padding: 0;
  background: transparent;
  color: var(--velo-text-secondary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.diary-search__close:hover {
  opacity: 0.7;
}

/* The field: a LIGHT pill (owner 2026-09-07 -- the earlier 20% white glass
   read as a dark slot over the feed). Same white 90% surface as the
   recents panel below, frost blur + a white rim kept from the glass
   language; iOS-stable like the composer's: the frost lives on a ::before
   layer of its own, the input itself never carries backdrop-filter (WebKit
   shimmered when it did). Height is the DS search-field token
   (--velo-size-50). */
.diary-search__field {
  position: relative;
  /* Owns the frost child's stacking context (same trick as Composer). */
  transform: translateZ(0);
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  /* FIXED height (owner 2026-09-07: the pill grew 50 -> 56px the moment
     typing began -- the 40px clear button entered the flow and 40 + 16px of
     vertical padding beat the old min-height). Fixed height + the
     out-of-flow clear (below) keep the pill rock-solid at 50. */
  height: var(--velo-size-50);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: var(--radius-full);
}

.diary-search__field::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  z-index: -1;
}

.diary-search__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-primary);
  /* Reserves the absolute clear-button zone so text never runs under the x
     (kept even when the x is hidden -- a stable typeable line). */
  padding: 0 calc(var(--velo-size-40) + var(--space-2)) 0 0;
}

.diary-search__input::placeholder {
  color: var(--velo-text-placeholder);
}

/* The clear `x`: OUT of the flow (see the fixed-height note above) -- it
   overlays the pill's right padding zone, vertically centred; the input's
   right padding reserves its footprint. */
.diary-search__clear {
  position: absolute;
  top: 50%;
  right: var(--space-1);
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--velo-text-secondary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.diary-search__clear:hover {
  opacity: 0.7;
}

/* -- Recent searches: a denser glass panel than the field -- text rows need
   more fill to stay readable over the scrolling feed. */
.diary-search__recents {
  position: absolute;
  top: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-2);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  box-sizing: border-box;
}

.diary-search__recent-label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 400;
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-1) 0;
}

.diary-search__recent-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: var(--velo-size-40);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
  text-align: left;
}

.diary-search__recent-item:hover {
  opacity: 0.85;
}

.diary-search__recent-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diary-search__recent-arrow {
  flex-shrink: 0;
  color: var(--velo-text-secondary);
}
</style>
