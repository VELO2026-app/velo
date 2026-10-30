<!--
  VELO Frontend -- VTabBar Component (Figma redesign, node 541:6649)

  Bottom tab navigation. Per-role tab items (user 4 / master 4 / admin 4).

  Visual spec (Figma node 2212:292 / 2212:390):
    - Inactive tab: 63x63 circle, 1.26px white border, glass-blue fill
      (--velo-nav-inactive-bg = rgba(98,122,156,0.15)), backdrop-blur,
      monochrome icon in --velo-text-primary.
    - Active tab: same circle slot, same border + blur as inactive, but
      a soft blue-grey fill (--velo-nav-active-bg-glass = rgba(98,122,
      156,0.60)) with a white icon. Per Figma the only difference
      between states is the fill alpha (.15 -> .60); border, blur and
      shape stay the same. Do NOT use --velo-nav-active-bg here — that
      token is opaque #627a9c, used by VMenu/VMenuItem.
    - No text labels under icons. aria-label preserved for screen readers.
    - The bar sits ~25px above the screen edge (space-8 padding-bottom)
      so it doesn't visually stick to the bottom.

  Usage:
    <VTabBar :items="tabs" :active="currentRoute" @navigate="router.push($event)" />
-->

<template>
  <nav ref="navEl" class="v-tabbar" :class="{ 'v-tabbar--unmeasured': !indicator }">
    <!-- The active disc is ONE element that travels (transform only) from the
         old tab to the new one, on the same clock as the screen crossfade
         (--velo-dur-tab). Until it is measured (first paint, test DOM) the
         active button paints its own fill, so the bar is never without one. -->
    <span
      class="v-tabbar__indicator"
      :class="{ 'v-tabbar__indicator--animate': animate }"
      :style="indicatorStyle"
      aria-hidden="true"
    />
    <button
      v-for="item in items"
      :key="item.to"
      :ref="itemRef(item.to)"
      class="v-tabbar__item"
      :class="{ 'v-tabbar__item--active': current === item.to }"
      :aria-label="item.label"
      :aria-current="current === item.to ? 'page' : undefined"
      type="button"
      @pointerdown="$emit('intent', item.to)"
      @click="onTap(item.to)"
    >
      <span class="v-tabbar__icon">
        <component :is="item.icon" v-if="typeof item.icon !== 'string'" :size="27" />
        <template v-else>{{ item.icon }}</template>
      </span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { TabItem } from '@/router/tabs'

const props = defineProps<{
  items: TabItem[]
  active?: string
}>()

const emit = defineEmits<{
  navigate: [to: string]
  /** Finger down on a tab: the shell warms that screen's chunk. */
  intent: [to: string]
}>()

// ---------------------------------------------------------------------------
// Optimistic active tab: the disc starts moving on the tap itself, not when
// the router has finished (chunk, guards, the transition's snapshot). The
// route's own `active` takes over as soon as it arrives. It hands back only
// when the navigation clearly went elsewhere (a guard redirect: `active`
// lands on a tab that was never tapped) or never landed at all (PENDING_MS,
// generous on purpose -- a slow first chunk on a dev tunnel must not bounce
// the disc back and forth).
// ---------------------------------------------------------------------------
const PENDING_MS = 8000
const pending = ref<string | null>(null)
/** Tabs tapped since the hold started (a rapid double tap's stops). */
const tapped = new Set<string>()
let pendingTimer: ReturnType<typeof setTimeout> | null = null

const current = computed(() => pending.value ?? props.active)

function clearPending(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer)
  pendingTimer = null
  pending.value = null
  tapped.clear()
}

watch(
  () => props.active,
  (active) => {
    if (pending.value === null) return
    // An intermediate stop of a rapid double tap must not bounce the disc.
    if (active !== undefined && active !== pending.value && tapped.has(active)) return
    clearPending()
  },
)

function onTap(to: string): void {
  if (to === props.active) {
    clearPending()
  } else if (to !== current.value) {
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    pending.value = to
    tapped.add(to)
    pendingTimer = setTimeout(clearPending, PENDING_MS)
  }
  emit('navigate', to)
}

// ---------------------------------------------------------------------------
// The travelling disc + FLIP for the buttons. The active button is the wider
// stadium (flex-grow, capped), so a switch re-lays the row out at once; each
// button then glides from where it was (translateX, compositor-only) instead
// of the old flex-grow tween that re-laid the row out on every frame.
// ---------------------------------------------------------------------------
const navEl = ref<HTMLElement | null>(null)
const els = new Map<string, HTMLElement>()

function itemRef(to: string) {
  return (el: Element | ComponentPublicInstance | null): void => {
    if (el instanceof HTMLElement) els.set(to, el)
    else els.delete(to)
  }
}

const indicator = ref<{ x: number; y: number; w: number; h: number } | null>(null)
/** Off for the first placement (the disc must not fly in from the left). */
const animate = ref(false)

const indicatorStyle = computed(() => {
  const box = indicator.value
  if (!box) return { opacity: '0' }
  return {
    width: `${box.w}px`,
    height: `${box.h}px`,
    transform: `translate(${box.x}px, ${box.y}px)`,
  }
})

function measure(): void {
  const el = current.value ? els.get(current.value) : undefined
  // Zero width = not laid out (hidden, or a DOM without layout).
  indicator.value =
    el && el.offsetWidth > 0
      ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
      : null
}

function centres(): Map<string, number> {
  const out = new Map<string, number>()
  for (const [to, el] of els) out.set(to, el.offsetLeft + el.offsetWidth / 2)
  return out
}

watch(current, () => {
  // flush 'pre': the DOM still holds the old row.
  const before = centres()
  void nextTick(() => {
    for (const [to, el] of els) {
      const was = before.get(to)
      if (was === undefined) continue
      const dx = was - (el.offsetLeft + el.offsetWidth / 2)
      if (Math.abs(dx) < 0.5) continue
      el.style.transition = 'none'
      el.style.transform = `translateX(${dx}px)`
      void el.offsetWidth // commit the start state, then glide to 0
      el.style.transition = ''
      el.style.transform = ''
    }
    measure()
    animate.value = indicator.value !== null
  })
})

watch(
  () => props.items.map((item) => item.to).join('|'),
  () => void nextTick(measure),
)

let ro: ResizeObserver | null = null

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'function' && navEl.value) {
    ro = new ResizeObserver(() => measure())
    ro.observe(navEl.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (pendingTimer !== null) clearTimeout(pendingTimer)
})
</script>

<style scoped>
/* ==========================================================================
 * [LOOK-TEST v2, owner pass 2026-09-06] Compact liquid-glass dock pill.
 * Approved direction ("нравится"), still a git-revertible experiment vs
 * the per-button Figma bubbles described in the file banner above.
 *
 * ONE floating glass pill, built from the diary composer's Apple Liquid
 * Glass recipe (Composer.vue .composer__field): a frost layer on ::before
 * (white 12% over blur(18) saturate(180), own z:-1 child layer), a
 * soft-light sheen on ::after, white rim, inset edge highlights + a
 * floating shadow. The pill is STRETCHED TO THE CONTENT RAIL (owner,
 * 2026-09-07 -- one --velo-rail-pad-x in from each side, the middle ground
 * between the rejected rail-to-rail v1 and the content-hugged v2), the
 * buttons spread space-between across it; 48px bare-icon buttons (still
 * above the 44px touch standard, FE-26) slim the pill's HEIGHT (owner,
 * 2026-09-08) while its width stays stretched to the content rail; the
 * active tab is a blue-grey pill + white icon, no hairline (owner v2) --
 * elongated, but capped at a tidy 2:1 stadium (owner, 2026-09-08).
 * ========================================================================== */
.v-tabbar {
  position: absolute;
  /* Stretched to the feed's own rail: the same --velo-rail-pad-x the main
     content pads with, so the pill's edges line up with the cards' edges.
     The z-index below (on this positioned element) forms the stacking
     context that contains the frost's z:-1 layer -- the job the old
     translateX(-50%) used to double for. */
  left: var(--velo-rail-pad-x);
  right: var(--velo-rail-pad-x);
  /* Lift the PILL itself (not inner padding) away from the screen edge:
     33px + safe-area of clear space below the glass, buttons tucked 8px
     inside it. Keeps the home-indicator clearance of Figma 2212:292. */
  bottom: calc(var(--space-8) + env(safe-area-inset-bottom, 0px));
  display: flex;
  align-items: center;
  /* Spread the fixed 48px targets across the stretched pill -- the tab-dock
     look; without this they would cluster left with a dead right end. */
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2);
  /* [Apple Liquid Glass, owner spec -- same recipe as Composer.vue] the
     pill's own background stays transparent; the frost lives on ::before
     at z:-1 so icon repaints never race the backdrop sampling (the
     iOS-stable shape for glass over moving content). */
  background: transparent;
  border: 1px solid var(--velo-glass-white-35);
  border-radius: var(--velo-radius-pill);
  box-shadow: var(--velo-shadow-glass);
  z-index: var(--z-sticky);
  /* Own View Transition layer (styles/motion.css): stays put between tab
     screens, slides away when a detail screen hides the dock. */
  view-transition-name: velo-tabbar;
}

/* The frost layer: white 12% surface over blur(12) saturate(150), on its own
   child layer (z -1). The nav's absolute position + z-index already form the
   stacking context that keeps it contained -- the composer's translateZ(0)
   anchor trick is not needed here. The dock floats over a scrolling feed, so
   this blur is re-sampled on every scrolled frame: 12px reads as the same
   frost at a 60Hz WebKit budget, 18px + 180% saturate did not fit it. */
.v-tabbar::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--velo-glass-white-12);
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
  z-index: -1;
}

/* The refraction sheen: a diagonal light gradient blended soft-light over
   the surface -- the highlight that reads as bent glass. */
.v-tabbar::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(
    135deg,
    var(--velo-glass-white-35),
    var(--velo-glass-white-05) 45%,
    var(--velo-glass-white-18)
  );
  mix-blend-mode: soft-light;
}

.v-tabbar__item {
  /* Bare icon slot inside the pill: the glass comes from the dock, so an
     inactive button paints nothing of its own. 48px keeps every target
     above the 44px touch standard (FE-26) while slimming the pill (owner,
     2026-09-08: height down 72 -> 64px, width unchanged). */
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  cursor: pointer;
  color: var(--velo-text-primary);
  background: transparent;
  border: none;
  /* Lifts the icons (and the active disc) ABOVE the ::after sheen -- the
     same fix as the composer's send button: soft-light was washing solid
     fills out to "lost". */
  position: relative;
  z-index: 1;
  /* transform = the FLIP glide on a tab switch (script); same clock as the
     travelling disc and the screen crossfade. */
  transition:
    background-color var(--transition-base),
    color var(--velo-dur-tab) var(--velo-ease-out),
    transform var(--velo-dur-tab) var(--velo-ease-out);
  -webkit-tap-highlight-color: transparent;
}

.v-tabbar__item:active .v-tabbar__icon {
  transform: scale(0.92);
  transition-duration: var(--velo-dur-press);
}

/* [FE-26 pattern, VBackButton precedent] Touch skirt: the pill's compact
   48px visuals sit below the muscle-memory spots of the old 63px bubbles --
   an invisible -8px ring grows each TAPPABLE circle back to 64px and covers
   the gaps between neighbours, without painting anything (the pill's own
   geometry is untouched). */
.v-tabbar__item::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: var(--radius-full);
}

/* Active (Figma 2212:390 palette; owner v2 -- NO hairline): a clean
   blue-grey fill with a white icon, the only button that paints a
   background. The frost behind it comes from the pill, not the button.
   [owner, 2026-09-07] The active tab is an ELONGATED pill: flex-grow: 1
   lets it absorb free width (its 48px width is the flex basis, siblings
   keep their fixed targets), and the item's own radius-full rounds the
   ends. The width change itself is instant; the buttons glide into the
   new row (FLIP, transform) and the fill travels as one disc.
   [owner, 2026-09-08] But the pill no longer drinks the dock's WHOLE free
   width (~158px at a 390px viewport, ~196px at 428px -- it read as a bar,
   not a tab): max-width caps it at 96px, twice the 48px base circle -- a
   2:1 stadium. Free width left past the cap returns to the space-between
   spread; viewports below ~346px never reach the cap, so the elongation
   still flexes there exactly as before. */
.v-tabbar__item--active {
  flex-grow: 1;
  max-width: 96px;
  color: var(--velo-white);
}

/* Before the disc is measured, the active button carries the fill itself. */
.v-tabbar--unmeasured .v-tabbar__item--active {
  background: var(--velo-nav-active-bg-glass);
}

/* The travelling active disc: sized and placed by the script to the active
   button's box. Above the ::after sheen (same z as the buttons, earlier in
   the DOM, so the icons paint over it). */
.v-tabbar__indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  border-radius: var(--radius-full);
  background: var(--velo-nav-active-bg-glass);
  pointer-events: none;
}

.v-tabbar__indicator--animate {
  transition:
    transform var(--velo-dur-tab) var(--velo-ease-out),
    width var(--velo-dur-tab) var(--velo-ease-out);
}

.v-tabbar__item:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.v-tabbar__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  font-size: var(--velo-fs-22);
  transition: transform var(--transition-fast);
}
</style>
