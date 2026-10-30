<!--
  VELO Frontend -- VLoadingSwap (loading system, report §8.3.4)

  The one way a screen block goes from "loading" to "content":
    - `pending` = nothing to show yet AND a request is in flight (a block
      that already has data -- from the cache, a previous key, a seed --
      is NOT pending: it shows that data while it refreshes);
    - the skeleton slot is mounted at once but stays invisible for
      --velo-skeleton-delay (300 ms, VSkeleton's own CSS): an answer inside
      it NEVER shows a skeleton -- the block just holds its place and the
      content fades in; once a skeleton was seen, it stays at least 450 ms
      (useLoadingHold) -- no one-frame blink;
    - skeleton and content share one grid cell and crossfade in place;
      content that was there from the start (cache) appears without a fade.
    - `memory-key`: the block remembers its last settled height (per tab,
      platform/session-memo) and holds exactly that while it loads, so even
      the empty waiting phase reserves the right space and nothing below
      moves when the answer is the same size as last time.
    - `revision`: a value that changes when the content's SHAPE changes (ids
      of the rows). A silent refresh that adds or drops rows then glides the
      height the same way (pair it with a TransitionGroup whose leaving rows
      are out of flow, motion.css .velo-list).
    - height (`animate-height`, on by default): when the answer is shorter or
      taller than the skeleton (an empty state, one booking instead of three)
      the block does NOT snap. The leaving skeleton is lifted out of flow, the
      block is measured before and after the swap and its height glides once
      between the two (--velo-dur-resize, ease-out) -- everything below
      glides with it -- then goes back to auto. A swap to nothing collapses
      the block to 0 the same way. Reduced motion: the height is instant,
      only the short fade stays. Size the skeleton like the last answer with
      useRememberedCount to make the difference small in the first place.

  Accessibility: the container is aria-busy while the skeleton is up; a
  visually hidden status line announces the load.

  Usage:
    <VLoadingSwap :pending="isPending">
      <template #skeleton><VSkeletonPracticeCard /></template>
      <PracticeList v-if="items.length" :items="items" />
      <VEmptyState v-else ... />
    </VLoadingSwap>
-->

<template>
  <div
    ref="rootEl"
    class="v-loading-swap"
    :style="reserveStyle"
    :aria-busy="showSkeleton ? 'true' : undefined"
  >
    <!-- :css="reveal": until a skeleton was actually seen, it leaves at once
         (it was invisible) -- no stray frame, no leave delay. -->
    <Transition name="v-loading-swap-skeleton" :css="reveal">
      <div v-if="showSkeleton" class="v-loading-swap__layer v-loading-swap__skeleton">
        <slot name="skeleton" />
        <span role="status" class="velo-sr-only">{{ label ?? t('common.loading') }}</span>
      </div>
    </Transition>
    <!-- Content fades in whenever it had to be waited for (even inside the
         skeleton delay); content that was there from the start does not. -->
    <Transition name="v-loading-swap-content" :css="waited" @leave="leaveNow">
      <div v-if="!showSkeleton" class="v-loading-swap__layer">
        <slot />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@/locales'
import { useLoadingHold } from '@/composables/useLoadingHold'
import { prefersReducedMotion, rootDurationMs } from '@/platform/dom'
import { readSessionNumber, writeSessionNumber } from '@/platform/session-memo'

const props = withDefaults(
  defineProps<{
    pending: boolean
    /** Screen-reader status text; defaults to common.loading. */
    label?: string
    /** Glide the block's height from the skeleton's to the content's. */
    animateHeight?: boolean
    /** Remember the settled height under this name and reserve it while
     * loading (one name per block). */
    memoryKey?: string
    /** Changes when the content's shape changes (row ids): glide to it. */
    revision?: string | number
  }>(),
  {
    label: undefined,
    animateHeight: true,
    memoryKey: undefined,
    revision: undefined,
  },
)

const { showSkeleton, reveal } = useLoadingHold(() => props.pending)

/** The content had to be waited for at least once (fade it in). */
const waited = ref(props.pending)
watch(
  () => props.pending,
  (on) => {
    if (on) waited.value = true
  },
)

/** Content never lingers on its way out (the skeleton takes its place at
 * once): an explicit `done` ends the leave synchronously. */
function leaveNow(_el: Element, done: () => void): void {
  done()
}

// -- Reserved height from memory ----------------------------------------------
const HEIGHT_PREFIX = 'velo:block-height:'
const remembered = props.memoryKey ? readSessionNumber(HEIGHT_PREFIX + props.memoryKey) : null
const reserveStyle = computed(() =>
  showSkeleton.value && remembered !== null
    ? { height: `${remembered}px`, overflow: 'hidden' }
    : undefined,
)

// -- Height glide (FLIP on the one wrapper) -----------------------------------
const SIZING_CLASS = 'v-loading-swap--sizing'
/** Safety net when transitionend never comes (hidden tab, zero duration). */
const RESIZE_FALLBACK_MS = 300
const rootEl = ref<HTMLElement | null>(null)
let fromHeight: number | null = null
let sizingTarget: number | null = null
let sizingTimer: ReturnType<typeof setTimeout> | null = null
let sizingEnd: ((event: TransitionEvent) => void) | null = null

function rememberHeight(height?: number): void {
  const el = rootEl.value
  if (!props.memoryKey || !el || showSkeleton.value) return
  writeSessionNumber(
    HEIGHT_PREFIX + props.memoryKey,
    Math.round(height ?? el.getBoundingClientRect().height),
  )
}

function stopSizing(el: HTMLElement, settled = false): void {
  if (sizingTimer !== null) clearTimeout(sizingTimer)
  sizingTimer = null
  if (sizingEnd) el.removeEventListener('transitionend', sizingEnd)
  sizingEnd = null
  const target = sizingTarget
  sizingTarget = null
  el.classList.remove(SIZING_CLASS)
  el.style.height = ''
  if (settled && target !== null) rememberHeight()
}

/** Before a patch: the height on screen right now (mid-glide too). */
function measureFrom(): void {
  const el = rootEl.value
  fromHeight = props.animateHeight && el ? el.getBoundingClientRect().height : null
}

/** After it: glide once from the measured height to the natural one. */
function glide(): void {
  const el = rootEl.value
  const from = fromHeight
  fromHeight = null
  if (!el || from === null) return
  stopSizing(el)
  const to = el.getBoundingClientRect().height
  if (Math.abs(to - from) < 1 || prefersReducedMotion()) {
    rememberHeight(to)
    return
  }
  sizingTarget = to
  el.style.height = `${from}px`
  el.classList.add(SIZING_CLASS)
  void el.offsetHeight // commit the start height before the target
  el.style.height = `${to}px`
  sizingEnd = (event: TransitionEvent) => {
    if (event.target === el && event.propertyName === 'height') stopSizing(el, true)
  }
  el.addEventListener('transitionend', sizingEnd)
  sizingTimer = setTimeout(
    () => stopSizing(el, true),
    rootDurationMs('--velo-dur-resize', RESIZE_FALLBACK_MS) + 100,
  )
}

// The skeleton -> content swap (the leaving skeleton is out of flow).
watch(showSkeleton, measureFrom, { flush: 'pre' })
watch(showSkeleton, glide, { flush: 'post' })

// A silent refresh that changed the rows (leaving rows are out of flow).
watch(
  () => props.revision,
  () => {
    if (!showSkeleton.value) measureFrom()
  },
  { flush: 'pre' },
)
watch(() => props.revision, glide, { flush: 'post' })

onMounted(() => {
  // Content straight from the cache: that is the height to remember.
  if (!showSkeleton.value) rememberHeight()
})

onBeforeUnmount(() => {
  const el = rootEl.value
  if (!el) return
  // Leaving mid-glide: the target is the height it was settling to.
  if (sizingTarget !== null) rememberHeight(sizingTarget)
  else rememberHeight()
  stopSizing(el)
})
</script>

<style scoped>
.v-loading-swap {
  display: grid;
  position: relative;
}

/* While the height glides: clip to it (the leaving skeleton is taller). */
.v-loading-swap--sizing {
  overflow: hidden;
  will-change: height;
  transition: height var(--velo-dur-resize) var(--velo-ease-out);
}

.v-loading-swap__layer {
  grid-area: 1 / 1;
  min-width: 0;
}

.v-loading-swap__skeleton {
  pointer-events: none;
}

.v-loading-swap-content-enter-active {
  transition: opacity var(--velo-dur-base) var(--velo-ease-out);
}

.v-loading-swap-skeleton-leave-active {
  /* Out of flow while it fades: the block takes the content's height at once
     (and glides to it), instead of holding the skeleton's until the fade
     ends and then snapping. */
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  transition: opacity var(--velo-dur-fast) var(--velo-ease-in);
}

.v-loading-swap-content-enter-from,
.v-loading-swap-skeleton-leave-to {
  opacity: 0;
}
</style>
