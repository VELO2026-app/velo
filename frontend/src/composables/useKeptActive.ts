// =============================================================================
// VELO Frontend -- useKeptActive: is this screen on stage (KeepAlive-aware)
// =============================================================================
// A tab root kept alive by TabRouterView is moved off-stage on deactivation,
// but Vue leaves its <Teleport> children where they were teleported to -- a
// kept screen's header would stay in MobileLayout's island next to the new
// screen's. A teleporting component binds `:disabled="!active"` so its
// content goes home (into the detached screen) while off-stage and comes
// back on activation -- moved, not remounted, so its state survives.
// Outside a KeepAlive the hooks never fire and this stays true.

import { onActivated, onDeactivated, readonly, ref, type Ref } from 'vue'

export function useKeptActive(): Readonly<Ref<boolean>> {
  const active = ref(true)
  onActivated(() => {
    active.value = true
  })
  onDeactivated(() => {
    active.value = false
  })
  return readonly(active)
}
