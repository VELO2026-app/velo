// =============================================================================
// VELO Frontend -- the PATCH body of one master profile field (FE-262)
// =============================================================================
//
// The web master card edits one field at a time and sends only that field
// (PATCH /admin/masters/{id}/profile applies only the keys it gets). This is
// the pure half of the editor: the drafts in, the body or the reason out.
//
// DEBT (FE-272): a copy of buildPatch and ProfileField in AdminMasterReviewView,
// kept until the mobile /admin is removed; then this is the only one.
// =============================================================================

import type { AdminMasterProfileUpdate } from '@/api/admin'

/** A profile field with its own editor. */
export type ProfileField =
  | 'display_name'
  | 'account_name'
  | 'bio'
  | 'email'
  | 'phone'
  | 'experience_years'
  | 'languages'
  | 'certifications'

/** What the open editor holds. */
export interface ProfileDrafts {
  /** display_name, bio, email, phone, experience_years. */
  text: string
  /** Account first name. */
  first: string
  /** Account last name. */
  last: string
  languages: readonly string[]
  certifications: readonly string[]
}

/** Why a draft cannot be sent (the screen turns it into text). */
export type PatchProblem = 'displayNameRequired' | 'experienceRange'

/**
 * Build the PATCH body of one field from its drafts.
 *
 * @returns The body, or the reason the draft is not valid
 */
export function buildProfilePatch(
  field: ProfileField,
  drafts: ProfileDrafts,
): { patch: AdminMasterProfileUpdate } | { problem: PatchProblem } {
  const text = drafts.text.trim()
  switch (field) {
    case 'display_name':
      return text ? { patch: { display_name: text } } : { problem: 'displayNameRequired' }
    case 'bio':
      return { patch: { bio: text || null } }
    case 'email':
      return { patch: { email: text || null } }
    case 'phone':
      return { patch: { phone: text || null } }
    case 'experience_years': {
      const n = Number(drafts.text)
      return Number.isInteger(n) && n >= 0 && n <= 50
        ? { patch: { experience_years: n } }
        : { problem: 'experienceRange' }
    }
    case 'account_name':
      return {
        patch: {
          first_name: drafts.first.trim() || null,
          last_name: drafts.last.trim() || null,
        },
      }
    case 'languages':
      return { patch: { languages: [...drafts.languages] } }
    case 'certifications':
      return { patch: { certifications: [...drafts.certifications] } }
  }
}
