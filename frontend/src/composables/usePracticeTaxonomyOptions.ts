// =============================================================================
// VELO Frontend -- usePracticeTaxonomyOptions (FE-157 stage 4, track 4A)
// =============================================================================
//
// The direction / style pickers of the practice form (create and edit),
// filtered to the CONFIRMED methods of the practice's master. The backend
// validates direction / style against that master's confirmed set
// (practices/service.py _assert_master_confirmed_taxonomy), so offering
// anything else only produces a late refusal on submit (PROMPT №546/№556).
// =============================================================================

import { computed, onMounted, ref, type ComputedRef } from 'vue'
import { useMasterProfile } from '@/composables/queries/master'
import {
  catalogDirectionOptions,
  catalogStylesForDirection,
  type DirectionOption,
  type StyleOption,
} from '@/utils/practiceOptions'
import { ensureTaxonomyCatalog, parseMethods, type MethodSelection } from '@/utils/methodTaxonomy'
import type { TaxonomyListResponse } from '@/api/taxonomy'
import type { PracticeDirection } from '@/api/types'

/** The pair of form fields the pickers drive. */
export interface TaxonomyFields {
  direction: string
  style: string
}

/**
 * Keep a direction / style pick only while the confirmed set still allows it.
 *
 * @remarks A style survives only under a surviving direction, and only when
 * confirmed for THAT direction. A direction confirmed without a style offers
 * no styles at all (the backend is equally strict).
 * @returns The pick with every refused half cleared to ''.
 * @example
 * ```ts
 * keepConfirmedPick({ directions: ['yoga'], styles: { yoga: ['hatha'] } }, 'yoga', 'vinyasa')
 * // -> { direction: 'yoga', style: '' }
 * ```
 */
export function keepConfirmedPick(
  confirmed: Pick<MethodSelection, 'directions' | 'styles'> | null,
  direction: string | null | undefined,
  style: string | null | undefined,
): TaxonomyFields {
  const directionOk =
    !!confirmed && !!direction && confirmed.directions.includes(direction as PracticeDirection)
  if (!directionOk) return { direction: '', style: '' }
  const styleOk = !!style && (confirmed.styles[direction] ?? []).includes(style)
  return { direction, style: styleOk ? style : '' }
}

/**
 * Direction / style options for the practice form, catalog-first and
 * filtered to the master's confirmed methods.
 *
 * @remarks Fails CLOSED: while the caller's profile has not loaded, or the
 * methods source is null (not loaded, or its load failed), both lists are
 * empty -- never the full catalogue; an unknown or empty confirmed set must
 * not read as "everything is allowed". In the normal flow masterStatusGuard
 * awaits the profile before either screen mounts, so this is a fallback.
 * Deliberately fed by confirmed methods only, never by a pending method
 * change request: an unapproved request must not unlock a direction early.
 * The taxonomy catalog is primed on mount through the shared cache
 * (ensureTaxonomyCatalog: no request when another screen warmed it).
 * @param form - The form whose `style` is reset when the direction changes.
 * @param methods - The confirmed method labels of the practice's master.
 */
export function usePracticeTaxonomyOptions(
  form: TaxonomyFields,
  methods: () => string[] | null | undefined,
): {
  confirmedMethods: ComputedRef<MethodSelection | null>
  directionOptions: ComputedRef<DirectionOption[]>
  styleOptions: ComputedRef<StyleOption[]>
  onDirectionChange: () => void
} {
  // Read-only: the screen loads the profile (or masterStatusGuard did).
  const { loaded: profileLoaded } = useMasterProfile(false)
  const catalog = ref<TaxonomyListResponse | null>(null)
  onMounted(() => {
    void ensureTaxonomyCatalog().then((c) => {
      catalog.value = c
    })
  })

  const confirmedMethods = computed(() => {
    const list = methods()
    return list ? parseMethods(list) : null
  })

  const directionOptions = computed(() => {
    const confirmed = profileLoaded.value ? confirmedMethods.value : null
    if (!confirmed) return []
    return catalogDirectionOptions(catalog.value).filter((opt) =>
      confirmed.directions.includes(opt.value),
    )
  })

  const styleOptions = computed(() => {
    const confirmed = profileLoaded.value ? confirmedMethods.value : null
    if (!confirmed) return []
    const allowed = confirmed.styles[form.direction] ?? []
    return catalogStylesForDirection(catalog.value, form.direction).filter((opt) =>
      allowed.includes(opt.value),
    )
  })

  /** The previous style is likely invalid for the new direction. */
  function onDirectionChange(): void {
    form.style = ''
  }

  return { confirmedMethods, directionOptions, styleOptions, onDirectionChange }
}
