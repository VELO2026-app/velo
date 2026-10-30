<!--
  VELO Frontend -- TabRouterView: the shell's RouterView with live tab roots

  A native tab bar does not rebuild a tab when you come back to it: the
  screen is still there, scrolled where you left it, its data on screen, and
  it only refreshes quietly. This is that for the dock: the TAB ROOT screens
  (`keep`) are kept alive (KeepAlive, at most `max`), so a tap on the dock
  re-attaches a finished screen -- no mount, no first render, no loading
  state. Everything else (detail screens, forms, stacked calendars) mounts
  fresh exactly as before.

  Contract for a kept screen (Vue calls onActivated on mount too):
    - revalidate in onActivated (skip the first call -- onMounted loaded);
    - pause timers/polls in onDeactivated, resume in onActivated;
    - its teleported header leaves the island with it (Vue moves teleported
      children into the KeepAlive storage on deactivation) -- one header in
      the island at a time.
  Kept per PATH: the stacked calendars share CalendarView with the tab but
  are different paths, so they never reuse (or clobber) the tab's instance.
-->

<template>
  <RouterView v-slot="{ Component, route: current }">
    <KeepAlive :max="max">
      <component :is="Component" v-if="Component && isKept(current.path)" :key="current.path" />
    </KeepAlive>
    <component :is="Component" v-if="Component && !isKept(current.path)" />
  </RouterView>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'

const props = withDefaults(
  defineProps<{
    /** Paths whose screens are kept alive (the dock's tab roots). */
    keep: readonly string[]
    /** Cache cap: the least recently used kept screen is dropped past it. */
    max?: number
  }>(),
  { max: 4 },
)

function isKept(path: string): boolean {
  return props.keep.includes(path)
}
</script>
