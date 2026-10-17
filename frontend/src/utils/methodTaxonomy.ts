// =============================================================================
// VELO Frontend -- Method taxonomy seed/parse helper (batch L, FOUNDATION-2)
// =============================================================================
//
// Converts between the STORED flat `methods: string[]` (the «Направление — Вид»
// vocabulary the master apply-wizard emits) and the two-level picker's
// selection state (MethodTaxonomyPicker / MasterApplyView). Single source for
// both the flatten (selection -> string[]) and the seed/parse (string[] ->
// selection) sides, so the create wizard, the edit-profile picker and the
// pending-request display all round-trip through the SAME logic.
//
// DECISION Q3 = А (SURFACE-UNMATCHED, operator-reversed 2026-07-13, PROMPT
// №391 — was Q3=В DROP-UNMATCHED, PROMPT №349): any stored string that does
// NOT map to a known direction (or direction + style) is now SURFACED as the
// custom variant instead of dropped. The original DROP-UNMATCHED rationale
// ("prod is still test-grade with no real masters, zero real data loss") no
// longer held once the operator started actually using «Свой вариант» —
// submitted custom methods were being saved correctly by the backend but
// silently vanishing from every display (pending-request card AND the live
// «Методы» box after admin approval), which read as data loss even though
// none had actually occurred server-side.
//
// customText carries the surfaced value(s). The picker UI only ever edits
// ONE custom string at a time (a single "Свой вариант" toggle + text input),
// so flattenMethods only ever emits 0 or 1 unmatched entry in normal use —
// but parseMethods defensively handles the (should-not-happen) case of
// multiple unmatched strings by joining them with ", " rather than dropping
// all but one, so no text is ever lost even from unexpected/legacy data.
// Round-trip for MATCHED strings remains lossless (set-preserving; order
// normalises to the taxonomy encounter order); round-trip for the custom
// variant is lossless for the single-string case and text-preserving (not
// structure-preserving) for the multi-string edge case.
//
// The flatten side is byte-identical to the wizard's previous inline
// `allMethods` (same directionLabel map, same STYLE_LABEL, same « — »
// separator = space + U+2014 em dash + space, same custom-variant handling).
// =============================================================================

import { ref, shallowRef } from 'vue'
import type { PracticeDirection } from '@/api/types'
import i18n from '@/locales'
// Storage-canon seed: the SERVER catalog's labels are the canon; the ru seed
// catalogs cover a cold cache (the historic storage vocabulary).
import taxonomySeed from '@/locales/ru/taxonomy.json'
import practiceSeed from '@/locales/ru/practice.json'
import {
  DIRECTION_OPTIONS,
  stylesForDirection,
  hasStyleLabel,
  styleLabel,
} from '@/utils/practiceOptions'
import { getActiveTaxonomy, type TaxonomyListResponse } from '@/api/taxonomy'

// tz-i18n: the hardcoded labels above are LIVE getters (active locale), so
// this module splits LABEL by purpose:
//   display  -- directionLabel/resolveStyleLabel: active locale, hardcoded
//               keys first, server catalog second, raw value last;
//   canonical-- canonicalDirectionLabel/canonicalStyleLabel: the STORAGE
//               canon for flattenMethods («Направление — Вид» keeps composing
//               from the server catalog's labels, or the ru seed when the
//               cache is cold) -- a non-ru UI never forks the stored
//               vocabulary.
const ruSeed = {
  display: {
    direction:
      (taxonomySeed as unknown as { display?: { direction?: Record<string, string> } }).display
        ?.direction ?? {},
  },
  practice: {
    styles:
      (practiceSeed as unknown as { practice?: { styles?: Record<string, string> } }).practice
        ?.styles ?? {},
  },
}

/** The two-level picker's selection state. Mirrors the fields the wizard held
 *  inline (selectedDirections / selectedStyles / otherMethod*). */
export interface MethodSelection {
  directions: PracticeDirection[]
  /** direction value -> chosen style values (only for directions with styles). */
  styles: Record<string, string[]>
  customEnabled: boolean
  customText: string
  /** FE-89: the unmatched labels ONE PER METHOD -- the array customText was
   *  built from. Admin approval must scope/promote them as separate
   *  directions; the joined customText as a single label is what glued a
   *  master's second own method into the first one. */
  custom: string[]
}

/** « — » = space + U+2014 (em dash) + space. MUST match the wizard's flatten
 *  byte-for-byte so the stored payload is unchanged. */
const SEP = ' — '

// -- R5-stage-4 catalog cache (bug 2 fix, PROMPT №405; made reactive PROMPT
// №503 commit 1) -------------------------------------------------------------
//
// parseMethods/flattenMethods matched ONLY the hardcoded maps above -- a
// value auto-promoted into the DB catalog (admin approves a master's «Свой
// вариант» submission with "добавить в каталог") was NEVER recognized as
// matched, so it stayed rendered as unmatched/custom forever even after
// promotion (MethodTaxonomyPicker.vue's own header comment predicted exactly
// this divergence). Lazy module-level cache, consulted IN ADDITION TO the
// hardcoded maps above, never replacing them -- on fetch failure the cache
// stays as its last good state (null on first failure) and matching falls
// back to the hardcoded maps only, same offline/error contract api/taxonomy.ts
// documents for its own consumers.
//
// shallowRef, not plain `let` (PROMPT №503): the bug-2/bug-5 fixes closed
// "which screens remember to prime()" but left every consumer that resolves
// through these maps invisible to Vue's dependency tracking -- a computed()
// built on parseMethods/flattenMethods/directionLabel never re-ran just
// because the cache warmed later, so a value parsed cold (before prime()
// resolved) stayed cold for the rest of the session. Reading `.value` inside
// a computed's getter registers it as a normal reactive dependency, same as
// any other ref, regardless of which module declared it.
const catalogDirectionValueByLabel = shallowRef<Record<string, string> | null>(null)
const catalogDirectionLabelByValue = shallowRef<Record<string, string> | null>(null)
const catalogStyleValueByLabel = shallowRef<Record<string, Record<string, string>> | null>(null)
// Style value -> label, per direction (reverse of catalogStyleValueByLabel).
// Added for bug 5 leak 2 (PROMPT №408): flattenMethods' style branch only ever
// consulted the hardcoded STYLE_LABEL, so a catalog-only style (created in
// AdminCatalogView, or auto-promoted) flattened straight to its raw slug --
// the direction-side analogue of catalogDirectionLabelByValue below, which
// the bug 2 fix already added for directions but never mirrored for styles.
const catalogStyleLabelByValue = shallowRef<Record<string, Record<string, string>> | null>(null)

// Bumped once per applyTaxonomyCatalog() call (PROMPT №503 commit 2). The maps
// above being reactive fixes computed()-based consumers automatically, but a
// plain watch() keyed on its own source (e.g. MethodTaxonomyPicker's modelValue
// watcher) does NOT re-run just because a ref it happens to read inside the
// callback changed -- it only re-runs when ITS OWN watched source changes.
// Exposing an explicit version counter lets such a watcher add it as a second
// source, so it can force exactly one reparse per catalog update without
// weakening the anti-echo-loop guard that reparse would otherwise need.
export const taxonomyCatalogVersion = ref(0)

// Raw catalog response, alongside the derived label maps above. Populated by
// applyTaxonomyCatalog() too (whoever primes the label maps also primes this),
// so ANY screen that has already warmed the cache -- via this module's own
// ensureTaxonomyCatalog() below, or via MethodTaxonomyPicker/EditProfileView/
// admin screens calling applyTaxonomyCatalog()/primeMethodTaxonomyCatalog() --
// makes the full catalog available for building OPTION LISTS (not just label
// lookups) with zero extra network call (T2 stage 2, 2026-07-15: CreatePractice-
// View / EditPracticeView / CalendarFilterModal need the actual direction/style
// rows to render as selectable options, not just a value->label map).
let cachedCatalog: TaxonomyListResponse | null = null

/**
 * Populate the module-level catalog cache from an already-fetched taxonomy
 * response, without fetching it again. Pulled out of primeMethodTaxonomyCatalog
 * so a caller that already has the catalog (MethodTaxonomyPicker fetches its
 * own copy for the options it renders) can feed the SAME cache directly,
 * instead of every screen having to remember a separate prime call (bug 5
 * leak 1, PROMPT №408) -- see MethodTaxonomyPicker.vue's onMounted.
 */
export function applyTaxonomyCatalog(catalog: TaxonomyListResponse): void {
  const directionValueByLabel: Record<string, string> = {}
  const directionLabelByValue: Record<string, string> = {}
  const styleValueByLabel: Record<string, Record<string, string>> = {}
  const styleLabelByValue: Record<string, Record<string, string>> = {}
  for (const dir of catalog.directions) {
    directionValueByLabel[dir.label] = dir.value
    directionLabelByValue[dir.value] = dir.label
    const styles = dir.styles ?? []
    if (styles.length > 0) {
      styleValueByLabel[dir.value] = Object.fromEntries(styles.map((s) => [s.label, s.value]))
      styleLabelByValue[dir.value] = Object.fromEntries(styles.map((s) => [s.value, s.label]))
    }
  }
  catalogDirectionValueByLabel.value = directionValueByLabel
  catalogDirectionLabelByValue.value = directionLabelByValue
  catalogStyleValueByLabel.value = styleValueByLabel
  catalogStyleLabelByValue.value = styleLabelByValue
  cachedCatalog = catalog
  taxonomyCatalogVersion.value++
}

/**
 * Fetch the active taxonomy catalog and prime the module-level cache used by
 * parseMethods/flattenMethods/directionLabel. Call once per screen, on entry,
 * BEFORE the screen's own data becomes visible (e.g. alongside the screen's
 * primary data fetch in Promise.all) so the first parse already sees a warm
 * cache instead of flashing "custom" for a promoted value. Idempotent --
 * safe to call multiple times or from multiple screens (shared module state).
 */
export async function primeMethodTaxonomyCatalog(): Promise<void> {
  try {
    const catalog = await getActiveTaxonomy()
    applyTaxonomyCatalog(catalog)
  } catch {
    // Offline/error -- leave whatever the cache already held (null on a
    // first-ever failure); parseMethods/flattenMethods fall back to the
    // hardcoded maps only, same as before this fix existed.
  }
}

/**
 * Return the already-warm catalog with NO network call if any screen this
 * session already primed it (MethodTaxonomyPicker, EditProfileView, the admin
 * master screens, or a prior call to this same function) -- "close the flash,
 * not just shrink it" (operator, T2 stage 2). Otherwise fetches once, primes
 * the shared cache (so later callers/screens ride it too), and returns it.
 * Never throws: a failed fetch returns null, same offline/error contract as
 * primeMethodTaxonomyCatalog() -- callers fall back to their own hardcoded
 * options.
 */
export async function ensureTaxonomyCatalog(): Promise<TaxonomyListResponse | null> {
  if (cachedCatalog) return cachedCatalog
  try {
    const catalog = await getActiveTaxonomy()
    applyTaxonomyCatalog(catalog)
    return catalog
  } catch {
    return null
  }
}

/** Direction label -> value: the server catalog FIRST (its labels are the
 *  stored canon -- a non-ru UI parses stored ru strings through it), then the
 *  live hardcoded labels (so a same-locale round-trip works with a cold
 *  cache). A catalog-only value is not a member of the closed
 *  PracticeDirection union -- the cast mirrors the SAME tolerance
 *  MethodTaxonomyPicker.vue's catalog-first options list already applies. */
function resolveDirectionValue(label: string): PracticeDirection | undefined {
  const viaCatalog = catalogDirectionValueByLabel.value?.[label] as PracticeDirection | undefined
  if (viaCatalog) return viaCatalog
  return DIRECTION_OPTIONS.find((o) => o.label === label)?.value
}

/** Style label -> value under a resolved direction: catalog first, then the
 *  live hardcoded labels (same order rationale as resolveDirectionValue). */
function resolveStyleValue(dirValue: PracticeDirection, label: string): string | undefined {
  const viaCatalog = catalogStyleValueByLabel.value?.[dirValue]?.[label]
  if (viaCatalog) return viaCatalog
  return stylesForDirection(dirValue).find((o) => o.label === label)?.value
}

/** Style value -> label under a direction, for DISPLAY: the hardcoded key
 *  first (live locale), the server catalog second, the raw value last.
 *  Exported (T21-10, PROMPT №546): AdminMastersView's collapsed master card
 *  had no catalog-aware style helper available and hand-rolled a
 *  hardcoded-only version (STYLE_LABEL[st] ?? st) -- a catalog-only style
 *  (e.g. under a promoted custom direction) fell through to its raw slug,
 *  unlike directionLabel (already exported) which the same card uses
 *  correctly for the direction half of each chip. */
export function resolveStyleLabel(dirValue: string, styleValue: string): string {
  if (hasStyleLabel(styleValue)) return styleLabel(styleValue)
  return catalogStyleLabelByValue.value?.[dirValue]?.[styleValue] ?? styleValue
}

/** direction value -> label for DISPLAY: hardcoded key (live locale) first,
 *  server catalog second, raw value last. */
export function directionLabel(dir: string): string {
  if (i18n.global.te(`display.direction.${dir}`, 'ru')) {
    return i18n.global.t(`display.direction.${dir}`)
  }
  return catalogDirectionLabelByValue.value?.[dir] ?? dir
}

/** direction value -> label for STORAGE (flattenMethods): the server
 *  catalog's label is the canon, the ru seed covers a cold cache (the
 *  historic storage vocabulary), the raw value is the last resort. */
function canonicalDirectionLabel(dir: string): string {
  return catalogDirectionLabelByValue.value?.[dir] ?? ruSeed.display?.direction?.[dir] ?? dir
}

/** style value -> label for STORAGE under a direction (same canon chain). */
function canonicalStyleLabel(dirValue: string, styleValue: string): string {
  return (
    catalogStyleLabelByValue.value?.[dirValue]?.[styleValue] ??
    ruSeed.practice?.styles?.[styleValue] ??
    styleValue
  )
}

/**
 * Flatten a selection into the stored `methods: string[]`. A direction with
 * chosen styles emits «Направление — Вид» per style; a direction with no chosen
 * style emits «Направление»; the custom variant is emitted verbatim (trimmed).
 * Byte-identical to the wizard's previous inline `allMethods`.
 */
export function flattenMethods(sel: MethodSelection): string[] {
  const result: string[] = []
  for (const dir of sel.directions) {
    const label = canonicalDirectionLabel(dir)
    const styles = sel.styles[dir] ?? []
    if (styles.length > 0) {
      for (const st of styles) result.push(`${label}${SEP}${canonicalStyleLabel(dir, st)}`)
    } else {
      result.push(label)
    }
  }
  if (sel.customEnabled && sel.customText.trim()) {
    result.push(sel.customText.trim())
  }
  return result
}

/**
 * Parse a stored `methods: string[]` back into a selection (SURFACE-UNMATCHED,
 * Q3=А, PROMPT №391 — was DROP-UNMATCHED, Q3=В, PROMPT №349). An entry with the
 * « — » separator must match BOTH a known direction and a known style under
 * it to be treated as a direction+style pair; a bare entry must match a known
 * direction label. Anything else (including a « — » entry where either half
 * doesn't match) is surfaced verbatim as the custom variant instead of being
 * dropped — see the module header for why, and for how multiple unmatched
 * strings are handled (joined, not truncated to one).
 */
export function parseMethods(methods: string[]): MethodSelection {
  const directions: PracticeDirection[] = []
  const styles: Record<string, string[]> = {}
  const unmatched: string[] = []

  const addDirection = (d: PracticeDirection): void => {
    if (!directions.includes(d)) directions.push(d)
  }

  for (const raw of methods) {
    const s = raw.trim()
    if (!s) continue

    const sepIdx = s.indexOf(SEP)
    if (sepIdx !== -1) {
      // «Направление — Вид»: both halves must map to the taxonomy.
      const dirLabel = s.slice(0, sepIdx)
      const styleLabel = s.slice(sepIdx + SEP.length)
      const dirValue = resolveDirectionValue(dirLabel)
      const styleValue = dirValue ? resolveStyleValue(dirValue, styleLabel) : undefined
      if (!dirValue || !styleValue) {
        unmatched.push(s)
        continue
      }
      addDirection(dirValue)
      const list = styles[dirValue] ?? (styles[dirValue] = [])
      if (!list.includes(styleValue)) list.push(styleValue)
    } else {
      // Bare «Направление» (no style) -- or, if it doesn't match, custom text.
      const dirValue = resolveDirectionValue(s)
      if (!dirValue) {
        unmatched.push(s)
        continue
      }
      addDirection(dirValue)
    }
  }

  return {
    directions,
    styles,
    customEnabled: unmatched.length > 0,
    customText: unmatched.join(', '),
    custom: [...unmatched],
  }
}
