<!--
  VELO Frontend -- ConsoleScreen (FE-262)

  The one route component of every /console screen. It picks the screen by
  the route name from SCREENS and loads it on first use. The router's table
  (routes/console.ts) sits in the start-up chunk; a lazy import there costs
  every screen a preload list in that chunk, and the bundle budget would
  grow with each module. Here the loaders live in this lazy chunk instead, so
  a new screen is one line below and nothing at start-up.

  A route with no screen here (a module that has not moved yet) shows
  ConsolePlaceholderView.
-->

<template>
  <component :is="screen" />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from 'vue'
import { useRoute } from 'vue-router'

type Loader = () => Promise<Component>

/** Screen loaders by route name (console-<module>[-<screen>]). */
const SCREENS: Record<string, Loader> = {
  'console-practices': () => import('@/views/console/ConsolePracticesView.vue'),
  'console-practices-detail': () => import('@/views/console/ConsolePracticeDetailView.vue'),
  'console-catalog': () => import('@/views/console/ConsoleCatalogView.vue'),
}

const placeholder: Loader = () => import('@/views/console/ConsolePlaceholderView.vue')

// One async component per loader, so returning to a screen reuses it.
const cache = new Map<Loader, Component>()
function asyncScreen(loader: Loader): Component {
  let found = cache.get(loader)
  if (!found) {
    found = defineAsyncComponent(loader)
    cache.set(loader, found)
  }
  return found
}

const route = useRoute()
const screen = computed(() => asyncScreen(SCREENS[String(route.name)] ?? placeholder))
</script>
