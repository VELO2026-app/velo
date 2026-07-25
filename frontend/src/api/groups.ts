// =============================================================================
// VELO Frontend -- Master Groups API (P2, ПРОМТ №591)
// =============================================================================
//
// Typed wrappers over api.get/post/patch/put/delete for the master GROUPS
// endpoints, mirroring masters.ts. HAND-WRITTEN, not generated: the backend
// (P1, ПРОМТ №590) shipped these endpoints without a local server to
// regenerate generated.ts against, so the types below are a temporary
// stand-in for the real OpenAPI-derived ones. They reconcile automatically
// at the next `velo update` regen -- do NOT add these to api/types.ts by
// hand (that file's own header forbids it).
//
// Backend endpoints (masters/groups_router.py + students_router.py's tag/
// block/P3-addenda additions):
//   GET    /api/v1/masters/me/groups                          -- list
//   POST   /api/v1/masters/me/groups                          -- create custom
//   PATCH  /api/v1/masters/me/groups/{id}                     -- rename custom
//   DELETE /api/v1/masters/me/groups/{id}                     -- delete custom
//   GET    /api/v1/masters/me/groups/{id}/members             -- list members
//   POST   /api/v1/masters/me/groups/{id}/members             -- add member
//   DELETE /api/v1/masters/me/groups/{id}/members/{studentId} -- remove member
//   PUT    /api/v1/masters/me/students/{studentId}/tag        -- upsert/clear tag
//   POST   /api/v1/masters/me/students/{studentId}/block      -- block (P3)
//   DELETE /api/v1/masters/me/students/{studentId}/block      -- unblock (P3)
//   GET    /api/v1/masters/me/tags                            -- tag palette (P3)
//   GET    /api/v1/masters/me/students/{studentId}/groups     -- this student's groups (P3)
//
// {id} above is either a real group UUID or one of the two system slugs
// "students" / "deleted" (GET .../members only -- every mutation on a
// system slug is rejected server-side with 400).
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'

/** System group slugs -- never a real group id. */
export type GroupKind = 'students' | 'deleted' | 'custom'

export interface GroupListItem {
  /** A UUID string for a custom group, or the literal "students" / "deleted". */
  id: string
  kind: GroupKind
  name: string
  members_count: number
}

export interface GroupListResponse {
  items: GroupListItem[]
}

export interface GroupResponse {
  id: string
  name: string
  members_count: number
}

export interface GroupMemberItem {
  id: string
  name: string
  avatar_url: string | null
  /** This student's tag against the current master, null if never tagged. */
  tag: string | null
}

export interface PaginatedGroupMembersResponse {
  items: GroupMemberItem[]
  total: number
  limit: number
  offset: number
}

export interface StudentTagResponse {
  student_user_id: string
  tag: string | null
}

export interface BlockStudentResponse {
  student_user_id: string
  blocked_at: string
  /** How many FUTURE confirmed bookings were cancelled + refunded as a
   *  side effect (payments/refund.py's existing refund_booking() path). */
  cancelled_bookings_count: number
}

/** GET /api/v1/masters/me/tags (P3). */
export interface DistinctTagsResponse {
  tags: string[]
}

/** GET /api/v1/masters/me/students/{id}/groups (P3). */
export interface StudentGroupItem {
  id: string
  name: string
}

export interface StudentGroupsResponse {
  groups: StudentGroupItem[]
}

/** GET /api/v1/masters/me/groups -- «Ученики» first, custom by created_at,
 *  «Удалённые» last and omitted entirely when empty (server-decided). */
export function getGroups(): Promise<GroupListResponse> {
  return api.get<GroupListResponse>('/api/v1/masters/me/groups')
}

/** POST /api/v1/masters/me/groups -- create a custom group. 409 on a
 *  duplicate name for this master (surface via extractApiError). */
export function createGroup(name: string): Promise<GroupResponse> {
  return api.post<GroupResponse>('/api/v1/masters/me/groups', { name })
}

/** PATCH /api/v1/masters/me/groups/{id} -- rename a custom group. */
export function renameGroup(id: string, name: string): Promise<GroupResponse> {
  return api.patch<GroupResponse>(`/api/v1/masters/me/groups/${id}`, { name })
}

/** DELETE /api/v1/masters/me/groups/{id} -- delete a custom group (its
 *  memberships cascade; members fall back to the derived «Ученики»). */
export function deleteGroup(id: string): Promise<void> {
  return api.delete(`/api/v1/masters/me/groups/${id}`)
}

/** GET /api/v1/masters/me/groups/{id}/members -- {id} accepts "students" /
 *  "deleted" / a custom group's UUID, same paginated + searchable shape. */
export function getGroupMembers(
  id: string,
  search = '',
  limit = 20,
  offset = 0,
): Promise<PaginatedGroupMembersResponse> {
  const query = buildQuery({ search: search || undefined, limit, offset })
  return api.get<PaginatedGroupMembersResponse>(`/api/v1/masters/me/groups/${id}/members${query}`)
}

/** POST /api/v1/masters/me/groups/{id}/members -- add-access, not move
 *  (owner-settled): the student keeps every other membership. Idempotent. */
export function addGroupMember(id: string, studentUserId: string): Promise<void> {
  return api.post(`/api/v1/masters/me/groups/${id}/members`, {
    student_user_id: studentUserId,
  })
}

/** DELETE /api/v1/masters/me/groups/{id}/members/{studentUserId} -- remove
 *  from a CUSTOM group only (system slugs are rejected server-side). */
export function removeGroupMember(id: string, studentUserId: string): Promise<void> {
  return api.delete(`/api/v1/masters/me/groups/${id}/members/${studentUserId}`)
}

/** PUT /api/v1/masters/me/students/{studentUserId}/tag -- upsert (or, when
 *  tag is null, clear) the single tag for this student. ONE tag per
 *  student (owner Q1=A) -- this REPLACES, never appends. */
export function setStudentTag(
  studentUserId: string,
  tag: string | null,
): Promise<StudentTagResponse> {
  return api.put<StudentTagResponse>(`/api/v1/masters/me/students/${studentUserId}/tag`, {
    tag,
  })
}

/** POST /api/v1/masters/me/students/{studentUserId}/block (P3) -- sets
 *  blocked_at, drops the student from every custom group, cancels+refunds
 *  their FUTURE confirmed bookings on this master's practices. */
export function blockStudent(studentUserId: string): Promise<BlockStudentResponse> {
  return api.post<BlockStudentResponse>(`/api/v1/masters/me/students/${studentUserId}/block`)
}

/** DELETE /api/v1/masters/me/students/{studentUserId}/block (P3) -- unblock.
 *  The student returns to «Ученики» automatically (derived); custom-group
 *  memberships are NOT restored, the tag is kept. */
export function unblockStudent(studentUserId: string): Promise<void> {
  return api.delete(`/api/v1/masters/me/students/${studentUserId}/block`)
}

/** GET /api/v1/masters/me/tags (P3) -- every distinct tag this master has
 *  used, alphabetical. Closes the P2 palette-source gap (AddTagSheet used
 *  to derive its palette from whatever page of members happened to load). */
export function getMyTags(): Promise<DistinctTagsResponse> {
  return api.get<DistinctTagsResponse>('/api/v1/masters/me/tags')
}

/** GET /api/v1/masters/me/students/{studentUserId}/groups (P3) -- the
 *  CUSTOM groups this student is in for this master (profile group chips).
 *  Never the two virtuals -- they aren't membership rows. */
export function getStudentGroups(studentUserId: string): Promise<StudentGroupsResponse> {
  return api.get<StudentGroupsResponse>(`/api/v1/masters/me/students/${studentUserId}/groups`)
}

/** POST /api/v1/masters/me/groups/{id}/invite (P4). */
export interface GroupInviteResponse {
  invite_url: string
}

/** POST /api/v1/masters/groups/join (P4). */
export interface JoinGroupResponse {
  group_id: string
  group_name: string
  master_name: string
}

/** POST /api/v1/masters/me/groups/{id}/invite (P4) -- create-or-return the
 *  group's reusable invite link. CUSTOM groups only. Idempotent: repeat
 *  calls return the SAME url. */
export function createGroupInvite(id: string): Promise<GroupInviteResponse> {
  return api.post<GroupInviteResponse>(`/api/v1/masters/me/groups/${id}/invite`)
}

/** POST /api/v1/masters/groups/join (P4) -- resolve a group-invite token
 *  and join the CALLER (any authenticated user, not master-scoped) to that
 *  group. 403 if the caller is blocked by that group's master, 404 on an
 *  unknown/invalid token. */
export function joinGroup(token: string): Promise<JoinGroupResponse> {
  return api.post<JoinGroupResponse>('/api/v1/masters/groups/join', { token })
}
