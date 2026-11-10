<!--
  VELO Frontend -- DiaryFeedView (Diary redesign, screen 40)

  The diary screen. Renders the unified feed as the alternating thread
  (DiaryTimeline), with a frosted composer pinned at the bottom and floating
  glass back/"..." buttons over the feed (no title -- owner 2026-09-07).
  Replaces the old tab-based DiaryView.

  Pagination: cursor-based infinite scroll. An IntersectionObserver sentinel
  at the bottom calls loadMoreFeed() when it scrolls into view (the project's
  other lists use a "show more" button, but the diary is a chat-like timeline
  where auto-load reads more naturally -- agreed deviation).

  Tap handling (this iteration = Variant A): editable cards (note/dream) show
  a "coming soon" toast; everything else is a no-op. The composer creates
  notes. When Variant B lands, only the tap handler here changes.
-->

<template>
  <div
    ref="screenEl"
    class="diary-feed"
    :class="{
      'diary-feed--composing': composing,
      'diary-feed--searching': searchMode,
    }"
    :style="composerStyle"
  >
    <!-- Header: floating glass buttons OVER the feed (owner 2026-09-07): the
         curtain/top fade is gone and there is no title -- entries really pass
         beneath the buttons, the same overlay model the composer uses at the
         bottom. 2026-09-09 ruling: while ANY search state is up (open mode /
         committed query / the jump window over one) this row is REPLACED by
         the inline search bar in this very slot -- back + «...» fade out,
         the bar fades in; deactivating the search returns the row exactly
         as it was. The row stays MOUNTED (hidden via the class below) so
         the swap is a crossfade, not a mount/unmount blink. -->
    <header class="diary-feed__header" :class="{ 'diary-feed__header--replaced': searchMode }">
      <!-- Contextual back (operator 2026-06-04): with a filter/search active
           the arrow RESETS the filter (return to the full feed), otherwise it
           exits the diary. The separate "x" is gone. [FE-42] the back button
           is round EVERYWHERE (owner amendment) -- VBackButton's base look;
           white glass here. -->
      <VBackButton
        class="diary-feed__back"
        variant="glass"
        :aria-label="
          filterActive
            ? t('user.screens.diaryFeed.resetFilterAria')
            : t('user.screens.diaryFeed.exitAria')
        "
        @click="onBack"
      />
      <!-- "..." on one line with the arrow, at the right rail (owner
           2026-09-08: the "under the arrow" column is cancelled): the plain
           DS look (owner 2026-09-07, round 2: blue glass removed); expands
           downward (into Filter (i18n:user.screens.diaryFeed.filter.title)
           and Search (i18n:user.screens.diaryFeed.search.title)) over the content. -->
      <VMenu>
        <!-- Trigger glyph: vertical dots that rotate to horizontal while the
             menu is open (a state cue, approved animation). The shared default
             trigger is horizontal dots; the diary overrides it here. -->
        <template #trigger="{ open }">
          <svg
            class="diary-feed__dots"
            :class="{ 'diary-feed__dots--open': open }"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </template>
        <template #default="{ close }">
          <!-- Filter (funnel) + Search (magnifier). The Relationships item
               is an AI feature outside the MVP and is intentionally omitted. -->
          <VMenuItem
            :ariaLabel="t('user.screens.diaryFeed.filter.title')"
            @click="
              () => {
                openFilter()
                close()
              }
            "
          >
            <svg
              class="diary-feed__menu-glyph"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M2.68.01h6.3l8.4-.01c.73 0 1.37.2 1.9.7a2.62 2.62 0 0 1-.04 3.65q-.34.34-.7.63l-.68.6-.64.58-1.13 1-.7.63-.27.24-.4.34-.58.5-.08.08a2 2 0 0 0-.6.81q-.09.3-.07.61v1.99l-.02 5.12c0 .73-.1 1.36-.62 1.91-.5.48-1.01.62-1.7.6-.73-.02-1.29-.54-1.85-.97l-.6-.45-.83-.64a3.3 3.3 0 0 1-1.11-2.13q-.03-.33-.02-.65v-2.68l-.01-2.02c-.01-.58-.17-1-.58-1.4a10 10 0 0 0-.73-.66q-.3-.3-.63-.56A22 22 0 0 1 3.53 6.8l-.63-.55-.45-.4-.6-.54-.64-.55a4 4 0 0 1-.97-1.11A2.3 2.3 0 0 1 0 2.52V2.4c0-.32.04-.57.17-.86l.06-.13Q.7.46 1.73.1c.31-.1.63-.1.95-.09m-.8 1.96c-.14.21-.2.4-.19.66.07.33.3.54.54.75l.28.24.4.35q.36.3.68.6l.64.58.35.31.45.4.6.54.63.55a21 21 0 0 1 1.08.95c.59.5.92 1.35.99 2.1v1.92l.01 3.32c0 .54.13.95.5 1.34q.46.42.98.77l.52.4.11.08.21.16c.3.24.3.24.65.32a.5.5 0 0 0 .33-.27q.03-.17.02-.33V10.7c0-1.03.22-2 .95-2.76a6 6 0 0 1 .6-.53l1.12-1 .98-.87q.3-.28.63-.55a22 22 0 0 0 1.16-1.04l.71-.63.14-.11a.9.9 0 0 0 .36-.61 1 1 0 0 0-.19-.62c-.22-.23-.46-.29-.77-.29H2.92c-.56-.01-.56-.01-1.03.28"
                fill="currentColor"
              />
            </svg>
          </VMenuItem>
          <VMenuItem
            :ariaLabel="t('user.screens.diaryFeed.search.title')"
            @click="
              () => {
                toggleSearch()
                close()
              }
            "
          >
            <svg
              class="diary-feed__menu-glyph diary-feed__menu-glyph--magnifier"
              viewBox="0 0 13.6562 22.999"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M6.83 0A6.83 6.83 0 0 1 7.9 13.57v8.35a1.08 1.08 0 0 1-2.16 0v-8.35A6.83 6.83 0 0 1 6.83 0m0 2a4.83 4.83 0 1 0 0 9.66 4.83 4.83 0 0 0 0-9.66"
                fill="currentColor"
              />
            </svg>
          </VMenuItem>
          <!-- View toggle (list <-> thread map). TEMPORARILY HIDDEN behind the
               SHOW_VIEW_TOGGLE flag: the thread view is raw, so the button (and
               with it the mode's entry point) is hidden until it is finished.
               The code is intact. Glyph + aria reflect the
               TARGET view (what tapping switches to). -->
          <VMenuItem
            v-if="SHOW_VIEW_TOGGLE"
            :ariaLabel="
              viewMode === 'list'
                ? t('user.screens.diaryFeed.showMapAria')
                : t('user.screens.diaryFeed.showListAria')
            "
            @click="
              () => {
                toggleView()
                close()
              }
            "
          >
            <!-- Glyph reflects the TARGET view (what tapping switches to).
                 On map -> show the "list" glyph (Group 2506: three dots in a
                 column); on list -> show the "map/cards" glyph (Group 2529:
                 stacked layers). Both from the designer's icon set. -->
            <svg
              v-if="viewMode === 'map'"
              class="diary-feed__menu-glyph"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <circle cx="4.75" cy="5" r="1.5" fill="currentColor" />
              <circle cx="4.75" cy="10" r="1.5" fill="currentColor" />
              <circle cx="4.75" cy="15" r="1.5" fill="currentColor" />
              <path
                d="M8.5 5h7m-7 5h7m-7 5h7"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
            <svg
              v-else
              class="diary-feed__menu-glyph"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <rect
                x="3"
                y="3"
                width="14"
                height="10"
                rx="2.5"
                stroke="currentColor"
                stroke-width="1.8"
              />
              <path d="M5.5 16h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </VMenuItem>
        </template>
      </VMenu>
    </header>

    <!-- Feed row: runs the FULL height -- the header buttons and the composer
         are absolute overlays it passes beneath (owner 2026-09-07 for the
         header; the composer already was one), and the ONLY scrolling area.
         PROMPT №668 (ruling 6): the
         ruling-5 freeze (`:style` pinning this row's height while composing,
         `№667`) is GONE -- ruling 6 wants exactly the opposite of what ruling
         5 required: the feed must visibly ride up as the composer grows, like
         an ordinary message list, not stand still. Plain `flex: 1 1 auto`
         (in <style>) is the whole mechanism now; nothing here reacts to
         `composing` any more except the mask/dim rules below it. -->
    <div ref="scrollEl" class="diary-feed__body" @scroll="rememberBottomState">
      <!-- Initial loading: entry-shaped placeholders settled at the bottom,
           where the newest entries (and the eye) are. Once seen they stay a
           visible minimum (useLoadingHold); the thread then fades in. -->
      <div
        v-if="feedSkeleton"
        class="diary-feed__state diary-feed__state--skeleton diary-entry-scale"
      >
        <VSkeletonBubbles />
      </div>

      <!-- Error (only when nothing loaded yet) -->
      <VEmptyState
        v-else-if="feedError && items.length === 0"
        icon="warning"
        :title="t('user.screens.diaryFeed.loadFailed')"
        :description="t('common.checkConnection')"
      >
        <template #action>
          <VButton variant="primary" @click="reload">{{ t('common.retry') }}</VButton>
        </template>
      </VEmptyState>

      <!-- Jump window load (Telegram-style scroll-to-entry): two GETs, one
           full-screen loader; the results list is left only on success. -->
      <div v-else-if="jumpActive && jumpLoading" class="diary-feed__state">
        <VLoader size="lg" />
      </div>

      <!-- Search: honest no-results rung -- distinct from the diary-empty
           title (i18n:user.screens.diaryFeed.empty.title; the diary is NOT
           empty, the query matched nothing). Skipped while
           a jump window is open (the thread rung owns the screen then). -->
      <VEmptyState
        v-else-if="searchActive && !jumpActive && items.length === 0"
        :title="t('user.screens.diaryFeed.search.noHits')"
        :description="t('user.screens.diaryFeed.searchNoHits', { query: feedFilters.search })"
      >
        <template #icon>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.4" />
            <path
              d="m20 20-3.5-3.5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </template>
        <template #action>
          <VButton variant="primary" @click="onResetSearch">{{
            t('user.screens.diaryFeed.search.reset')
          }}</VButton>
        </template>
      </VEmptyState>

      <!-- Search results (Telegram reference): a compact jump list, NOT the
           filtered timeline -- more results per screen and an obvious
           tap-to-jump affordance. Newest-first; the parent's sentinel below
           extends it. A jump window replaces the list while one is open. -->
      <div v-else-if="searchActive && !jumpActive" class="diary-feed__results">
        <DiarySearchResults
          :items="items"
          :timezone="timezone"
          :query="feedFilters.search ?? ''"
          :has-more="feedHasMore"
          @jump="onJumpToEntry"
        />
        <!-- Results are newest-first, so older pages extend the BOTTOM: the
             sentinel sits after the list (mirror of the thread's top one).
             Appends below the viewport -- no scroll compensation owed. -->
        <div ref="resultsSentinelEl" class="diary-feed__results-sentinel" />
        <!-- In-flow on purpose (unlike the thread's out-of-flow --more rail):
             this one sits at the list's very BOTTOM, so appearing mid-fetch
             cannot push anything the reader is looking at. -->
        <div v-if="loadingMore" class="diary-feed__state diary-feed__state--results">
          <VLoader />
        </div>
      </div>

      <!-- Empty -->
      <VEmptyState
        v-else-if="timelineItems.length === 0"
        :title="t('user.screens.diaryFeed.empty.title')"
        :description="t('user.screens.diaryFeed.empty.text')"
      >
        <template #icon><IconDiaryBook :size="64" /></template>
      </VEmptyState>

      <!-- Thread (chat-mode: oldest at top, newest at bottom) -->
      <template v-else>
        <!-- Infinite-scroll sentinel + "loading older" indicator sit ABOVE the
             thread: history is loaded by scrolling UP. Both hang on a
             ZERO-HEIGHT rail (.diary-feed__topzone): the loader is an
             out-of-flow overlay, so it can never push the feed down while it
             appears/disappears mid-scroll (that bounce read as jumping
             content once the 800px prefetch lead landed loads during the
             fling). -->
        <div class="diary-feed__topzone">
          <div ref="sentinelEl" class="diary-feed__sentinel" />
          <div v-if="loadingOlderPage" class="diary-feed__state diary-feed__state--more">
            <VLoader />
          </div>
        </div>

        <!-- Wrapper pins a short feed to the bottom (margin-top:auto) so few
             entries sit next to the composer, chat-style. With a
             filter/search active the pinning is disabled (--top) -- results
             go at the TOP instead of sliding to the middle/bottom (operator
             2026-06-04). -->
        <div
          class="diary-feed__thread"
          :class="{ 'diary-feed__thread--top': filterActive, 'velo-reveal': feedReveal }"
        >
          <DiaryList
            v-if="viewMode === 'list'"
            :items="timelineItems"
            :timezone="timezone"
            :item-key="diaryStore.feedItemKey"
            :pending-state="pendingStateOf"
            @tap="onTap"
          />
          <DiaryTimeline
            v-else
            :items="timelineItems"
            :timezone="timezone"
            :item-key="diaryStore.feedItemKey"
            :pending-state="pendingStateOf"
            @tap="onTap"
          />
        </div>
      </template>
    </div>

    <!-- Composer -- ABSOLUTE OVERLAY over the scroll container (owner spec,
         Apple Liquid Glass). The feed REALLY scrolls under the glass: its
         entries pass beneath the pill and are blurred by the pill's
         backdrop-filter -- never faked with opacity. The overlay itself is
         pinned to the screen root and NOTHING about it animates on scroll.
         2026-09-09: temporarily REMOVED while a search is up (owner) -- the
         field's slot at the top belongs to the search input for that time. -->
    <div v-if="!searchMode" ref="composerEl" class="diary-feed__composer">
      <DiaryComposer
        v-if="writeTarget"
        ref="diaryComposerRef"
        :entry-type="writeTarget"
        @created="onComposerCreated"
        @composing-change="composing = $event"
      />
    </div>

    <!-- Undo bar: shown after deleting an entry (Figma screen 58) -->
    <div v-if="deletedEntryId" class="diary-feed__undo">
      <span class="diary-feed__undo-text">{{ t('user.screens.diaryFeed.toast.deleted') }}</span>
      <button type="button" class="diary-feed__undo-btn" :disabled="undoing" @click="onUndoDelete">
        {{ t('user.screens.diaryFeed.cancel') }}
      </button>
    </div>

    <!-- [FE-7] OUTSIDE-TAP BLUR, tap-only by construction: the old absolute
         tap-catcher layer (PROMPT №668) sat in the TOUCH path with
         pointer-events:auto while composing -- and iOS picks the scroll
         target from the touchstart element, so every scroll gesture that
         began on the layer was dead on arrival (device-measured: "feed does
         not scroll with the keyboard open"). The layer is GONE; the blur now
         rides a CLICK capture on the root (clicks fire after the gesture, so
         scrolling is untouched -- a scrolled finger never clicks). Header and
         composer rows are exempt so their buttons keep working; see
         onRootClickCapture. -->

    <!-- Category filter (screen 42), opened from the "..." menu -->
    <DiaryFilterModal
      :open="showFilter"
      :categories="activeCategories"
      :date-from="feedFilters.date_from"
      :date-to="feedFilters.date_to"
      :timezone="timezone"
      @apply="onApplyFilter"
      @close="showFilter = false"
    />

    <!-- Inline search (screen 44, owner 2026-09-07 round 3; 2026-09-09:
         lives in the HEADER ROW'S SLOT -- it replaces back + «...» while
         any search state is up, and yields the slot back on deactivation;
         NO scrim/dim any more -- owner 2026-09-09, the screen behind stays
         fully visible and crisp). Always mounted, crossfaded via the --up
         class; while a query is live it is the search's only visible
         indicator (no header title). -->
    <div class="diary-feed__search" :class="{ 'diary-feed__search--up': searchMode }">
      <DiarySearchBar
        ref="searchBarEl"
        :initial="feedFilters.search ?? ''"
        @live="onLiveSearch"
        @cancel="onSearchCancel"
        @close="closeSearch"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { onDocumentEvent, offDocumentEvent, activeHTMLElement } from '@/platform/dom'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useLoadingHold } from '@/composables/useLoadingHold'
import { useChatScroll } from '@/composables/useChatScroll'
import { useRouter, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  VLoader,
  VEmptyState,
  VButton,
  VBackButton,
  VMenu,
  VMenuItem,
  VSkeletonBubbles,
} from '@/components/ui'
import { IconDiaryBook } from '@/components/icons'
import DiaryTimeline from '@/components/shared/DiaryTimeline.vue'
import DiaryList from '@/components/shared/DiaryList.vue'
import DiaryComposer from '@/components/shared/DiaryComposer.vue'
import DiaryFilterModal from '@/components/shared/DiaryFilterModal.vue'
import DiarySearchBar from '@/components/shared/DiarySearchBar.vue'
import DiarySearchResults from '@/components/shared/DiarySearchResults.vue'
import { useDiaryStore } from '@/stores/diary'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { diaryWriteTarget } from '@/utils/diaryComposeTarget'
import type { DiaryFeedItem, DiaryFeedCategory } from '@/api/types'

const router = useRouter()
const route = useRoute()
const diaryStore = useDiaryStore()
const authStore = useAuthStore()
const toast = useToast()

const {
  feedItems,
  feedLoading,
  feedLoaded,
  feedError,
  feedHasMore,
  feedFilters,
  jumpItems,
  jumpTargetId,
  jumpLoading,
  jumpMoreLoading,
  pendingEntries,
} = storeToRefs(diaryStore)

const items = computed<DiaryFeedItem[]>(() => feedItems.value)
const timezone = computed(() => authStore.user?.timezone ?? 'UTC')

// Optimistic entries (the composer's send): shown at the newest end of the
// thread until the feed carries them -- the feed item then takes over the
// same row key (diaryStore.feedItemKey). Not mixed into search results or a
// jump window (those are server slices, not "my thread right now").
const pendingItems = computed<DiaryFeedItem[]>(() => {
  if (searchActive.value || jumpActive.value) return []
  const landed = new Set(
    items.value.filter((i) => i.source_type === 'diary_entry').map((i) => i.source_id),
  )
  return pendingEntries.value
    .filter((p) => !(p.item.source_id && landed.has(p.item.source_id)))
    .map((p) => p.item)
    .reverse() // the feed is newest-first
})

function pendingStateOf(item: DiaryFeedItem): 'sending' | 'failed' | 'sent' | undefined {
  return diaryStore.pendingFor(item)?.status
}

// Loading split: first page (full-screen loader) vs subsequent pages (inline).
// A pending entry is something to show: never a skeleton over it.
const initialLoading = computed(
  () =>
    feedLoading.value &&
    !feedLoaded.value &&
    items.value.length === 0 &&
    pendingItems.value.length === 0,
)
const loadingMore = computed(() => feedLoading.value && items.value.length > 0)

// -- Jump window (Telegram-style scroll to the found entry) -------------------

const jumpActive = computed(() => jumpTargetId.value !== null)

// The thread renders the jump window while one is open (the search results
// stay loaded in the feed behind it -- exiting the jump returns to them).
const timelineItems = computed<DiaryFeedItem[]>(() =>
  jumpActive.value ? jumpItems.value : [...pendingItems.value, ...items.value],
)

// The "loading older" indicator + sentinel guard follow whichever history is
// on screen: the feed's pagination, or the jump window's own cursor.
const loadingOlderPage = computed(() =>
  jumpActive.value ? jumpMoreLoading.value : loadingMore.value,
)
const historyCanLoadMore = computed(() =>
  jumpActive.value ? diaryStore.jumpCursor !== null : feedHasMore.value,
)
const historyBusy = computed(() => feedLoading.value || jumpLoading.value || jumpMoreLoading.value)

// -- Tap handling ------------------------------------------------------------

function onTap(payload: { item: DiaryFeedItem; editable: boolean }): void {
  // Optimistic rows: a sending one has nothing to open yet; a failed one
  // retries (same key, same place); a delivered one opens like any entry.
  const pending = diaryStore.pendingFor(payload.item)
  if (pending && (pending.status !== 'sent' || !payload.item.source_id)) {
    if (pending.status === 'failed') void retryPending(pending.key, pending.body.content)
    return
  }
  // Remember the current timeline position so returning from the entry/detail
  // restores it instead of snapping back to "today" (the bottom).
  if (scrollEl.value) diaryStore.feedScrollTop = scrollEl.value.scrollTop
  const item = payload.item
  if (payload.editable) {
    // note/dream -- open the full entry screen (view/edit/delete). The card's
    // source_id is the DiaryEntry id.
    void router.push({
      name: 'user-diary-entry',
      params: { id: item.source_id },
    })
    return
  }

  // Read-only detail for check-in / feedback (source_id is the row id).
  if (item.kind === 'checkin' || item.kind === 'feedback') {
    void router.push({
      name: 'user-diary-detail',
      params: { type: item.kind, id: item.source_id },
    })
    return
  }

  // Conversation with a master -> the thread itself. source_id IS the comms
  // thread id (backend diary/projections.py:635 passes source_id=thread_id
  // alongside the same value in the snapshot), so no snapshot read is needed
  // and this stays identical in shape to the branches above.
  if (item.kind === 'thread_started') {
    void router.push({
      name: 'user-chat',
      params: { id: item.source_id },
    })
    return
  }

  // Practice outcome -> existing practice detail page (source_id is the
  // practice id, per project_practice_outcome).
  if (item.kind === 'practice_outcome') {
    void router.push({
      name: 'practice-detail',
      params: { id: item.source_id },
    })
    return
  }

  // Banner kinds (booking_confirmed/cancelled/rescheduled) are not tappable.
}

async function retryPending(key: string, content: string): Promise<void> {
  const result = await diaryStore.retryEntry(key)
  if (result.ok) diaryComposerRef.value?.discardDraft(content)
  else toast.error(result.error || t('storeErrors.diary.create'))
}

// -- "..." menu + filter modal / inline search (screens 42 / 43 / 44) ------

const showFilter = ref(false)
const searchOpen = ref(false)
const searchBarEl = ref<{ focus: () => void } | null>(null)

// A live search keeps the bar mounted even when its "mode" is closed -- it is
// the only visible indicator of the filter (no header title any more).
const searchActive = computed(() => (feedFilters.value.search ?? '') !== '')

// The first-page skeleton's hold (useLoadingHold). Declared here, after
// everything initialLoading reads (the hold evaluates it at once).
const {
  showSkeleton: feedSkeleton,
  reveal: feedReveal,
  settled: feedSettled,
} = useLoadingHold(initialLoading)

// The header row's slot is owned by the bar while ANY search state is up
// (owner 2026-09-09): the open mode, a committed query, or the jump window
// over one. Deactivation (the bar's outer x) flips it back and the header
// row returns exactly as it was.
const searchMode = computed(() => searchOpen.value || searchActive.value)

// View mode: thread/map ('map') vs flat column ('list'), toggled from the
// "..." menu. Default 'map' -- the thread (DiaryTimeline + DiaryThreadCard)
// is the diary's primary renderer (thread-events redesign, 2026-09-08); the
// flat DiaryList stays wired for the day the product restores it. Resets per
// mount (no persistence yet — add to the store later if cross-navigation
// memory is wanted).
const viewMode = ref<'list' | 'map'>('map')

// The list/map toggle stays HIDDEN: the diary lives in the thread view, and
// until the product explicitly brings back the flat list there is no button
// to enter it. THE CODE IS NOT DELETED -- DiaryList/toggleView stay intact
// behind this flag.
const SHOW_VIEW_TOGGLE = false

async function toggleView(): Promise<void> {
  viewMode.value = viewMode.value === 'list' ? 'map' : 'list'
  // Chat-mode: both renderers order oldest->newest, so re-pin to the newest
  // (bottom) after the layout swaps to keep the user's place sensible.
  await nextTick()
  scrollToBottom()
}

// Exit the immersive diary back to the tab-bar screens (there is no tab bar
// inside the diary). Default target is the dashboard.
function exitDiary(): void {
  void router.push('/user/dashboard')
}

// Contextual back (operator 2026-06-04): a filter active -> reset it
// (return to the full feed), otherwise exit the diary to the dashboard. (A search
// state never reaches here: the header row is replaced by the search bar
// while one is up, so this button is off-screen -- the bar's outer x owns
// that exit.)
function onBack(): void {
  if (filterActive.value) {
    void clearFilter()
  } else {
    exitDiary()
  }
}

// Current categories from the store, used to seed the filter modal's draft.
const activeCategories = computed<DiaryFeedCategory[]>(() => feedFilters.value.categories ?? [])

// Write-mode state (DiaryComposer emits on focus/blur of its field) -- drives
// the tap-catcher and the composer's own compose-time styling. No longer
// dims or fogs anything (ruling 6, PROMPT №668).
const composing = ref(false)

// FE-70: the dashboard's add-entry action arrives with a one-shot intent
// (?compose=note). One focus() call enters write mode (Composer.focusField:
// optimistic composing + caret on the real textarea); with a read-only filter
// active the composer is unmounted and the call is a safe no-op. The param is
// then stripped via router.replace -- otherwise a remount/back would re-open
// the keyboard -- while every OTHER query param survives untouched.
const diaryComposerRef = ref<InstanceType<typeof DiaryComposer> | null>(null)

function consumeComposeIntent(): void {
  if (route.query.compose !== 'note') return
  diaryComposerRef.value?.focus()
  const restQuery = { ...route.query }
  delete restQuery.compose
  void router.replace({ query: restQuery })
}

// T5 -- where a new entry goes, from the active filter (pure fn, unit tested in
// utils/diaryComposeTarget.test.ts). null = a read-only filter is active, so the
// composer is hidden and the keyboard never opens.
const writeTarget = computed(() => diaryWriteTarget(activeCategories.value))

// Composer unmounts on blocked filters -- drop any lingering composing state
// (the tap-catcher and the composer's own compose-time styling key off it).
watch(writeTarget, (target) => {
  if (!target) composing.value = false
})

// [FE-7] Outside-tap blur without a touch wall (replaces the retired
// tap-catcher layer; see the template comment for why the layer had to go:
// iOS picks the scroll target from the touchstart element). A CLICK is the
// browser's own "that was a tap" verdict -- it never fires for a scroll
// gesture, so intercepting here cannot break scrolling. Document-level
// CAPTURE listener (template-bound capture on the root proved brittle in the
// test harness); scoped by the event's own path: only clicks that originate
// INSIDE .diary-feed and outside the header/composer/search rows. Teleported
// modals (filter, in body) are outside .diary-feed and stay untouched.
function onDocClickCapture(e: MouseEvent): void {
  if (!composing.value) return
  const target = e.target as HTMLElement | null
  if (!target?.closest('.diary-feed')) return
  if (target.closest('.diary-feed__header, .diary-feed__composer, .diary-feed__search')) return
  activeHTMLElement()?.blur?.()
  e.stopPropagation()
  e.preventDefault()
}

onMounted(() => {
  onDocumentEvent('click', onDocClickCapture, true)
})
onBeforeUnmount(() => {
  offDocumentEvent('click', onDocClickCapture, true)
  // [owner pass] keep-bottom teardown, same lifecycle as the rest.
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
})

function openFilter(): void {
  showFilter.value = true
}

// The search menu item (i18n:user.screens.diaryFeed.search.title) toggles the
// inline bar (owner 2026-09-07): unfold in place + focus.
function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) void nextTick(() => searchBarEl.value?.focus())
}

function closeSearch(): void {
  searchOpen.value = false
}

// Debounced as-you-type search. An EMPTY field means NO filter (owner
// 2026-09-09: erasing the last letter must reset the results too -- this
// supersedes the 2026-09-07 "the erased field never cancels the search"
// letter, which belonged to the submit-only era) -- and the editing session
// CONTINUES: the mode (re)opens so the bar and the focused field stay put
// while the feed behind returns to its full state. Same-value non-empty
// emits (the bar's initial sync, an edit that lands back on the active
// query) owe nothing.
async function onLiveSearch(query: string): Promise<void> {
  if (query === '') {
    searchOpen.value = true
    if (diaryStore.feedFilters.search !== undefined) await diaryStore.runFeedSearch('')
    return
  }
  if (query === (diaryStore.feedFilters.search ?? '')) return
  await diaryStore.runFeedSearch(query)
}

async function onApplyFilter(payload: {
  categories: DiaryFeedCategory[]
  date_from?: string
  date_to?: string
}): Promise<void> {
  // setFeedFilters resets the feed to the first page with the new filter set.
  await diaryStore.setFeedFilters({
    categories: payload.categories,
    date_from: payload.date_from,
    date_to: payload.date_to,
  })
  await nextTick()
  // Filter results go at the TOP (top-align); the full feed stays chat-bottom.
  if (filterActive.value) scrollToTop()
  else scrollToBottom()
}

// The no-results rung's way out: reset the SEARCH only (categories/dates may
// still be intentionally active) and return to the chat-bottom feed.
async function onResetSearch(): Promise<void> {
  await diaryStore.runFeedSearch('')
  await nextTick()
  scrollToBottom()
}

// The OUTER x (owner 2026-09-09): closes the search AS A WHOLE and returns
// everything to its original state -- the mode ends, any jump window is
// left and the query resets (runFeedSearch('') exits the jump internally),
// the header row comes back, the full feed re-reads at the chat bottom.
async function onSearchCancel(): Promise<void> {
  searchOpen.value = false
  if (searchActive.value || jumpActive.value) {
    await diaryStore.runFeedSearch('')
    await nextTick()
    scrollToBottom()
  }
}

// -- Jump to a found entry (Telegram reference) --------------------------------

async function onJumpToEntry(item: DiaryFeedItem): Promise<void> {
  const ok = await diaryStore.jumpToEntry(item)
  if (!ok) {
    // The store reset jumpTargetId -- the results list is still on screen;
    // surface the failure at the boundary that owns the action.
    if (diaryStore.jumpError) toast.error(diaryStore.jumpError)
    return
  }
  await nextTick()
  revealJumpTarget(item.id)
}

const JUMP_FLASH_MS = 1400
let flashTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Scroll the jumped-to entry into the upper third and flash it. The class is
 * a TRANSIENT animation trigger, not display state (removed on a timer and
 * before re-adding, so a re-jump to the same entry replays the flash).
 * Layout/a11y caveat: happy-dom cannot prove the scroll geometry -- the
 * upper-third offset needs a real device pass.
 */
function revealJumpTarget(id: string): void {
  const el = scrollEl.value
  if (!el) return
  const card = el.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)
  if (!card) return
  // The jump is a fresh anchor: any saved bottom-restore offset no longer
  // applies (the same slot the filter reset clears).
  diaryStore.feedScrollTop = 0
  const top = card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  el.scrollTop = Math.max(0, top - el.clientHeight / 3)
  card.classList.remove('diary-feed__flash')
  void card.offsetWidth // reflow: restart the one-shot animation
  card.classList.add('diary-feed__flash')
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => card.classList.remove('diary-feed__flash'), JUMP_FLASH_MS)
}

// -- Active-filter state ------------------------------------------------------
//
// No header title any more (owner 2026-09-07: only the floating buttons).
// The filtered state is carried by the feed content plus the back button's
// contextual aria-label/behaviour below.

// Any filter axis active = categories and/or date range and/or search.
const filterActive = computed(
  () =>
    activeCategories.value.length > 0 ||
    feedFilters.value.date_from !== undefined ||
    feedFilters.value.date_to !== undefined ||
    (feedFilters.value.search ?? '') !== '',
)

async function clearFilter(): Promise<void> {
  // Full reset: categories + date range + search (clearFeedFilters reloads
  // the feed from the first page).
  await diaryStore.clearFeedFilters()
  await nextTick()
  scrollToBottom()
}

// -- Undo bar (after deleting an entry on EntryView) -------------------------
//
// EntryView soft-deletes then navigates back here with ?deleted=<entryId>.
// We surface an undo bar (deleted text i18n:user.screens.diaryFeed.toast.deleted,
// cancel button i18n:user.screens.diaryFeed.cancel; Figma screen 58); tapping
// cancel restores the entry. The bar auto-dismisses after a few seconds.

const UNDO_DURATION_MS = 6000
const deletedEntryId = ref<string | null>(null)
const undoing = ref(false)
let undoTimer: ReturnType<typeof setTimeout> | null = null

function clearUndoTimer(): void {
  if (undoTimer) {
    clearTimeout(undoTimer)
    undoTimer = null
  }
}

function dismissUndo(): void {
  clearUndoTimer()
  deletedEntryId.value = null
}

// Strip the ?deleted param without adding a history entry.
function stripDeletedQuery(): void {
  if (route.query.deleted !== undefined) {
    const query = { ...route.query }
    delete query.deleted
    void router.replace({ query })
  }
}

watch(
  () => route.query.deleted,
  (val) => {
    const id = Array.isArray(val) ? val[0] : val
    if (!id) return
    deletedEntryId.value = id
    stripDeletedQuery()
    clearUndoTimer()
    undoTimer = setTimeout(dismissUndo, UNDO_DURATION_MS)
  },
  { immediate: true },
)

async function onUndoDelete(): Promise<void> {
  const id = deletedEntryId.value
  if (!id || undoing.value) return
  undoing.value = true
  const result = await diaryStore.restoreEntry(id)
  undoing.value = false
  dismissUndo()
  if (result.ok) {
    await nextTick()
    scrollToBottom()
  } else {
    toast.error(result.error)
  }
}

// -- Data load ---------------------------------------------------------------

async function reload(): Promise<void> {
  await diaryStore.refreshFeed()
}

onMounted(async () => {
  await diaryStore.fetchFeed()
  // A skeleton that was seen stays its minimum; the thread (and the scroll
  // target) mounts only after it. No extra tick when nothing was held.
  if (feedSkeleton.value) await feedSettled()
  await nextTick()
  // Returning from an entry/detail: restore the saved timeline position.
  // First open (no saved offset): pin to the newest entry (bottom). Do this
  // BEFORE attaching the observer so the top sentinel (now out of view) does
  // not immediately fire and load an older page.
  if (diaryStore.feedScrollTop > 0 && scrollEl.value) {
    scrollEl.value.scrollTop = diaryStore.feedScrollTop
    rememberBottomState()
  } else {
    scrollToBottom()
  }
  await nextTick()
  topSentinel.attach()
  // [owner pass] keep-bottom, attached once the initial position has settled
  // (its own first fire re-pins -- a no-op right after scrollToBottom, and a
  // correct re-pin when a restored offset happens to be near the bottom).
  attachKeepBottom()
  // [owner pass] live composer clearance: measure the pill's idle geometry
  // once, then keep it live through every growth/keyboard shift.
  attachComposerResize()
  refreshComposerClearance()
  // FE-70: consume the dashboard's compose intent once the idle geometry has
  // settled, so the focus-driven shift is the only thing that happens next.
  consumeComposeIntent()
})

// -- Scroll helpers (chat-mode) ----------------------------------------------

const scrollEl = ref<HTMLElement | null>(null)
const sentinelEl = ref<HTMLElement | null>(null)
// The screen root -- the coordinate frame the composer clearance is measured
// against (see refreshComposerClearance).
const screenEl = ref<HTMLElement | null>(null)

// The anchoring mechanics (keep-bottom, preserved position, sentinels) live in
// useChatScroll; this view only adds its own side effects around them.
const chatScroll = useChatScroll({
  scrollEl,
  nearBottomPx: 160,
  // Geometry shifted (keyboard rides the root's height): re-measure the
  // composer clearance -- the pill is anchored to the root's bottom edge, so
  // its top moves with every height change of the screen itself.
  onResize: () => refreshComposerClearance(),
})
const { rememberBottomState, attachKeepBottom } = chatScroll

function scrollToBottom(): void {
  // Going to the newest entry clears any saved offset (filters/search/compose
  // intentionally jump to the bottom).
  diaryStore.feedScrollTop = 0
  chatScroll.scrollToBottom()
}

// -- Keep-bottom on geometry shifts (owner pass) -----------------------------
// The screen is sized to the LIVE viewport, so the feed's height changes with
// the keyboard: on a shrink the visible window loses its bottom edge and the
// LAST entry slides under the fold -- "saw it without the keyboard, must see
// it with the keyboard". The decision CANNOT read the post-shift geometry
// (the shrink alone exceeds any threshold), so the bottom-state is remembered
// from the reader's own scroll events and the resize consults the PRE-shift
// state: pinned -> re-pin, instant scrollTop only (never smooth -- a smooth
// scroll mid-keyboard-animation is a visible double jump); reading history
// -> untouched. Attached after the initial position settles (see onMounted).

// -- Composer clearance (owner fix, 2026-09-08) --------------------------------
// The pill is an ABSOLUTE overlay: its autogrow used to just expand upward
// OVER the feed and bury the newest entries under the glass -- the content
// above never moved. The feed's bottom padding is therefore LIVE: it is the
// measured distance from the screen's bottom edge to the pill's TOP (+8px
// breathing), recomputed whenever the pill resizes (autogrow, draft prefill,
// the composing offset) or the screen geometry shifts (keyboard). A reader
// pinned to the bottom is re-pinned on growth, so the newest entry rides up
// above the pill like an ordinary chat; an unpinned reader keeps their place
// (the padding grows BELOW the content, nothing they see moves).
const composerEl = ref<HTMLElement | null>(null)
const composerClearance = ref<number | null>(null)

const composerStyle = computed<{ '--diary-composer-clearance'?: string }>(() =>
  composerClearance.value !== null
    ? { '--diary-composer-clearance': `${composerClearance.value}px` }
    : {},
)

function refreshComposerClearance(): void {
  const rootRect = screenEl.value?.getBoundingClientRect()
  const pillRect = composerEl.value?.getBoundingClientRect()
  if (!rootRect || !pillRect) return
  const needed = rootRect.bottom - pillRect.top + 8
  if (needed > 0) composerClearance.value = needed
}

let composerResizeObserver: ResizeObserver | null = null

function attachComposerResize(): void {
  if (composerResizeObserver || !composerEl.value) return
  composerResizeObserver = new ResizeObserver(() => {
    const before = composerClearance.value
    refreshComposerClearance()
    if (
      before !== null &&
      composerClearance.value !== null &&
      composerClearance.value > before &&
      chatScroll.isPinned()
    ) {
      void nextTick().then(scrollToBottom)
    }
  })
  composerResizeObserver.observe(composerEl.value)
}

// Top-align: filter/search results are shown at the TOP (via the wrapper's
// top-align class) so they do not slide to the middle/bottom of the screen
// (operator 2026-06-04).
function scrollToTop(): void {
  diaryStore.feedScrollTop = 0
  chatScroll.scrollToTop()
}

// Composer just created a note: the store refreshed the feed to the newest
// page, so jump to the bottom to reveal it.
async function onComposerCreated(): Promise<void> {
  await nextTick()
  scrollToBottom()
}

// -- Infinite scroll ---------------------------------------------------------

// Top sentinel of the thread. The sentinel only exists once items render and
// the results list UNMOUNTS the topzone while a search is active; useChatScroll
// rebuilds the observer whenever the element is swapped, so the thread's
// history keeps loading after leaving search.
//
// Prefetch lead (owner: the scroll must be seamless). The sentinel is the
// FIRST element, reached while scrolling UP, so only the TOP margin matters:
// ~two screens (1500px) of lead means the older page is in flight long before
// the reader reaches the seam -- combined with the 40-event pages
// (stores/diary.ts) the thread effectively never runs out mid-scroll.
// hasMore/loading guard the lead to one page ahead.
const topSentinel = chatScroll.observeSentinel(sentinelEl, {
  rootMargin: '1500px 0px 0px 0px',
  onIntersect: () => {
    if (historyCanLoadMore.value && !historyBusy.value) void onLoadMore()
  },
})

// Load an older page (triggered by scrolling UP to the top sentinel) and
// preserve the viewport: older cards are prepended at the top, so without
// compensation the content would jump. Measure height around the load and
// shift scrollTop by the delta. In a jump window the same mechanics serve
// the window's own cursor.
async function onLoadMore(): Promise<void> {
  await chatScroll.preservePosition(async () => {
    if (jumpActive.value) {
      await diaryStore.loadMoreJump()
      if (diaryStore.jumpError) toast.error(diaryStore.jumpError)
    } else {
      await diaryStore.loadMoreFeed()
      // The feed survives a failed page (the rung is initial-load-only), but
      // this fires from a scroll sentinel -- there is no button left sitting
      // there to look broken, so without a toast the user just scrolls into
      // nothing and is told nothing at all.
      if (diaryStore.feedLoadMoreError) toast.error(diaryStore.feedLoadMoreError)
    }
  })
}

// -- Results-list pagination ---------------------------------------------------
//
// Mirror of the thread's top sentinel, but at the BOTTOM: results are
// newest-first, so older result pages extend the list downward. Appends land
// below the viewport -- no scroll compensation is owed.

const resultsSentinelEl = ref<HTMLElement | null>(null)
chatScroll.observeSentinel(resultsSentinelEl, {
  rootMargin: '0px 0px 800px 0px',
  onIntersect: () => {
    if (feedHasMore.value && !feedLoading.value) void diaryStore.loadMoreFeed()
  },
})

onBeforeUnmount(() => {
  if (flashTimer) {
    clearTimeout(flashTimer)
    flashTimer = null
  }
  clearUndoTimer()
})
</script>

<style scoped>
/* Chat-style layout. The parent (MobileLayout main in `fill` mode) is a flex
   column that hands us its full height with no scroll of its own. Only the
   feed (.diary-feed__body) scrolls; the header buttons and the composer are
   absolute overlays the feed really passes beneath (owner 2026-09-07, which
   supersedes ruling 4's no-overlap-at-rest for the header; the composer was
   already an overlay). The background stays continuous behind all of it
   (nothing opaque cuts the runes backdrop). The scrollbar is hidden app-wide. */
/* PROMPT №663 (ruling 4 rebuild): a flex COLUMN, not an absolute-positioning
   host any more -- header / feed / composer are its three rows, in DOM
   order, none of them overlapping. While the keyboard is OPEN it is sized
   to the LIVE visible height (`--velo-vvh`, published by
   useViewportGeometry.ts), NOT 100% of the frozen ancestor (`AppFrame`'s
   `--velo-frozen-vh`): a normal-flow column
   sized to the FROZEN height would still put the composer at the frozen
   box's bottom while only the SHRUNKEN visible area is actually on screen --
   the same Android defect, merely restructured (this is the device-measured
   finding; the behaviour-spec doc was removed from docs/ 2026-09-29 and the
   finding lives here now -- history in git). [FE-44] corrects the REST
   state: the live-height binding now applies ONLY under
   `html.is-keyboard-open` (see the gated rule below) -- at rest the column
   is a plain 100% of the frozen ancestor, immune to a STALE `--velo-vvh`
   left over from a keyboard close whose resize event was missed (that
   staleness capped the whole screen at the keyboard-open height: mandala
   top, body-white bottom, the owner's screenshot). */
/* PROMPT №664: `--velo-vvh` is the RAW visual-viewport height -- it does NOT
   know about AppFrame's safe-area `padding-top` the way a PERCENTAGE height
   would (a percentage always resolves against the parent's content box,
   which already excludes that padding; an absolute px var does not).
   AppFrame's own content box is `--velo-vvh` (at rest) minus
   `--velo-content-safe-top` (0 in-chat, ~70px in Telegram fullscreen,
   env(safe-area-inset-top) outside Telegram -- useSafeArea.ts) -- binding straight to `--velo-vvh` reintroduced exactly
   this screen's own defect class in fullscreen: the column would be the
   FULL viewport tall while starting `--velo-content-safe-top` px down, so
   its bottom -- the composer -- would overshoot the actually-visible bottom
   by that same amount, clipped by `.mobile-layout__main--fill`'s
   `overflow:hidden`. Subtracting the var (published by AppFrame.vue
   alongside its padding) fixes it in BOTH modes: in-chat
   `--velo-content-safe-top` is 0, so `calc(vvh - 0px)` = `vvh`, BYTE-IDENTICAL
   to before this line existed (this is the mode all five of the owner's
   device screenshots were taken in, which is why the bug did not show up in
   them); fullscreen it correctly evaluates to `vvh - ~70px`, matching
   AppFrame's own reduced content box instead of overshooting it. */
.diary-feed {
  position: relative;
  /* The floating overlays' shared rail: the composer input's visible left
     edge (16px, owner's Apple Liquid Glass spec) -- and since 2026-09-08 the
     header's too: the owner aligns the back button to the INPUT's left
     edge, not the feed's 24px content rail (the right-corner "..." mirrors
     the same rail at the right edge). One source for both. */
  --diary-overlay-rail: 16px;
  height: 100%;
  /* Same value as the 100% above (AppFrame's content box = frozen-vh minus
     its safe-area padding), but as an INTERPOLABLE px calc: the FE-44 close
     transition animates between this and the keyboard-open height, and
     px<->percentage pairs don't interpolate. The 100% line above stays as
     the pre-JS-paint fallback. */
  height: calc(var(--velo-frozen-vh, 100%) - var(--velo-content-safe-top, 0px));
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* [FE-44] The live-height cap ONLY while the keyboard is open -- the class
   IS the keyboard state. When it drops (resize-driven publish, resetState on
   navigation, or the focusout recheck useViewportGeometry now runs), full
   height returns even if no closing resize event ever fires. No masking
   white blocks anywhere -- the background layer regains the full viewport
   on the same class removal. */
:global(html.is-keyboard-open) .diary-feed {
  height: calc(var(--velo-vvh, 100%) - var(--velo-content-safe-top, 0px));
}

/* [FE-44] The close expands at the keyboard's own speed (see the twin rule
   in global.css): while the closing class holds, the height transition
   interpolates from the capped value above to the at-rest px calc below. */
:global(html.is-keyboard-closing) .diary-feed {
  height: calc(var(--velo-frozen-vh, 100%) - var(--velo-content-safe-top, 0px));
  transition: height 250ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* -- Header: floating glass overlay over the feed (owner 2026-09-07) --
   Supersedes ruling 4 for the header: NOT a normal-flow row any more. The
   overlay's left edge is aligned to the INPUT's visible left edge -- the
   composer pill's 16px rail, shared via --diary-overlay-rail (owner,
   2026-09-08; a flush x=0 and the feed's 24px content rail were both
   tried and rejected the same day) -- with the back button (white glass,
   VBackButton's glass variant) at that LEFT rail and the "..." trigger
   (its usual solid DS look) at the RIGHT rail, on ONE line (owner
   2026-09-08: the column that sat "..." under the back button is retired),
   expanding downward into Filter/Search exactly as before -- and the feed
   scrolls beneath both; the buttons frost what passes under them (the same
   overlay model the composer uses at the bottom). No title. The
   `z-index: var(--z-sticky)` survives for the PROMPT №665 reason: the
   tap-catcher is gone, but positioned/z-indexed overlays must not
   intercept taps meant for the buttons; `--z-sticky` (200) keeps them
   on top. */
.diary-feed__header {
  position: absolute;
  top: var(--velo-fog-headerless-top);
  left: var(--diary-overlay-rail);
  right: var(--diary-overlay-rail);
  z-index: var(--z-sticky);
  display: flex;
  /* One HORIZONTAL axis through both CENTRES (the buttons differ in size,
     44 vs 40): flex-start would sit the narrower "..." 2px off the back
     button's centre line. */
  align-items: center;
  justify-content: space-between;
  /* The row spans the full width now, but only the two buttons are surface:
     without this, the empty middle of the 44px band would eat taps meant
     for the entries passing beneath it (the same overlay pass-through
     VHeader's floating row uses). */
  pointer-events: none;
  /* [2026-09-09] The swap with the search bar is a crossfade: opacity and a
     4px lift leave while visibility follows on the same delay -- hidden
     only AFTER the fade, so nothing pops. */
  transition:
    opacity var(--transition-base),
    transform var(--transition-base),
    visibility 0s var(--transition-base);
}

/* Pass-through exemption: the buttons -- and the VMenu panel while it is
   open -- become real surface again. */
.diary-feed__header > * {
  pointer-events: auto;
}

/* [owner 2026-09-09] REPLACED by the search bar: while any search state is
   up the row yields its slot to the bar. visibility:hidden takes the row
   out of the a11y tree and out of hit-testing once the fade ends; during
   the fade the explicit child pointer-events:none keeps the vanishing
   buttons inert. */
.diary-feed__header--replaced {
  opacity: 0;
  transform: translateY(-4px);
  visibility: hidden;
}

.diary-feed__header--replaced > * {
  pointer-events: none;
}

/* "..." trigger glyph: vertical dots that rotate to horizontal while the menu
   is open (approved animation, counter-clockwise). Soft ease-out so it glides
   to a stop rather than snapping (operator-tuned: 500ms soft ease-out). */
.diary-feed__dots {
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.diary-feed__dots--open {
  transform: rotate(-90deg);
}

/* Glyphs for the filter / search items inside the "..." menu (VMenu). The
   round button + popover styles now live in VMenu / VMenuItem. */
.diary-feed__menu-glyph {
  width: 18px;
  height: 18px;
}

/* The Figma magnifier path is drawn upright; rotate to the design angle. */
.diary-feed__menu-glyph--magnifier {
  width: 12px;
  height: 20px;
  transform: rotate(30deg);
}

/* -- Feed row: the ONLY scrolling area, running the FULL height -- the header
   buttons (owner 2026-09-07) and the composer are absolute overlays the
   entries really pass beneath. PROMPT №668 (ruling 6): NOT dimmed in any
   state; the blur-on-outside-click (onRootClickCapture) is the non-visual
   click-blocker that replaced the fog. No `position`/`z-index` on this
   element itself -- a plain flex row. NO edge fade any more: the curtain (the
   ruling-4 amendment's top fade, last survivor of the old 4-zone mask) is
   removed by the same owner ruling -- with the header floating OVER the feed
   the fade had nothing to transition into; content ends CRISP top and bottom
   alike (the bottom fade was already gone; the keyboard-time strip below the
   app is handled separately, global.css #app-bg cap). Kept as
   `.diary-feed__body` throughout every rebuild this cycle --
   DiaryFeedView.test.ts scopes nearly every assertion through it. */
.diary-feed__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* Only OUR compensation (onLoadMore) may move the offset on content
     growth: on engines where native scroll anchoring is on, the browser
     would adjust for the prepended history TOO and double the shift. */
  overflow-anchor: none;
  /* [FE-7] never chain this scroller's overscroll to the root -- the iOS
     gesture-pan the whole FE-7 fix exists to undo. */
  overscroll-behavior-y: contain;
  /* Top: just the shared headerless token. The corner buttons (back + menu)
     own BOTH top corners of a single 44px band; the thread's first date
     node is CENTERED and ~170px wide, so it clears the corner buttons
     horizontally and needs no full-height header clearance at rest -- the
     old ~150px clearance read as a big empty gap above the thread's first
     entry (owner removed it).
     Entries still pass UNDER the buttons while scrolling (overlay model);
     the searching state keeps its own taller clearance below the inline
     search row (see .diary-feed--searching below); the bottom pad is the
     LIVE composer clearance -- --diary-composer-clearance, measured from
     the pill's own top edge (100px fallback until first measure) -- so the
     pill's autogrow pushes the content up instead of burying it. */
  padding: var(--velo-fog-headerless-top) var(--velo-rail-pad-x)
    var(--diary-composer-clearance, 100px);
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* Chat-mode: a flex column so the thread wrapper can pin a short feed to the
     bottom (next to the composer). When the feed overflows, this has no effect
     and the area scrolls normally. */
  display: flex;
  flex-direction: column;
}
.diary-feed__body::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

/* While the inline search row is up (open mode or a live query), the results
   must start BELOW the bar, not hide behind it. The bar lives in the HEADER
   ROW'S slot (2026-09-09), so the clearance is the fog top + the field's
   own 50px + breathing room -- no header stack beneath it any more. */
.diary-feed--searching .diary-feed__body {
  padding-top: calc(var(--velo-fog-headerless-top) + var(--velo-size-50) + var(--space-4));
  /* The COMPOSER is temporarily gone with the search (owner 2026-09-09), so
     the pill's measured bottom clearance is replaced by a plain pad. */
  padding-bottom: var(--space-6);
}

/* -- Search scrim: RETIRED (owner 2026-09-09: blur and dimming removed)
   -- no dim, no soft blur; the screen behind the search stays fully visible
   and crisp. Closing the search is the bar's OUTER x. */

/* -- Inline search bar (owner 2026-09-07, round 3; 2026-09-09: THE HEADER
   ROW'S SLOT). The bar replaces back + "..." while any search state is up:
   same top edge, same 16px rails -- the 50px field runs 6px deeper than the
   44px band did, the only geometry the swap is allowed to change. The
   wrapper is ALWAYS MOUNTED and crossfades via --up (the mirror of the
   header's --replaced), so the swap reads as one continuous surface change,
   never a mount/unmount blink; the recents panel still hangs under the
   field. No scrim any more (owner 2026-09-09) -- the bar is simply the top
   control while it is up. */
.diary-feed__search {
  position: absolute;
  left: var(--diary-overlay-rail);
  right: var(--diary-overlay-rail);
  top: var(--velo-fog-headerless-top);
  z-index: calc(var(--z-sticky) + 1);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-4px);
  transition:
    opacity var(--transition-base),
    transform var(--transition-base),
    visibility 0s var(--transition-base);
}

.diary-feed__search--up {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
  transition:
    opacity var(--transition-base),
    transform var(--transition-base),
    visibility 0s 0s;
}

/* Pins a short feed to the bottom; a long one scrolls normally (margin-top
   collapses once content fills the column). */
.diary-feed__thread {
  margin-top: auto;
}

/* -- Search results list (2026-09-09, Telegram reference): compact jump rows
   in the same scroll container as the thread; the searching state's body
   padding-top already clears the inline bar above it. */
.diary-feed__results {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-bottom: var(--space-6);
}

/* Older result pages extend the list downward; 1px keeps it observable. */
.diary-feed__results-sentinel {
  height: 1px;
}

.diary-feed__state--results {
  padding: var(--space-4) 0 var(--space-2);
}

/* -- Jump flash: the found entry's row washes with the blue glass tint and
   fades out (Telegram's jump-to-message highlight). :deep because the row
   lives inside DiaryTimeline's scope; the class itself is added/removed as a
   transient animation trigger by revealJumpTarget. */
@keyframes diary-jump-flash {
  from {
    background-color: var(--velo-glass-blue-30);
  }
  to {
    background-color: transparent;
  }
}

:deep(.diary-feed__flash) {
  animation: diary-jump-flash var(--velo-dur-calm-long) var(--velo-ease-out);
  border-radius: var(--radius-md);
}

/* With a filter/search active the bottom pinning is disabled -- results go
   at the top (otherwise a few entries slide to the middle/bottom of the screen). */
.diary-feed__thread--top {
  margin-top: 0;
}

.diary-feed__state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.diary-feed__state--skeleton {
  flex-direction: column;
  justify-content: flex-end;
  min-height: 100%;
  padding-bottom: var(--space-4);
}

/* Zero-height rail the top sentinel and the loading-older overlay hang on.
   It exists so the loader can be position:absolute WITHOUT giving the body
   (which deliberately stays a plain flex row, PROMPT №668) a positioning
   context of its own. */
.diary-feed__topzone {
  position: relative;
  height: 0;
}

.diary-feed__state--more {
  /* Out of the flow ON PURPOSE: an in-flow loader added/removed ~70px of
     height above the thread at fetch start/end -- with the prefetch lead
     (1500px) that happens mid-scroll and the feed visibly jumped down and
     back. Absolute keeps the spinner at the content top (where the seam is)
     with zero layout impact. */
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: var(--space-5) 0;
}

.diary-feed__sentinel {
  height: 1px;
}

/* -- Undo bar (delete confirmation, Figma screen 58) --
   Floats just above the composer island in the overlay layout. */
.diary-feed__undo {
  position: absolute;
  left: var(--velo-rail-pad-x);
  right: var(--velo-rail-pad-x);
  bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  /* Deletion tone (Figma "entry deleted" spec): pink fill + pink border +
     rose text, distinct from the neutral glass chrome. */
  background: var(--velo-glass-pink-40);
  border: 1px solid var(--velo-pink-300);
  border-radius: var(--radius-md);
  backdrop-filter: blur(15px);
  -webkit-backdrop-filter: blur(15px);
}

.diary-feed__undo-text {
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  color: var(--velo-pink-700);
}

.diary-feed__undo-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  font-weight: 600;
  color: var(--velo-pink-700);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.diary-feed__undo-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.diary-feed__undo-btn:not(:disabled):hover {
  opacity: 0.8;
}

/* -- Composer: its own row, bottom of the column (ruling 4) --
   Transparent container; the field + send button are the only opaque/glass
   pixels ("keeping the glass"). The diary hides the tab bar, so the
   safe-area inset is added here to clear the home indicator. Same 33px side
   rail as the header row. PROMPT №663: no longer `position:absolute` and no
   longer click-through (same reasoning as the header -- see its own
   comment). PROMPT №665: `position:relative` + `z-index: var(--z-sticky)`
   restored for the SAME reason as the header, and still needed after `№668`
   -- must outrank the tap-catcher's `--z-content`, or it would intercept
   taps meant for the send button and the field. */
.diary-feed__composer {
  /* [owner spec, Apple Liquid Glass] The overlay: absolute over the scroll
     container, 16px rails, 12px off the bottom, above the feed. The glass
     pill itself (see Composer.vue) does the frost -- this wrapper is pure
     positioning, transparent, and NOTHING here (bottom/blur/transform/
     opacity) ever animates: the glass is static, only the content moves
     under it. */
  position: absolute;
  left: var(--diary-overlay-rail);
  right: var(--diary-overlay-rail);
  /* Owner pass: 12px sat TOO tight against the screen edge -- restored the
     pre-spec clearance (16 + 20 + safe-area), where the pill rode before. */
  bottom: calc(var(--space-4) + 20px + env(safe-area-inset-bottom, 0px));
  z-index: 20;
}

/* [owner pass] Keyboard state: while typing the pill drops ~20px closer to
   the keyboard (36 -> 16 + safe-area) -- the rest clearance is screen-edge
   padding, the composing one is a hair over the keys. Two stable states,
   NO transition on bottom (the static-glass rule: nothing animates while
   content scrolls; the state flips once with the keyboard). */
.diary-feed--composing .diary-feed__composer {
  bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
}

/* While writing (keyboard up) drop the composer's extra bottom offset so the
   buttons sit closer to the keyboard -- the keyboard<->buttons gap then roughly
   matches the buttons<->field gap. Unaffected by the ruling-4 restructure --
   purely cosmetic, was never part of the positioning mechanism.
   PROMPT №668 (ruling 6): the composer's compose-time `position:absolute`
   (added `№667` so its growth wouldn't disturb the ruling-5 freeze) is
   REMOVED -- ruling 6 killed the freeze it existed to serve (see the note at
   `.diary-feed__body` above), so the composer is back to being what ruling 4
   already made it: an ordinary `flex: 0 0 auto` row, at every text length,
   composing or not. Its growth now DOES compete with `.diary-feed__body` for
   the column's flex space again -- deliberately: that competition IS how
   "the feed rides up as the composer grows" (ruling 6, requirement 2)
   happens, with zero new code. */
/* [owner spec] The composing padding-bottom override is RETIRED with the
   flex row itself: the composer is an absolute overlay now (16/16/12), and
   with the keyboard open the whole shrunk screen carries it -- no padding
   to adjust. */

/* -- [FE-7] Tap-catcher: RETIRED. The absolute layer sat in the touch path
   with pointer-events:auto while composing -- iOS resolves the scroll target
   from the touchstart element, so every scroll gesture over the layer died
   (the "feed does not scroll with the keyboard open" device bug). The
   outside-tap blur now rides a CLICK capture on the root
   (onRootClickCapture): clicks fire after the gesture, so scrolling is
   untouched. The whole №665/№668 history is preserved in git. */
</style>
