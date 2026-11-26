// =============================================================================
// VELO Frontend -- the ru taxonomy seed (the storage canon of the labels)
// =============================================================================
//
// The ru catalogs hold the historic storage vocabulary of the method
// taxonomy: the labels the server catalog and the stored "Direction — Style"
// strings are made of. Two readers need it as DATA, not through t():
//
//   methodTaxonomy.ts  -- composes and parses the stored strings;
//   practiceOptions.ts -- finds the key of a catalog-only direction by its
//                         ru label (directionDisplayLabel).
//
// ?raw + JSON.parse: VueI18nPlugin precompiles every plain locales/**/*.json
// import into message ASTs; these seeds are DATA, so their leaves must stay
// plain strings.
// =============================================================================

import taxonomySeedRaw from '@/locales/ru/taxonomy.json?raw'
import practiceSeedRaw from '@/locales/ru/practice.json?raw'

const taxonomySeed = JSON.parse(taxonomySeedRaw) as unknown as {
  display?: { direction?: Record<string, string> }
}
const practiceSeed = JSON.parse(practiceSeedRaw) as unknown as {
  practice?: { styles?: Record<string, string> }
}

/** `direction value -> ru label` (`display.direction.*`). */
export const ruDirectionSeed: Readonly<Record<string, string>> =
  taxonomySeed.display?.direction ?? {}

/** `style value -> ru label` (`practice.styles.*`). */
export const ruStyleSeed: Readonly<Record<string, string>> = practiceSeed.practice?.styles ?? {}

/** `ru label -> direction value`, a Map (a stored string like "constructor"
 *  must not find an inherited key). Built once: the seed is bundled data, so no
 *  locale switch, instance overlay or catalog apply can make it stale. */
export const ruDirectionValueByLabel: ReadonlyMap<string, string> = new Map(
  Object.entries(ruDirectionSeed).map(([value, label]) => [label, value]),
)

/** `ru label -> style value` (same shape as the directions above). */
export const ruStyleValueByLabel: ReadonlyMap<string, string> = new Map(
  Object.entries(ruStyleSeed).map(([value, label]) => [label, value]),
)
