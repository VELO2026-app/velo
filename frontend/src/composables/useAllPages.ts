// =============================================================================
// VELO Frontend -- a screen's whole offset-paged list (FE-260)
// =============================================================================
//
// The master's students, needs-attention block and promo codes filter or
// count over a whole list, so they read it to its end (readAllPages). A new
// read drops the one before it, and leaving the screen drops the read in
// flight: its signal goes to the API wrapper.
// =============================================================================

import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue'
import { readAllPages, type OffsetPage } from '@/utils/readAllPages'

/** One page of the list, cancellable. */
export type PageReader<T> = (
  limit: number,
  offset: number,
  signal: AbortSignal,
) => Promise<OffsetPage<T>>

/** The state of a whole list on a screen. */
export interface AllPagesState<T> {
  /** The rows read so far; replaced when a read succeeds. */
  items: Ref<T[]>
  /** The API's count of the whole list. */
  total: Ref<number>
  /** Every row was read (false -- the cap stopped the read). */
  complete: Ref<boolean>
  /** A read is in flight. */
  loading: Ref<boolean>
  /** The last read failed (a dropped read is not a failure). */
  failed: Ref<boolean>
  /** Read the list (again). */
  load: () => Promise<void>
}

/**
 * The whole list behind `read`, read on demand.
 *
 * @param read - one page of the list, given the read's signal
 * @param startLoading - `loading` before the first read (a screen that
 *  mounts on its loader)
 */
export function useAllPages<T>(read: PageReader<T>, startLoading = false): AllPagesState<T> {
  const items = ref<T[]>([]) as Ref<T[]>
  const total = ref(0)
  const complete = ref(true)
  const loading = ref(startLoading)
  const failed = ref(false)
  const current = shallowRef<AbortController | null>(null)

  async function load(): Promise<void> {
    current.value?.abort()
    const controller = new AbortController()
    current.value = controller
    loading.value = true
    failed.value = false
    try {
      const all = await readAllPages<T>((limit, offset) => read(limit, offset, controller.signal))
      if (controller.signal.aborted) return
      items.value = all.items
      total.value = all.total
      complete.value = all.complete
    } catch {
      if (!controller.signal.aborted) failed.value = true
    } finally {
      if (current.value === controller) loading.value = false
    }
  }

  onBeforeUnmount(() => current.value?.abort())

  return { items, total, complete, loading, failed, load }
}
