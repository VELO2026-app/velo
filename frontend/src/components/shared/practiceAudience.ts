/**
 * A school the master may target: id + display name only (from
 * GET /curator-groups/mine filtered to relation curator|master upstream).
 * Lives in a .ts module, NOT in PracticeAudiencePicker.vue: types exported
 * from .vue SFCs are invisible to tooling without the vue language plugin
 * (type-aware eslint resolves them as any).
 */
export interface AudienceSchoolOption {
  id: string
  name: string
}
