// =============================================================================
// VELO Frontend -- the master's student groups on Pinia Colada (FE-166 step 6)
// =============================================================================
//
// MasterGroupDetailView reads two entries: the master's group list (the
// header's name and description, and whether the group still exists) and
// one group's members for one search. Each (group, search) pair has its own
// entry, so a slow answer for an older search lands in that search's entry
// and never repaints a newer one -- the guard the screen used to keep by
// hand (loadEpoch).
//
// staleTime 0 for both: other screens still change groups and their members
// through local state (the groups list, the student profile's add / remove /
// block), so every visit revalidates; the cached copy only removes the
// loader. The group mutations of this screen invalidate the list
// (./invalidation.ts, renameGroup / deleteGroup).
// =============================================================================

import { defineQueryOptions } from '@pinia/colada'
import { getGroupMembers, getGroups } from '@/api/groups'
import type { GroupListItem, GroupMemberItem } from '@/api/groups'
import { keys } from '@/composables/queries/keys'

/** Query options for every group of mine (`GET /masters/me/groups`). */
export const masterGroupsQuery = defineQueryOptions(() => ({
  key: keys.groups.list(),
  query: async (): Promise<GroupListItem[]> => (await getGroups()).items,
  staleTime: 0,
}))

/** Query options for one group's members for one search (`GET /masters/me/groups/{id}/members`). */
export const groupMembersQuery = defineQueryOptions(
  ({ groupId, search, enabled }: { groupId: string; search: string; enabled: boolean }) => ({
    key: keys.groups.members(groupId, search),
    query: async (): Promise<GroupMemberItem[]> => (await getGroupMembers(groupId, search)).items,
    staleTime: 0,
    enabled,
  }),
)
