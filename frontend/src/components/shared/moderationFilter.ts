/**
 * Moderation filter state for the admin reports screen. Lives in a .ts module,
 * NOT in ModerationFilterModal.vue: types exported from .vue SFCs are
 * invisible to tooling without the vue language plugin (type-aware eslint
 * resolves them as any).
 */
export interface ModerationFilter {
  categories: string[]
  priorities: string[]
  statuses: string[]
  date: string
}
