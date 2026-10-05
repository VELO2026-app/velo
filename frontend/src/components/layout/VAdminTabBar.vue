<!--
  VELO Frontend -- VAdminTabBar (Admin DS rebuild 2026-06-14, operator SVG "ПАНЕЛЬ" / "1 Dashboard")

  Admin-only bottom tab bar. DISTINCT from the shared VTabBar (user/master): per the
  operator's admin design the pills are STADIUM-shaped (not circles), the active tab
  is marked by a white GLOW (not a darker fill), and tabs carry pink count BADGES.
  Built as its own component on the operator's instruction ("свой таббар") so the
  shipped user/master VTabBar (circles) stays byte-identical.

  Visual spec (operator SVG, 402-frame):
    - Pill: 90x62, radius 31 (full stadium), glass fill --velo-nav-inactive-bg,
      1.26px white rim, backdrop-blur 2.52px, primary monochrome icon.
    - Active pill: 92x63 + white glow (--velo-shadow-glow). Fill/icon unchanged --
      the glow is the ONLY active cue (NOT the fill-darken VTabBar uses).
    - Badge: pink-300 circle top-right with a white count; rendered only when
      item.badge is set (positive). 0 -> no badge.
    - 3 tabs spread across the 24px content rail (space-between), no text labels.

  Usage:
    <VAdminTabBar :items="tabs" :active="currentRoute" @navigate="router.push($event)" />
-->

<template>
  <nav class="v-admin-tabbar">
    <button
      v-for="item in items"
      :key="item.to"
      class="v-admin-tabbar__item"
      :class="{ 'v-admin-tabbar__item--active': active === item.to }"
      :aria-label="item.label"
      :aria-current="active === item.to ? 'page' : undefined"
      type="button"
      @click="$emit('navigate', item.to)"
    >
      <span v-if="item.badge" class="v-admin-tabbar__badge">{{ item.badge }}</span>
      <span class="v-admin-tabbar__icon">
        <component :is="item.icon" v-if="typeof item.icon !== 'string'" :size="27" />
        <template v-else>{{ item.icon }}</template>
      </span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { TabItem } from '@/router/tabs'

defineProps<{
  items: TabItem[]
  active?: string
}>()

defineEmits<{
  navigate: [to: string]
}>()
</script>

<style scoped>
.v-admin-tabbar {
  /* Floats over the edge-to-edge feed (AdminLayout is the positioned anchor), so
     content scrolls UNDER it and dissolves into the bottom fog. */
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  /* Spread the pills across the 24px content rail so the outer pills sit on the
     same left/right lines as the screen content/headers. */
  justify-content: space-between;
  padding: var(--space-2) var(--velo-rail-pad-x);
  padding-bottom: calc(var(--space-8) + env(safe-area-inset-bottom, 0px));
  background: transparent;
  z-index: var(--z-sticky);
}

.v-admin-tabbar__item {
  position: relative;
  /* Admin-tabbar-specific geometry (operator SVG) -- stadium pill, not reusable. */
  width: 90px;
  height: 62px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 31px;
  cursor: pointer;
  color: var(--velo-text-primary);
  /* Inactive (default): glass bubble. Same glass tokens as VTabBar; only the
     shape differs. */
  background: var(--velo-nav-inactive-bg);
  border: 1.26px solid var(--velo-glass-border);
  backdrop-filter: blur(2.52px);
  -webkit-backdrop-filter: blur(2.52px);
  transition: box-shadow var(--transition-fast);
}

/* Active = white glow halo (operator SVG). Fill + icon unchanged; the glow is the
   only active cue -- distinct from VTabBar's fill-darken active state. */
.v-admin-tabbar__item--active {
  width: 92px;
  height: 63px;
  box-shadow: var(--velo-shadow-glow);
}

.v-admin-tabbar__item:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.v-admin-tabbar__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

/* Pink count badge, top-right (operator SVG). Rendered only when item.badge set. */
.v-admin-tabbar__badge {
  position: absolute;
  top: -2px;
  right: 6px;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--velo-pink-300);
  color: var(--velo-white);
  border: 2px solid var(--velo-glass-border);
  font-size: var(--text-xs);
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
