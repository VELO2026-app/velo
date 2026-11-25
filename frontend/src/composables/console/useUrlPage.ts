// =============================================================================
// VELO Frontend -- the page of a console table, in the URL
// =============================================================================
//
// The page rides `?page=`, so a reload and the back button land on it. A value
// that is not a positive whole number is page 1, and page 1 leaves no `page`
// in the URL.
// =============================================================================

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/** The page (1-based) in `?page=`; anything that is not a positive whole number is page 1. */
export function useUrlPage() {
  const route = useRoute()
  const router = useRouter()
  const page = computed<number>(() => {
    const n = Number(route.query.page)
    return Number.isInteger(n) && n >= 1 ? n : 1
  })
  return {
    page,
    /** Go to a page; page 1 leaves no `page` in the URL. */
    setPage: (next: number): void => {
      void router.replace({ query: { ...route.query, page: next > 1 ? String(next) : undefined } })
    },
  }
}
