// =============================================================================
// VELO Frontend -- User onboarding goals (FE-101)
// =============================================================================
//
// The ordered catalog of the goal screen («К чему бы вы хотели прийти?»).
// Slugs are the wire format the backend stores in credentials.goals and
// validates against its own USER_GOAL_OPTIONS membership set
// (backend/app/modules/users/schemas.py) -- the labels live in the locale
// catalogs (auth.onboarding.goals.options.*), never here. The order below is
// the operator mockup's order (2026-10-19) and is UI copy: the backend set
// is unordered on purpose, so this list may be reordered without a wire
// change. Adding a value means changing BOTH sides plus the catalogs.
//
// GOAL_CUSTOM is not a goal of its own -- it marks the «Свой вариант» pick
// whose free text travels in credentials.goals_custom.
// =============================================================================

export const GOAL_CUSTOM = 'custom'

export const USER_GOAL_OPTIONS: readonly string[] = [
  'less_anxiety',
  'better_sleep',
  'more_energy',
  'calm_mind',
  'self_understanding',
  'curious_to_try',
  GOAL_CUSTOM,
] as const
