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
  <nav class="v-tabbar">
    <button
      v-for="item in items"
      :key="item.to"
      class="v-tabbar__item"
      :class="{ 'v-tabbar__item--active': active === item.to }"
      :aria-label="item.label"
      :aria-current="active === item.to ? 'page' : undefined"
      type="button"
      @click="$emit('navigate', item.to)"
    >
      <span class="v-tabbar__icon">
        <component v-if="typeof item.icon !== 'string'" :is="item.icon" :size="27" />
        <template v-else>{{ item.icon }}</template>
      </span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { Component } from 'vue'

export interface TabItem {
  icon: string | Component
  label: string
  to: string
  /** Count badge -- rendered by VAdminTabBar only (admin counts); the
   *  user/master VTabBar itself paints no badges. */
  badge?: number | string
}

defineProps<{
  items: TabItem[]
  active?: string
}>()

defineEmits<{
  navigate: [to: string]
}>()
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
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -1px 0 rgba(255, 255, 255, 0.15),
    0 8px 24px rgba(0, 0, 0, 0.08);
  z-index: var(--z-sticky);
}

/* The frost layer: white 12% surface over blur(18) saturate(180), on its own
   child layer (z -1). The nav's absolute position + z-index already form the
   stacking context that keeps it contained -- the composer's translateZ(0)
   anchor trick is not needed here. */
.v-tabbar::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
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
    rgba(255, 255, 255, 0.35),
    rgba(255, 255, 255, 0.05) 45%,
    rgba(255, 255, 255, 0.18)
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
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    flex-grow var(--transition-fast);
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
   ends. The base transition's flex-grow leg hands the width smoothly
   from the previously-active tab to the next one.
   [owner, 2026-09-08] But the pill no longer drinks the dock's WHOLE free
   width (~158px at a 390px viewport, ~196px at 428px -- it read as a bar,
   not a tab): max-width caps it at 96px, twice the 48px base circle -- a
   2:1 stadium. Free width left past the cap returns to the space-between
   spread; viewports below ~346px never reach the cap, so the elongation
   still flexes there exactly as before. */
.v-tabbar__item--active {
  flex-grow: 1;
  max-width: 96px;
  background: var(--velo-nav-active-bg-glass);
  color: var(--velo-white);
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
  font-size: 22px;
}
</style>
