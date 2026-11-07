// =============================================================================
// @velo/ui -- the i18n seam (FE-118, tz-ui-package.md §4 P3, decision 2)
// =============================================================================
//
// The kit renders a handful of catalog strings (aria labels, day names, the
// chart empty state), but the DICTIONARY stays in the host application:
// the ui.* catalog has ~98 uses outside components/ui, so the package takes
// vue-i18n in neither dependencies nor peerDependencies. The host injects
// its translator once at boot via configureUi({ t }); components keep the
// same key calls they made on the host's '@/locales' before the migration.
//
// Contract:
//   - UI_I18N_KEYS is the complete registry: every 'ui.*' key a kit
//     component may ask the host for. The app's key-audit gate fails when
//     one of them stops resolving in ANY shipped locale (ru/en/uk) --
//     locale parity for the kit is a hard gate, unlike the app catalog's
//     report-only parity.
//   - 8 static keys + the ui.dayFull / ui.dayShort families (day codes are
//     canonical, Mon-first). cancel/confirm/close sit in the registry ahead
//     of their consumers (VConfirmDialog/VModal land in batch F, P6) so
//     that batch changes no catalog entry; menuAria/noData are the P3
//     registry alignments (VMenu/VBarChart used to live on
//     shared.components.menuAria / common.noData).
//   - Until configureUi runs, t returns the raw key and warns once per key
//     in dev -- a host that forgot the wiring fails loudly on the first
//     render instead of shipping raw keys silently.
// =============================================================================

/**
 * Every 'ui.*' message key a kit component may request from the host.
 * The array IS the registry the app's key-audit gate reads from this
 * source and resolves against all three locales -- keys are listed as
 * plain literals (no map/compose over codes) so the audit extraction and
 * the UiMessageKey union stay trivially in sync.
 */
export const UI_I18N_KEYS = [
  // -- static keys (8) --
  'ui.cancel', // VConfirmDialog (batch F, P6)
  'ui.close', // VModal (batch F, P6)
  'ui.collapse', // VAccordion (P3)
  'ui.confirm', // VConfirmDialog (batch F, P6)
  'ui.expand', // VAccordion (P3)
  'ui.menuAria', // VMenu: registry aligned in P3, the component lands in P6
  'ui.noData', // VBarChart (P3; aligned from common.noData)
  'ui.weekdays', // VDayPicker (P3)
  // -- day-name families: ui.dayFull.<code> / ui.dayShort.<code>, Mon-first --
  'ui.dayFull.mon',
  'ui.dayFull.tue',
  'ui.dayFull.wed',
  'ui.dayFull.thu',
  'ui.dayFull.fri',
  'ui.dayFull.sat',
  'ui.dayFull.sun',
  'ui.dayShort.mon',
  'ui.dayShort.tue',
  'ui.dayShort.wed',
  'ui.dayShort.thu',
  'ui.dayShort.fri',
  'ui.dayShort.sat',
  'ui.dayShort.sun',
] as const

/** A key from the registry above -- the narrow input type of the kit's t. */
export type UiMessageKey = (typeof UI_I18N_KEYS)[number]

/**
 * What the host hands over. vue-i18n's composer t is structurally this for
 * single-key calls; the host's own t keeps its wider signature, only the
 * kit-facing call sites are narrowed to UiMessageKey.
 */
export type UiTranslator = (key: string) => string

/** Options of the one-time host wiring. */
export interface ConfigureUiOptions {
  /**
   * The host translator. It must read its own live locale on every call
   * (the project composer does), so a locale switch re-renders the kit
   * exactly like it re-renders the host.
   */
  t: UiTranslator
}

let translator: UiTranslator | null = null
const warnedKeys = new Set<string>()

/**
 * Host wiring -- call once at boot, before the first kit component renders
 * (the app's UI barrel does it at its own module init, so the runtime and
 * every app test are wired with zero coordination; the Storybook preview
 * and the kit component tests each inject their own dictionary). Calling
 * it again swaps the translator, which only tests do.
 */
export function configureUi(options: ConfigureUiOptions): void {
  translator = options.t
}

/**
 * The kit-internal translator. Components import { t } from this module
 * and their key arguments are typed as UiMessageKey: a key outside the
 * registry is a compile error here, not a raw key shipped to users. The
 * day families stay dynamic -- template-literal inference types
 * `ui.dayFull.${d}` onto the union when d is the day-code literal union.
 */
export function t(key: UiMessageKey): string {
  if (!translator) {
    if (import.meta.env.DEV && !warnedKeys.has(key)) {
      warnedKeys.add(key)
      console.warn(
        `[@velo/ui] translator not configured: key "${key}" renders raw. ` +
          'Call configureUi with the host translator at app boot (FE-118).',
      )
    }
    return key
  }
  return translator(key)
}
