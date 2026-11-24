// =============================================================================
// VELO Frontend -- the machine slug of a new catalog item (FE-262)
// =============================================================================
//
// POST /admin/taxonomy/directions and .../styles want a `value`: lowercase,
// a letter first, then letters, digits and underscores (2-50 characters).
// A label in Cyrillic has no natural slug and no screen shows `value` (they
// show the label), so the console makes a random one: `custom_` + 8 base-36
// characters.
// =============================================================================

/** A fresh slug for a new direction or style, valid for the admin taxonomy API. */
export function newTaxonomySlug(): string {
  return `custom_${Math.random().toString(36).slice(2, 10)}`
}
