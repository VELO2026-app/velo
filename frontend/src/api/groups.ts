// =============================================================================
// VELO Frontend -- Master Groups API (P2, PROMPT №591)
// =============================================================================
//
// Typed wrappers over api.get/post/patch/put/delete for the master GROUPS
// endpoints, mirroring masters.ts. HAND-WRITTEN, not generated: the backend
// (P1, PROMPT №590) shipped these endpoints without a local server to
// regenerate generated.ts against, so the types below are a temporary
// stand-in for the real OpenAPI-derived ones. They reconcile automatically
// at the next `velo update` regen -- do NOT add these to api/types.ts by
// hand (that file's own header forbids it).
//
// Backend endpoints (masters/groups_router.py + students_router.py's tag/
// block/P3-addenda additions):
//   GET    /api/v1/masters/me/groups                          -- list
//   GET    /api/v1/masters/me/groups/search                   -- cross-group search (P6)
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
import type {
  BlockStudentResponse,
  DistinctTagsResponse,
  GroupInviteResponse,
  GroupListResponse,
  GroupResponse,
  JoinGroupResponse,
  PaginatedGroupMembersResponse,
  PaginatedGroupSearchResponse,
  StudentGroupsResponse,
  StudentTagResponse,
} from '@/api/types'
import { path, raw } from '@/api/path'

// Kept importable from '@/api/groups' for existing consumers; the shapes are
// the generated ones (re-exported, not redeclared).
export type {
  GroupListItem,
  GroupMemberItem,
  GroupSearchMemberItem,
  StudentGroupItem,
} from '@/api/types'

/** System group slugs -- never a real group id. */
export type GroupKind = 'students' | 'deleted' | 'custom'

/** GET /api/v1/masters/me/groups -- the default students group ("students")
 *  first, custom by created_at, the deleted group ("deleted") last and
 *  omitted entirely when empty (server-decided; the Russian display names
 *  arrive on the wire as backend data, not catalog keys). */
export function getGroups(): Promise<GroupListResponse> {
  return api.get<GroupListResponse>('/api/v1/masters/me/groups')
}

/** POST /api/v1/masters/me/groups -- create a custom group.
 *
 *  @param description - Optional (Owner Q4, PROMPT №610); blank/whitespace
 *    is normalized to null server-side.
 *
 *  @throws ApiResponseError -- 409 on a duplicate name for this master
 *    (surface via extractApiError). */
export function createGroup(name: string, description?: string): Promise<GroupResponse> {
  return api.post<GroupResponse>('/api/v1/masters/me/groups', {
    name,
    description: description || undefined,
  })
}

/** `PATCH /api/v1/masters/me/groups/{id}` -- rename AND/OR edit description
 *  (Owner Q10, PROMPT №611). This is the same distinction
 *  MasterGroupDetailView's combined rename+description dialog relies on: it
 *  always sends both, but a raw caller renaming only must be able to omit
 *  description without wiping it.
 *
 *  @param description - PARTIAL UPDATE: omitting the argument entirely
 *    (`undefined`) omits the JSON key too, so the backend's own
 *    exclude_unset check leaves the column untouched -- passing `''`
 *    explicitly sends the key and clears it to NULL server-side. */
export function renameGroup(
  id: string,
  name: string,
  description?: string,
): Promise<GroupResponse> {
  const body: { name: string; description?: string } = { name }
  if (description !== undefined) {
    body.description = description
  }
  return api.patch<GroupResponse>(path`/api/v1/masters/me/groups/${id}`, body)
}

/** `DELETE /api/v1/masters/me/groups/{id}` -- delete a custom group (its
 *  memberships cascade; members fall back to the derived default students
 *  group). */
export function deleteGroup(id: string): Promise<void> {
  return api.delete(path`/api/v1/masters/me/groups/${id}`)
}

/** `GET /api/v1/masters/me/groups/{id}/members` -- `{id}` accepts
 *  "students" / "deleted" / a custom group's UUID, same paginated + searchable
 *  shape. */
export function getGroupMembers(
  id: string,
  search = '',
  limit = 20,
  offset = 0,
): Promise<PaginatedGroupMembersResponse> {
  const query = buildQuery({ search: search || undefined, limit, offset })
  return api.get<PaginatedGroupMembersResponse>(
    path`/api/v1/masters/me/groups/${id}/members${raw(query)}`,
  )
}

/** GET /api/v1/masters/me/groups/search (P6) -- cross-group people-search,
 *  one row per (student, CUSTOM group) membership. Same paginated +
 *  searchable shape as getGroupMembers above. */
export function searchGroupMemberships(
  search = '',
  limit = 20,
  offset = 0,
): Promise<PaginatedGroupSearchResponse> {
  const query = buildQuery({ search: search || undefined, limit, offset })
  return api.get<PaginatedGroupSearchResponse>(`/api/v1/masters/me/groups/search${query}`)
}

/** `POST /api/v1/masters/me/groups/{id}/members` -- add-access, not move
 *  (owner-settled): the student keeps every other membership. Idempotent. */
export function addGroupMember(id: string, studentUserId: string): Promise<void> {
  return api.post(path`/api/v1/masters/me/groups/${id}/members`, {
    student_user_id: studentUserId,
  })
}

/** `DELETE /api/v1/masters/me/groups/{id}/members/{studentUserId}` -- remove
 *  from a CUSTOM group only (system slugs are rejected server-side). */
export function removeGroupMember(id: string, studentUserId: string): Promise<void> {
  return api.delete(path`/api/v1/masters/me/groups/${id}/members/${studentUserId}`)
}

/** `PUT /api/v1/masters/me/students/{studentUserId}/tag` -- upsert the
 *  single tag for this student.
 *
 *  @param tag - Null clears the single tag for this student. ONE tag per
 *    student (owner Q1=A) -- this REPLACES, never appends. */
export function setStudentTag(
  studentUserId: string,
  tag: string | null,
): Promise<StudentTagResponse> {
  return api.put<StudentTagResponse>(path`/api/v1/masters/me/students/${studentUserId}/tag`, {
    tag,
  })
}

/** `POST /api/v1/masters/me/students/{studentUserId}/block` (P3) -- sets
 *  blocked_at, drops the student from every custom group, cancels+refunds
 *  their FUTURE confirmed bookings on this master's practices. */
export function blockStudent(studentUserId: string): Promise<BlockStudentResponse> {
  return api.post<BlockStudentResponse>(path`/api/v1/masters/me/students/${studentUserId}/block`)
}

/** `DELETE /api/v1/masters/me/students/{studentUserId}/block` (P3) -- unblock.
 *  The student returns to the default students group automatically (derived);
 *  custom-group memberships are NOT restored, the tag is kept. */
export function unblockStudent(studentUserId: string): Promise<void> {
  return api.delete(path`/api/v1/masters/me/students/${studentUserId}/block`)
}

/** GET /api/v1/masters/me/tags (P3) -- every distinct tag this master has
 *  used, alphabetical. Closes the P2 palette-source gap (AddTagSheet used
 *  to derive its palette from whatever page of members happened to load). */
export function getMyTags(): Promise<DistinctTagsResponse> {
  return api.get<DistinctTagsResponse>('/api/v1/masters/me/tags')
}

/** `GET /api/v1/masters/me/students/{studentUserId}/groups` (P3) -- the
 *  CUSTOM groups this student is in for this master (profile group chips).
 *  Never the two virtuals -- they aren't membership rows. */
export function getStudentGroups(studentUserId: string): Promise<StudentGroupsResponse> {
  return api.get<StudentGroupsResponse>(path`/api/v1/masters/me/students/${studentUserId}/groups`)
}

/** `POST /api/v1/masters/me/groups/{id}/invite` (P4) -- create-or-return the
 *  group's reusable invite link. CUSTOM groups only.
 *
 *  @returns The SAME url on repeat calls (idempotent). */
export function createGroupInvite(id: string): Promise<GroupInviteResponse> {
  return api.post<GroupInviteResponse>(path`/api/v1/masters/me/groups/${id}/invite`)
}

/** `POST /api/v1/masters/groups/join` (P4) -- resolve a group-invite token
 *  and join the CALLER (any authenticated user, not master-scoped) to that
 *  group.
 *
 *  @throws ApiResponseError -- 403 if the caller is blocked by that group's
 *    master; 404 on an unknown/invalid token. */
export function joinGroup(token: string): Promise<JoinGroupResponse> {
  return api.post<JoinGroupResponse>('/api/v1/masters/groups/join', { token })
}
