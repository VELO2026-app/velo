<!--
  VELO Frontend -- DiarySearchBar (Diary redesign, screen 44; inline round,
  owner 2026-09-07)

  The diary's inline search row, unfolded from the "..." menu's «Поиск» item
  by the parent (DiaryFeedView): [magnifier][glass field] stretching to the
  right rail, floating over the feed. Replaces the retired DiarySearchModal
  -- no sheet, no teleport; the VIEW owns the positioning via its
  .diary-feed__search wrapper (same overlay contract as the composer).

  Submit (Enter, the magnifier, or a recent) emits `search` with the trimmed
  query and records it in recents; an empty submit clears the search. The bar
  STAYS after submit -- the parent keeps it mounted while a search is active
  (it is the only visible indicator of that filter). `x` erases the TEXT only
  (cancelling the search itself is the scrim tap / the contextual back); Esc
  emits `close`. The parent focuses the field through the exposed focus().

  Recent queries persist in localStorage, capped at MAX_RECENTS,
  most-recent-first, de-duplicated case-insensitively (carried over from the
  modal verbatim). The recents panel shows only while the field is empty.

  Usage:
    <DiarySearchBar
      :initial="feedFilters.search ?? ''"
      @search="onApplySearch"
      @close="closeSearch"
    />
-->

<template>
  <div class="diary-search">
    <button type="button" class="diary-search__go" aria-label="Искать" @click="submit(query)">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
        <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>

    <div class="diary-search__field">
      <input
        ref="inputEl"
        v-model="query"
        class="diary-search__input"
        type="text"
        placeholder="Искать..."
        enterkeyhint="search"
        aria-label="Поиск по дневнику"
        @keydown.enter.prevent="submit(query)"
      />
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
          @click="submit(term)"
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps<{
  /** The ACTIVE search, to prefill/sync the field ('' = none). */
  initial?: string
}>()

const emit = defineEmits<{
  search: [query: string]
  close: []
}>()

const RECENTS_KEY = 'velo:diary:recent-searches'
const MAX_RECENTS = 6

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
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

function submit(term: string): void {
  const trimmed = term.trim()
  query.value = trimmed
  if (trimmed) recordRecent(trimmed)
  // Empty submit clears the search (the parent maps it to runFeedSearch('')).
  emit('search', trimmed)
  // Drop the keyboard so the results are visible; tap the field to refine.
  inputEl.value?.blur()
}

function clear(): void {
  // The x erases the TEXT only (owner 2026-09-07): the mode stays open and
  // the field stays focused, ready for a new query. Cancelling the SEARCH
  // itself is the scrim tap / the contextual back -- not the x.
  query.value = ''
  inputEl.value?.focus()
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
  gap: var(--space-2);
}

/* The magnifier doubles as the submit button: a 44px primary disc, the same
   geometry as the composer's send disc (and the retired modal's go button). */
.diary-search__go {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.diary-search__go:hover {
  opacity: 0.9;
}

/* The field: a LIGHT pill (owner 2026-09-07 -- the earlier 20% white glass
   read as a dark slot over the scrim). Same white 90% surface as the
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
