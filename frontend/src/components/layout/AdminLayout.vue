<!--
  VELO Frontend -- AdminLayout Component (Phase F2.1; DS rebuild 2026-06-14)

  Full-screen layout for the admin role: optional header slot + scrollable content
  + the admin tab bar (VAdminTabBar -- stadium pills + count badges, the admin's
  own nav, distinct from the user/master VTabBar).

  Padding modes (new-design screens ride the 24px content rail; pre-rebuild admin
  screens keep the legacy 16px box):
    - `fog`        -> dashboard feed: 24px rail + edge-to-edge dissolve mask + tab-bar
                      bottom clearance.
    - `hideTabBar` -> detail screens (metric / revenue): 24px rail, no fog, no tab
                      bar, tighter bottom clearance.
    - neither      -> legacy admin list/detail screens (masters/reports/...): 16px box.

  Usage:
    <AdminLayout :tabs="ADMIN_TABS" :tab-items="withBadges" :active-tab="path" fog>
      <RouterView />
    </AdminLayout>
-->

<template>
  <div class="admin-layout">
    <slot name="header" />
    <main
      class="admin-layout__main velo-kbd-scroll"
      :class="{
        'admin-layout__main--rail': fog || hideTabBar,
        'admin-layout__main--fog': fog,
        'admin-layout__main--no-tabbar': hideTabBar,
      }"
    >
      <slot />
    </main>
    <VAdminTabBar
      v-if="!hideTabBar"
      :items="tabItems ?? tabs"
      :active="activeTab"
      @navigate="$emit('navigate', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import VAdminTabBar from '@/components/layout/VAdminTabBar.vue'
import type { TabItem } from '@/components/layout/VTabBar.vue'

defineProps<{
  tabs: TabItem[]
  /** Tab items carrying live badge counts. Falls back to `tabs` when omitted. */
  tabItems?: TabItem[]
  activeTab?: string
  /** Dashboard feed: edge-to-edge fog mask (implies the 24px rail). */
  fog?: boolean
  /** Detail screens: hide the tab bar (implies the 24px rail, no fog). */
  hideTabBar?: boolean
}>()

defineEmits<{
  navigate: [to: string]
}>()
</script>

<style scoped>
.admin-layout {
  display: flex;
  flex-direction: column;
  /* Shell fills AppFrame's stable height — never dvh/vh (collapse on keyboard).
     Mirrors MobileLayout (min-height:100%). Canon §2. */
  min-height: 100%;
  background: transparent;
  /* Anchor for the floating (position:absolute) VAdminTabBar. */
  position: relative;
}

.admin-layout__main {
  flex: 1;
  /* ROOT-LOCK: without min-height:0 a flex item's default min-size is its
     content size, which would let this grow taller than .admin-layout instead
     of scrolling internally -- now load-bearing (html/body/#app no longer
     absorb overflow at all). */
  min-height: 0;
  overflow-y: auto;
  /* PROMPT №503 commit 4: per the CSS overflow spec, leaving this axis at its
     `visible` default while overflow-y is non-visible computes it to `auto`
     too -- so any descendant even slightly wider than the viewport (an
     unbreakable label, a missed max-width) turned this WHOLE content area
     into a horizontal drag-scroll, dragging correctly-positioned siblings
     (e.g. a screen's own action button further up the column) sideways along
     with it. Defensive backstop alongside the actual content-width fixes on
     individual screens (AdminCatalogView) -- clips rather than scrolls a
     stray overflow instead of leaving every admin screen silently exposed
     to the same failure mode.
  */
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  /* Legacy default (pre-rebuild admin screens): 16px box, clears the tab bar. */
  padding: var(--space-4) var(--space-4) calc(112px + env(safe-area-inset-bottom, 0px));
}

/* New-design screens ride the 24px content rail (matches user/master). */
.admin-layout__main--rail {
  padding-left: var(--velo-rail-pad-x);
  padding-right: var(--velo-rail-pad-x);
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.admin-layout__main--rail::-webkit-scrollbar {
  display: none;
}

/* Detail screens (no tab bar): tighter vertical clearance. */
.admin-layout__main--no-tabbar {
  padding-top: var(--space-4);
  padding-bottom: calc(var(--space-8) + env(safe-area-inset-bottom, 0px));
}

/* Dashboard feed: edge-to-edge fog + tab-bar clearance. The fog literals
   (40/60/160/90) mirror MobileLayout's hardcoded defaults -- both join the parked
   FOG-TOKENS-UNIFY pass. Admin has no floating header island, so the top clearance
   is a flat 60 (no measured-island math). */
.admin-layout__main--fog {
  padding-top: 60px;
  padding-bottom: calc(160px + env(safe-area-inset-bottom, 0px));
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent 40px,
    #000 60px,
    #000 calc(100% - 160px),
    transparent calc(100% - 90px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent 40px,
    #000 60px,
    #000 calc(100% - 160px),
    transparent calc(100% - 90px),
    transparent 100%
  );
}
</style>
