// =============================================================================
// VELO Frontend -- Curator Groups API (schools, FE-22 / GT P3)
// =============================================================================
//
// Typed wrappers over api.get/post/patch/delete for the CURATOR GROUPS
// ("schools") endpoints. Unlike groups.ts (which hand-wrote its types as a
// stand-in before a regen existed), every shape here is ALREADY in
// generated.ts -- this file wraps URLs and request bodies only; all types
// come from @/api/types, per that file's own header rule.
//
// Three surfaces, one feature (tz-curator-groups.md 5.2-5.3):
//
// CURATOR (verified master, prefix /api/v1/masters/me/curator-groups):
//   GET    /                                     -- my schools + counts + transfer
//   POST   /                                     -- create {name, description?}
//   PATCH  /{id}                                 -- rename/redescribe
//   DELETE /{id}                                 -- delete (never blocked, I-11)
//   GET    /{id}/members                         -- roster (?kind&search&limit&offset)
//   DELETE /{id}/members/{user_id}               -- remove member (idempotent)
//   POST   /{id}/invites                         -- get-or-mint link {kind}
//   DELETE /{id}/invites/{kind}                  -- revoke that kind's link
//   POST   /{id}/transfer                        -- offer hand-over {to_user_id}
//   DELETE /{id}/transfer                        -- cancel offer
//   GET    /{id}/delete-preview                  -- advisory before deleting
//   GET    /{id}/members/{user_id}/remove-preview -- advisory before removing
//
// MEMBER / ANY USER (prefix /api/v1/curator-groups):
//   GET    /mine                                 -- my ACTIVE schools + relation
//   GET    /invites/{token}                      -- invite preview (refusal is
//                                                   DESCRIBED, not raised; 404
//                                                   covers unknown/revoked/
//                                                   frozen/deleted alike, P-08)
//   POST   /join                                 -- join {token}; revalidates
//   GET    /{id}                                 -- school page + viewer.relation
//   GET    /{id}/masters                         -- roster (curator first)
//   GET    /{id}/practices                       -- feed, same shape as /practices
//   GET    /{id}/leave-preview                   -- advisory before leaving
//   DELETE /{id}/membership                      -- leave (idempotent)
//   POST   /{id}/transfer/accept                 -- take over (page response)
//   POST   /{id}/transfer/decline                -- refuse (204 even if not yours)
//
// ADMIN:
//   GET    /api/v1/admin/curator-groups          -- ALL schools incl. frozen
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type {
  CreateCuratorGroupRequest,
  CuratorGroupDeletePreviewResponse,
  CuratorGroupInvitePreviewResponse,
  CuratorGroupInviteResponse,
  CuratorGroupLeavePreviewResponse,
  CuratorGroupListResponse,
  CuratorGroupMineResponse,
  CuratorGroupPageResponse,
  CuratorGroupRemovePreviewResponse,
  CuratorGroupResponse,
  CuratorGroupTransferRef,
  JoinCuratorGroupResponse,
  OfferCuratorGroupTransferRequest,
  PaginatedAdminCuratorGroupsResponse,
  PaginatedCuratorGroupMastersResponse,
  PaginatedCuratorGroupMembersResponse,
  PaginatedPracticesResponse,
  UpdateCuratorGroupRequest,
} from '@/api/types'

const CURATOR_BASE = '/api/v1/masters/me/curator-groups'
const MEMBER_BASE = '/api/v1/curator-groups'

/** Which flavour of member/invite a call is about. A local convenience alias
 *  for the generated `'master' | 'student'` literals (both request schemas and
 *  the invite path parameter use it) -- not a re-declared backend union. */
export type CuratorGroupMemberKind = 'master' | 'student'

// =============================================================================
// Curator surface (requires a verified master token)
// =============================================================================

/** GET /masters/me/curator-groups -- schools I curate, newest first. Empty
 *  list when I curate none. */
export function getCuratorGroups(): Promise<CuratorGroupListResponse> {
  return api.get<CuratorGroupListResponse>(CURATOR_BASE)
}

/** POST /masters/me/curator-groups -- create a school; this is also HOW a
 *  verified master becomes a curator (no grant, no flag -- owning the row IS
 *  the role). 409 curator_group_name_taken on a name this curator already
 *  uses; the same name under a different curator is fine (I-7).
 *
 *  `description` is omitted from the body when undefined/blank -- the caller
 *  trims; the backend normalizes '' to NULL on its own. */
export function createCuratorGroup(
  name: string,
  description?: string,
): Promise<CuratorGroupResponse> {
  const body: CreateCuratorGroupRequest = description ? { name, description } : { name }
  return api.post<CuratorGroupResponse>(CURATOR_BASE, body)
}

/** PATCH /masters/me/curator-groups/{id} -- rename and/or redescribe. 404 if
 *  not my group or gone.
 *
 *  `description` is a PARTIAL update with three states, and this wrapper maps
 *  them to the wire exactly (the backend reads exclude_unset):
 *    undefined -> key ABSENT -> leave the column alone
 *    null      -> key present, null -> write NULL (clear it)
 *    string    -> key present -> write it
 *  Passing `''` is not distinguished from null server-side; prefer null. */
export function updateCuratorGroup(
  id: string,
  name: string,
  description?: string | null,
): Promise<CuratorGroupResponse> {
  const body: UpdateCuratorGroupRequest =
    description === undefined ? { name } : { name, description }
  return api.patch<CuratorGroupResponse>(`${CURATOR_BASE}/${id}`, body)
}

/** DELETE /masters/me/curator-groups/{id} -- hard-delete with cascade over
 *  memberships, invites, a pending transfer and P5 target rows. NEVER blocked
 *  by other masters' practices: those go fail-closed instead (I-11) -- the
 *  delete-preview advisory is informational only. */
export function deleteCuratorGroup(id: string): Promise<void> {
  return api.delete(`${CURATOR_BASE}/${id}`)
}

/** Query params of GET /masters/me/curator-groups/{id}/members. All optional:
 *  omitting kind lists both masters and students. */
export interface CuratorGroupMembersQuery {
  kind?: CuratorGroupMemberKind
  search?: string
  limit?: number
  offset?: number
}

/** GET /masters/me/curator-groups/{id}/members -- the full roster as the
 *  curator sees it. A suspended master-member appears with is_visible=false
 *  ("in the shadow") rather than dropping out (I-4) -- only the roster and
 *  the page's masters_count know that predicate, so they cannot disagree. */
export function getCuratorGroupMembers(
  id: string,
  query: CuratorGroupMembersQuery = {},
): Promise<PaginatedCuratorGroupMembersResponse> {
  const qs = buildQuery({
    kind: query.kind,
    search: query.search,
    limit: query.limit,
    offset: query.offset,
  })
  return api.get<PaginatedCuratorGroupMembersResponse>(`${CURATOR_BASE}/${id}/members${qs}`)
}

/** DELETE /masters/me/curator-groups/{id}/members/{user_id} -- remove a member
 *  of either kind. Idempotent: a miss is still 204. 404 is only ever about
 *  the GROUP not being mine, never about the user. */
export function removeCuratorGroupMember(id: string, userId: string): Promise<void> {
  return api.delete(`${CURATOR_BASE}/${id}/members/${userId}`)
}

/** POST /masters/me/curator-groups/{id}/invites -- get-or-mint the school's
 *  reusable link for one kind. Repeat calls return the SAME url (the curator
 *  expects a shared link to keep working); rotation is revoke + create, on
 *  purpose. 503 bot_url_not_configured when the bot url is unset -- the
 *  caller must show the errorMessages phrase, never a made-up link. */
export function createCuratorGroupInvite(
  id: string,
  kind: CuratorGroupMemberKind,
): Promise<CuratorGroupInviteResponse> {
  return api.post<CuratorGroupInviteResponse>(`${CURATOR_BASE}/${id}/invites`, { kind })
}

/** DELETE /masters/me/curator-groups/{id}/invites/{kind} -- revoke ONE kind of
 *  link; the other kind keeps working. Idempotent. Afterwards the old token
 *  resolves nowhere: preview and join read the same row. */
export function revokeCuratorGroupInvite(id: string, kind: CuratorGroupMemberKind): Promise<void> {
  return api.delete(`${CURATOR_BASE}/${id}/invites/${kind}`)
}

/** POST /masters/me/curator-groups/{id}/transfer -- offer the school to one of
 *  its visible master members. 409 transfer_pending while an offer is open
 *  (a second never silently replaces the first -- cancel first); 404
 *  transfer_target_not_member for a student, a stranger, a suspended master
 *  or the curator themselves, indistinguishably. */
export function offerCuratorGroupTransfer(
  id: string,
  toUserId: string,
): Promise<CuratorGroupTransferRef> {
  const body: OfferCuratorGroupTransferRequest = { to_user_id: toUserId }
  return api.post<CuratorGroupTransferRef>(`${CURATOR_BASE}/${id}/transfer`, body)
}

/** DELETE /masters/me/curator-groups/{id}/transfer -- withdraw the pending
 *  offer. Idempotent: no offer is still 204. */
export function cancelCuratorGroupTransfer(id: string): Promise<void> {
  return api.delete(`${CURATOR_BASE}/${id}/transfer`)
}

/** GET /masters/me/curator-groups/{id}/delete-preview -- what deleting costs:
 *  who is in the school and how many upcoming practices (across EVERY master
 *  of the school, curator included) are aimed at it. Same counters the page
 *  reports, from the same helper -- the dialog and the page cannot disagree. */
export function getCuratorGroupDeletePreview(
  id: string,
): Promise<CuratorGroupDeletePreviewResponse> {
  return api.get<CuratorGroupDeletePreviewResponse>(`${CURATOR_BASE}/${id}/delete-preview`)
}

/** GET /masters/me/curator-groups/{id}/members/{user_id}/remove-preview -- the
 *  same advisory for one member. Zero -- not 404 -- for somebody who is not
 *  in the group at all: the removal itself is idempotent, so the advisory
 *  must not be stricter than the action it describes. */
export function getCuratorGroupRemovePreview(
  id: string,
  userId: string,
): Promise<CuratorGroupRemovePreviewResponse> {
  return api.get<CuratorGroupRemovePreviewResponse>(
    `${CURATOR_BASE}/${id}/members/${userId}/remove-preview`,
  )
}

// =============================================================================
// Member / any-user surface
// =============================================================================

/** GET /curator-groups/mine -- schools I belong to, curated first, then by
 *  join time. Only ACTIVE groups (I-6): one whose curator is currently
 *  suspended disappears and comes back on re-verification, no row written
 *  either way. Each row carries MY relation and transfer_offered (true only
 *  for the person being offered a school -- the curator's own pending offer
 *  reads false here on purpose). */
export function getMyCuratorGroups(): Promise<CuratorGroupMineResponse> {
  return api.get<CuratorGroupMineResponse>(`${MEMBER_BASE}/mine`)
}

/** GET /curator-groups/invites/{token} -- the card behind an invite link, and
 *  WHY joining is refused, if it is. The endpoint DESCRIBES refusals
 *  (can_join=false + reason) instead of raising them; the one exception is
 *  404, which deliberately covers unknown token, revoked token, inactive
 *  school and deleted school alike (P-08 -- a link must not reveal whether a
 *  school exists).
 *
 *  can_join answers "would joining CHANGE anything", not "are you allowed":
 *  a student member opening a MASTER link gets can_join=true with
 *  relation="student" -- they are already inside and the link still has an
 *  effect (the upgrade). Render the Join button active for that case. */
export function getCuratorGroupInvitePreview(
  token: string,
): Promise<CuratorGroupInvitePreviewResponse> {
  return api.get<CuratorGroupInvitePreviewResponse>(`${MEMBER_BASE}/invites/${token}`)
}

/** POST /curator-groups/join -- join by token. The preview is a hint and this
 *  is the gate: everything is revalidated, so a green preview can still end
 *  404/403/409 here -- handle those as real states, never as "impossible".
 *  already_member=true means "there WAS a row when this looked", nothing
 *  more: a student upgraded to master reports already_member=true with
 *  relation="master". */
export function joinCuratorGroup(token: string): Promise<JoinCuratorGroupResponse> {
  return api.post<JoinCuratorGroupResponse>(`${MEMBER_BASE}/join`, { token })
}

/** GET /curator-groups/{id} -- the school page. 404 unless I have a relation
 *  to it AND it is active: a school that does not exist, one whose curator is
 *  suspended, and one I simply do not belong to all answer identically.
 *  `transfer` is filled for exactly two people (the curator and the
 *  addressee); every other member sees null. */
export function getCuratorGroupPage(id: string): Promise<CuratorGroupPageResponse> {
  return api.get<CuratorGroupPageResponse>(`${MEMBER_BASE}/${id}`)
}

/** GET /curator-groups/{id}/masters -- the school's masters: the curator
 *  first (is_curator=true; they lead the roster without being a member row,
 *  so total == masters_count + 1 by construction), then visible members.
 *  Fields are a strict subset of MasterPublicResponse -- same isolation
 *  boundary as the public master page. */
export function getCuratorGroupMasters(
  id: string,
  limit = 20,
  offset = 0,
): Promise<PaginatedCuratorGroupMastersResponse> {
  const qs = buildQuery({ limit, offset })
  return api.get<PaginatedCuratorGroupMastersResponse>(`${MEMBER_BASE}/${id}/masters${qs}`)
}

/** GET /curator-groups/{id}/practices -- upcoming practices by the school's
 *  masters. The PUBLIC FEED narrowed to a set of masters, not a new query:
 *  is_booked/is_paid, the audience clause and the block clause all come from
 *  list_public_practices unchanged. A master who blocked this viewer
 *  contributes no practices even though they still appear in the roster --
 *  blocking hides practices, not people. */
export function getCuratorGroupPractices(
  id: string,
  limit = 20,
  offset = 0,
): Promise<PaginatedPracticesResponse> {
  const qs = buildQuery({ limit, offset })
  return api.get<PaginatedPracticesResponse>(`${MEMBER_BASE}/${id}/practices${qs}`)
}

/** GET /curator-groups/{id}/leave-preview -- how many of MY OWN upcoming
 *  practices target this school. A student always sees 0. On a FROZEN school
 *  this answers 404 while leave itself still works (I-5) -- treat that 404
 *  as "no advisory", never as an error, and never block the button on it. */
export function getCuratorGroupLeavePreview(id: string): Promise<CuratorGroupLeavePreviewResponse> {
  return api.get<CuratorGroupLeavePreviewResponse>(`${MEMBER_BASE}/${id}/leave-preview`)
}

/** DELETE /curator-groups/{id}/membership -- leave. Idempotent; 409
 *  curator_cannot_leave for the owner (their exit is a transfer or a delete).
 *  Deliberately NOT gated on the school being active: a member of a frozen
 *  school must still be able to walk out. */
export function leaveCuratorGroup(id: string): Promise<void> {
  return api.delete(`${MEMBER_BASE}/${id}/membership`)
}

/** POST /curator-groups/{id}/transfer/accept -- take over the school. One
 *  transaction: caller becomes curator, their member row disappears, the
 *  former curator GAINS a master member row (they stay a teacher of the
 *  school), the offer row is deleted, invite tokens are untouched. Returns
 *  the page AS THE NEW CURATOR (viewer.relation === 'curator') -- replace the
 *  caller's local state with it, no reload needed. 404 transfer_not_found
 *  covers "no offer"/"not addressed to you"/"inactive school" alike; 403
 *  master_required if no longer verified; 409 curator_group_name_taken if
 *  the caller already curates a school by this name. */
export function acceptCuratorGroupTransfer(id: string): Promise<CuratorGroupPageResponse> {
  return api.post<CuratorGroupPageResponse>(`${MEMBER_BASE}/${id}/transfer/accept`)
}

/** POST /curator-groups/{id}/transfer/decline -- refuse the offer. Idempotent,
 *  and 204 even when it was not yours: it changes nothing, so reporting
 *  success is honest and says nothing about whether an offer existed. */
export function declineCuratorGroupTransfer(id: string): Promise<void> {
  return api.post(`${MEMBER_BASE}/${id}/transfer/decline`)
}

// =============================================================================
// Admin surface (read-only -- the ONE moderation lever for schools is the
// existing master verification revoke, which freezes all of a curator's
// schools at once; there is intentionally no admin delete/edit here)
// =============================================================================

/** GET /admin/curator-groups -- EVERY school, including frozen ones (the only
 *  place in the system where an inactive school is visible at all: for its
 *  own members it is indistinguishable from a deleted one). is_active is a
 *  FIELD, not a filter, on purpose -- the admin is the person being asked
 *  "why has my school gone quiet". */
export function getAdminCuratorGroups(
  limit = 20,
  offset = 0,
): Promise<PaginatedAdminCuratorGroupsResponse> {
  const qs = buildQuery({ limit, offset })
  return api.get<PaginatedAdminCuratorGroupsResponse>(`/api/v1/admin/curator-groups${qs}`)
}
