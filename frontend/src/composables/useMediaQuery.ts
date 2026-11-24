// =============================================================================
// VELO Frontend -- a live media query (FE-262)
// =============================================================================

import { onScopeDispose, ref, type Ref } from 'vue'
import { host } from '@/platform/host'

/**
 * Whether the window matches a media query, kept live while the calling
 * scope exists. Without matchMedia (old WebViews, tests) it reads false.
 *
 * @param query - a CSS media query, e.g. `(min-width: 1024px)`
 */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  if (typeof host.matchMedia !== 'function') return ref(false)
  const list = host.matchMedia(query)
  const matches = ref(list.matches)
  const onChange = (event: MediaQueryListEvent): void => {
    matches.value = event.matches
  }
  list.addEventListener('change', onChange)
  onScopeDispose(() => list.removeEventListener('change', onChange))
  return matches
}
