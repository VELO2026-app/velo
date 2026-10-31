// =============================================================================
// VELO Frontend -- dev-only render log (off by default)
// =============================================================================
// Shows what actually re-renders on the way to (and on) the first screen:
// every mount/update of the layout-level components, stamped with the time
// since page start, plus each route change, then a summary table at 6 s.
//
// Dev builds only (import.meta.env.DEV -- tree-shaken from production), and
// only when the flag is set in the WebView's storage:
//   localStorage.setItem('velo:debug-renders', '1')   // then reload
//   localStorage.removeItem('velo:debug-renders')      // off again
// Output: the console ([velo:render] lines, on the warn channel -- the only
// one the lint allows besides error, and visible at the default level) --
// in Telegram iOS via Safari Web Inspector (Develop -> the device -> the
// Mini App's page).
// =============================================================================

import type { App, ComponentPublicInstance } from 'vue'
import type { Router } from 'vue-router'

export const RENDER_DEBUG_FLAG = 'velo:debug-renders'

/** Components worth logging: screens, shells, layout, loading/motion blocks. */
const WATCHED =
  /(View|Shell|Layout|TabBar|TabRouterView|Header|LoadingSwap|StatCard|Banner|AppFrame)$/

const SUMMARY_AT_MS = 6000

export function renderDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return localStorage.getItem(RENDER_DEBUG_FLAG) === '1'
  } catch {
    return false
  }
}

function nameOf(vm: ComponentPublicInstance): string {
  const options = vm.$options as { name?: string; __name?: string }
  return options.name ?? options.__name ?? ''
}

export function installRenderDebug(app: App, router: Router): void {
  if (!renderDebugEnabled()) return
  const counts = new Map<string, { mount: number; update: number }>()
  const stamp = (): string => `+${Math.round(performance.now())}ms`
  const note = (kind: 'mount' | 'update', vm: ComponentPublicInstance): void => {
    const name = nameOf(vm)
    if (!WATCHED.test(name)) return
    const row = counts.get(name) ?? { mount: 0, update: 0 }
    row[kind] += 1
    counts.set(name, row)
    console.warn(`[velo:render] ${stamp()} ${kind} ${name} #${row[kind]}`)
  }
  app.mixin({
    mounted(this: ComponentPublicInstance) {
      note('mount', this)
    },
    updated(this: ComponentPublicInstance) {
      note('update', this)
    },
  })
  router.afterEach((to, from) => {
    console.warn(`[velo:render] ${stamp()} route ${from.fullPath} -> ${to.fullPath}`)
  })
  setTimeout(() => {
    console.warn(`[velo:render] summary at ${stamp()}`)
    console.warn(JSON.stringify(Object.fromEntries(counts), null, 2))
  }, SUMMARY_AT_MS)
  console.warn(`[velo:render] ${stamp()} render log on (${RENDER_DEBUG_FLAG})`)
}
