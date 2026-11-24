// =============================================================================
// VELO Frontend -- the screens of the web console, by route name (FE-262)
// =============================================================================
//
// routes/console.ts is in the start-up chunk; a lazy import there per
// screen would put a preload list per screen in that chunk, and the bundle
// budget would grow with every module. That file imports only this module,
// once and lazily; the per-screen imports live here, in a lazy chunk. A
// record's component resolves through loadConsoleScreen, so the router
// still waits for the screen itself before it switches (the view
// transition, the first-screen splash and the chunk-error path stay as for
// any lazy route). A new screen: its record in routes/console.ts and its
// loader below.
// =============================================================================

import type { Component } from 'vue'
import type { ConsoleRouteName } from '@/utils/console/modules'

type Loader = () => Promise<{ default: Component }>

/** The screens that have replaced the placeholder. */
const SCREENS: Partial<Record<ConsoleRouteName, Loader>> = {
  'console-dashboard': () => import('@/views/console/ConsoleDashboardView.vue'),
  'console-analytics': () => import('@/views/console/ConsoleAnalyticsView.vue'),
  'console-mail': () => import('@/views/console/ConsoleMailView.vue'),
  'console-practices': () => import('@/views/console/ConsolePracticesView.vue'),
  'console-practices-detail': () => import('@/views/console/ConsolePracticeDetailView.vue'),
  'console-catalog': () => import('@/views/console/ConsoleCatalogView.vue'),
}

const placeholder: Loader = () => import('@/views/console/ConsolePlaceholderView.vue')

/**
 * The screen module of a console route, or the placeholder for a module
 * that has not moved yet.
 *
 * @param name - the route name
 */
export function loadConsoleScreen(name: ConsoleRouteName): Promise<{ default: Component }> {
  return (SCREENS[name] ?? placeholder)()
}
