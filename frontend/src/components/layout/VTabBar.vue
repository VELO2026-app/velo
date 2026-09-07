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

  TabItem.badge is the PRESENCE-DOT slot (FE-11/FE-12: the user zone's bell
  tab carries it). A truthy badge renders the coral dot -- no number, per the
  owner ruling; 0/undefined renders nothing. Admin tabs pass their counts to
  VAdminTabBar instead, so this stays a user-zone concern.

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
        <component
          v-if="typeof item.icon !== 'string'"
          :is="item.icon"
          :size="item.compact ? 22 : 27"
        />
        <template v-else>{{ item.icon }}</template>
        <span v-if="item.badge" class="v-tabbar__badge" aria-hidden="true" />
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
  /** Presence dot (FE-11/FE-12): truthy = the coral dot renders. No number
   *  is shown -- the owner ruled the bell indicator presence-only. */
  badge?: number | string
  /** Shrinks the GLYPH (27 -> 22) while the 56px touch target stays uniform
   *  (FE-26 standard). Used by the user zone's bell, owner ask. */
  compact?: boolean
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
 * buttons spread space-between across it; 56px bare-icon buttons (above
 * the 44px touch standard, FE-26); the active tab is a clean blue-grey
 * disc + white icon, no hairline (owner v2).
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
  /* Spread the fixed 56px targets across the stretched pill -- the tab-dock
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
     inactive button paints nothing of its own. 56px keeps every target
     above the 44px touch standard (FE-26). */
  width: 56px;
  height: 56px;
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
   56px visuals shrink every tap target below the old 63px bubbles and move
   them off the muscle-memory spots -- an invisible -8px ring grows each
   TAPPABLE circle back to 72px and covers the 8px gaps between neighbours,
   without painting anything (the pill's own geometry is untouched). */
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
   lets it absorb the free width the content-rail stretch created (its
   56px width becomes the flex basis, siblings keep their fixed targets),
   and the item's own radius-full rounds the ends the same way the disc
   was. The base transition's flex-grow leg hands the width smoothly from
   the previously-active tab to the next one. */
.v-tabbar__item--active {
  flex-grow: 1;
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
  /* The badge anchors to the GLYPH box (not the 56px target), so it hugs the
     icon corner at any icon size. */
  position: relative;
}

/* [FE-11/FE-12] Presence dot for a tab carrying a truthy badge (the user
   zone's bell): coral 10px with a 1px white ring INSIDE the box (global
   box-sizing border-box; 8px coral core). Anchored -0.7px into the glyph's
   top-right corner -- a ~7% corner overlap of the 10px dot (owner ask),
   sized against the glyph so it survives icon-size changes. The item already
   sits at z:1 above the pill's soft-light sheen. No number -- presence only. */
.v-tabbar__badge {
  position: absolute;
  top: -0.7px;
  right: -0.7px;
  width: var(--velo-size-10);
  height: var(--velo-size-10);
  border: 1px solid var(--velo-white);
  border-radius: var(--radius-full);
  background: var(--velo-pink-300);
}
</style>
