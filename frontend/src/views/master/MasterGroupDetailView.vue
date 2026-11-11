<!--
  VELO Frontend -- MasterGroupDetailView (Master GROUPS P2, PROMPT №591)

  One component parametrised by :id -- a real custom group's UUID, or the
  system slugs "students" / "deleted". GET /masters/me/groups/:id/members
  handles all three the same way server-side.

  Reuses VListRow (member rows) + VInput (search) + VTag (the student's tag,
  if any, read-only here). Tapping a row navigates to the student profile
  screen (master-student-profile) -- not rebuilt here.

  G2 (PROMPT №609, owner-ruled): invite/rename/delete MOVED here from
  MasterGroupsView's per-card buttons -- reachable from this header's own
  «⋯» menu (VMenu/VMenuItem) for ANY custom group, empty or not (the old
  per-card buttons only worked when the group already had ≥1 member visible
  in the list). Virtual groups (the system students / deleted slugs) get
  none of the
  three -- matches the backend's 400-on-system-slug.

  Owner Q8 (PROMPT №610): the empty-state's own invite CTA
  (i18n:masterScreens.masterGroupDetail.inviteCta)
  -- a leftover from before the header menu existed (P4, PROMPT №593) --
  removed as a duplicate of that same header menu action, now the single
  invite entry point. `onInviteClick`'s link-copied toast
  (i18n:common.linkCopied) already
  lives on THIS screen (it always has, since the header menu invite calls
  the same function) -- nothing to move.

  T24-19 (PROMPT №638): the per-row «⋯» menu (add to group / add tag /
  remove from group / unblock -- everything that used to vary by `kind` on
  EACH row) is REMOVED. Those four actions moved to the student profile's
  own «⋯» menu and bottom action instead (T24-9/10/20,
  MasterStudentProfileView.vue) -- a row's only remaining trailing content
  is its tag chip, read-only. The header's own group-level «⋯» menu above
  (invite/rename/delete) is untouched -- a SEPARATE menu, one level up.
-->

<template>
  <div class="group-detail">
    <VHeader :title="headerTitle" show-back @back="router.push({ name: 'master-groups' })">
      <template v-if="kind === 'custom'" #action>
        <VMenu :ariaLabel="t('masterScreens.masterGroupDetail.menuAria')">
          <template #default="{ close }">
            <VMenuItem
              :icon="IconShare"
              :ariaLabel="t('masterScreens.masterGroupDetail.inviteCta')"
              @click="onHeaderInviteClick(close)"
            />
            <VMenuItem
              :icon="IconPen"
              :ariaLabel="t('masterScreens.masterGroupDetail.editAria')"
              @click="onRenameClick(close)"
            />
            <VMenuItem
              :icon="IconTrash"
              :ariaLabel="t('masterScreens.masterGroupDetail.deleteCta')"
              danger
              @click="onDeleteClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <div class="group-detail__content">
      <!-- Owner Q4 (PROMPT №610): description under the group name (the
           header title above). No description -> renders nothing, no
           reserved space (v-if on a falsy empty string). -->
      <p v-if="groupDescription" class="group-detail__description">{{ groupDescription }}</p>

      <div class="group-detail__search">
        <div class="group-detail__search-field">
          <VInput
            v-model="search"
            :placeholder="t('masterScreens.masterGroupDetail.search.placeholder')"
            :aria-label="t('masterScreens.masterGroupDetail.search.aria')"
            @focus="onFieldFocus"
          />
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="group-detail__state">
        <VLoader size="lg" />
      </div>

      <!-- Error -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="t('masterScreens.masterGroupDetail.toast.loadMembersFailed')"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
      </VEmptyState>

      <template v-else>
        <div
          v-for="member in members"
          :key="member.id"
          class="group-detail__row-wrap"
          role="button"
          tabindex="0"
          @click="openProfile(member)"
          @keydown.enter.space.prevent="openProfile(member)"
        >
          <VListRow :title="member.name">
            <template #lead>
              <VAvatar :name="member.name" :url="member.avatar_url ?? undefined" size="md" />
            </template>
            <template #trailing>
              <!-- T24-19 (PROMPT №638): the per-row "..." menu (add to
                   group / add tag / remove from group / unblock) is REMOVED
                   from every row here -- it moved to the student profile's
                   own "..." menu (T24-9/10) and bottom action (T24-20,
                   unblock). Tapping the row still opens that profile
                   (openProfile above); only the tag chip stays as a
                   read-only indicator on the row itself. -->
              <div v-if="member.tag" class="group-detail__row-actions">
                <VTag>{{ member.tag }}</VTag>
              </div>
            </template>
          </VListRow>
        </div>

        <VEmptyState
          v-if="members.length === 0"
          icon="group"
          :title="
            search ? t('common.searchNoHits') : t('masterScreens.masterGroupDetail.empty.noMembers')
          "
          :description="search ? t('common.searchHint') : emptyDescription"
        />
        <!-- Empty-group invite CTA REMOVED here (owner Q8, PROMPT №610): the
             header's own «⋯» menu (line ~30 above, kind==='custom') is now
             the SINGLE invite entry point for any custom group, empty or
             not -- this button duplicated it (G2, PROMPT №609, already made
             the header menu path universal; this CTA just hadn't been
             cleaned up yet). `onInviteClick`/`inviting` stay -- still used
             by `onHeaderInviteClick` above. -->
      </template>
    </div>

    <!-- Rename + description edit (G2, PROMPT №609 -- moved from
         MasterGroupsView's card menu; owner Q10, PROMPT №611 -- gained the
         description field, same dialog). PROMPT №613: compact-title added --
         this title (~494px at --text-xl) is LONGER than the report-dialog
         title (i18n:report.title; ~408px),
         the title that originally justified this
         prop, and was missed when this dialog was built. -->
    <VBottomSheet
      :open="renameOpen"
      :title="t('masterScreens.masterGroupDetail.renameCta')"
      compact-title
      :save-label="t('ui.save')"
      @save="onRenameSave"
      @close="renameOpen = false"
    >
      <VInput
        v-model="renameName"
        :label="t('masterScreens.masterGroupDetail.fields.name')"
        :placeholder="t('masterScreens.masterGroupDetail.fields.namePlaceholder')"
      />
      <VTextarea
        v-model="renameDescription"
        :label="t('masterScreens.masterGroupDetail.fields.description')"
        :placeholder="t('masterScreens.masterGroupDetail.fields.description')"
        :rows="3"
        autogrow
      />
    </VBottomSheet>

    <!-- Delete confirm (G2, PROMPT №609 -- moved from MasterGroupsView's card menu) -->
    <VConfirmDialog
      :open="deleteConfirmOpen"
      :message="deleteMessage"
      :confirm-label="t('ui.delete')"
      danger
      :loading="deleting"
      @confirm="onDeleteConfirm"
      @cancel="deleteConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VLoader,
  VEmptyState,
  VButton,
  VInput,
  VTextarea,
  VAvatar,
  VListRow,
  VMenu,
  VMenuItem,
  VTag,
  VConfirmDialog,
  VBottomSheet,
} from '@/components/ui'
import { IconShare, IconPen } from '@/components/icons'
// IconTrash is not re-exported from the icons barrel (same pattern as
// EntryView.vue's delete action) -- import the component file directly.
import { IconTrash } from '@/components/icons'
import { createGroupInvite, renameGroup, deleteGroup } from '@/api/groups'
import { useQuery, useQueryCache } from '@pinia/colada'
import { groupMembersQuery, masterGroupsQuery } from '@/composables/queries/groups'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { screenQueryState } from '@/composables/queries/screenState'
import { ApiResponseError } from '@/api/client'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useToast } from '@/composables/useToast'
import { useDebouncedSearch } from '@/composables/useDebouncedSearch'
import { errorMessage, extractApiError } from '@/composables/useApiError'
import type { GroupMemberItem, GroupListItem, GroupKind } from '@/api/groups'

const route = useRoute()
const router = useRouter()
const { onFieldFocus } = useKeyboardFieldScroll()

const groupId = computed(() => String(route.params.id))
const queryCache = useQueryCache()

// Owner Q12 (PROMPT №611): route.query is now only a FIRST-PAINT HINT so the
// header doesn't flash empty while getGroups() is in flight -- it never
// wins once the API has answered, even if the API's own value is empty/
// null (a Mini App reload has NO query at all: the app is reopened, not
// navigated, so the old query-only design rendered a permanently blank
// group header (an empty name in the header title form) on every reload).
// `groupMeta` comes from the group list
// query below, matched by this screen's own id.
const groupsQuery = useQuery(() => masterGroupsQuery())
const groupMeta = computed<GroupListItem | null>(
  () => groupsQuery.data.value?.find((g) => g.id === groupId.value) ?? null,
)
const groupName = computed(() =>
  groupMeta.value ? groupMeta.value.name : String(route.query.name ?? ''),
)
const headerTitle = computed(() =>
  t('masterScreens.masterGroupDetail.rename.title', { name: groupName.value }),
)
const groupDescription = computed(() =>
  groupMeta.value ? (groupMeta.value.description ?? '') : String(route.query.description ?? ''),
)

/** Derived purely from the id string -- "students"/"deleted" are system
 *  slugs, matching the backend's own dispatch (groups_service.py). */
const kind = computed((): GroupKind => {
  if (groupId.value === 'students') return 'students'
  if (groupId.value === 'deleted') return 'deleted'
  return 'custom'
})

const emptyDescription = computed(() =>
  kind.value === 'deleted'
    ? t('masterScreens.masterGroupDetail.empty.deletedEmpty')
    : t('masterScreens.masterGroupDetail.empty.addFirst'),
)

const search = ref('')

// -- The members (Pinia Colada, FE-166 step 6: queries/groups.ts) --
//
// Server-side search (?search=), lightly debounced so it doesn't refetch on
// every keystroke; the timer dies with the component. Each (group, search)
// pair is its own entry: an answer for an older search never repaints a
// newer one.
const debouncedSearch = ref('')
useDebouncedSearch(search, (query) => {
  debouncedSearch.value = query
})

/** The list has answered and nothing is in flight: its verdict is current. */
const listSettled = computed(
  () => groupsQuery.status.value !== 'pending' && groupsQuery.asyncStatus.value === 'idle',
)

/**
 * The group is not in the master's list. list_master_groups omits "deleted"
 * ENTIRELY when its count is 0 -- that absence is a normal empty state (zero
 * blocked students right now), not a not-found. Every other id (a real
 * custom UUID, or "students" which the backend always includes
 * unconditionally) being absent means genuinely gone or invalid -- this
 * screen's own error state rather than a blank header (owner Q12's own
 * explicit warning).
 *
 * Decided only on a SUCCESSFUL, settled answer: a cached copy may predate a
 * group the master just created on the groups screen (which does not write
 * this cache) -- while the list revalidates the group reads as loading --
 * and a failed refetch keeps that old copy, so a failure decides nothing (a
 * failed list is best-effort: the members request is the authoritative
 * failure signal).
 */
const groupMissing = computed(
  () =>
    listSettled.value &&
    groupsQuery.status.value === 'success' &&
    groupMeta.value === null &&
    kind.value !== 'deleted',
)

/** A group the list has not confirmed yet while it revalidates: its cached members wait. */
const groupUnconfirmed = computed(
  () => groupMeta.value === null && kind.value !== 'deleted' && !listSettled.value,
)

// Sequenced: a genuinely deleted/invalid group must be caught BEFORE the
// members request, so the error state renders once, from one source. The
// members leave once the group is known (in the list, or the system
// «deleted» group) or the list has settled without a verdict against it (a
// failed list is best-effort), and never for a missing group.
const membersQuery = useQuery(() =>
  groupMembersQuery({
    groupId: groupId.value,
    search: debouncedSearch.value,
    enabled:
      groupMeta.value !== null ||
      kind.value === 'deleted' ||
      (listSettled.value && !groupMissing.value),
  }),
)
const membersState = screenQueryState(membersQuery)

const members = computed<GroupMemberItem[]>(() => membersQuery.data.value ?? [])
/** No members to show yet (or a group not confirmed yet) and no verdict against them: the loader. */
const loading = computed(
  () =>
    !groupMissing.value &&
    !membersState.failed.value &&
    (membersQuery.data.value === undefined || groupUnconfirmed.value),
)
const error = computed(() => {
  if (groupMissing.value) return t('masterScreens.masterGroupDetail.notFound')
  return membersState.failed.value
    ? extractApiError(membersQuery.error.value, t('common.tryAgain'))
    : ''
})

/**
 * The retry asks the list again, and the members too unless the group was
 * found missing -- read BEFORE the refetch, which unsettles the list at
 * once. Should the group turn up, the members follow through `enabled`.
 */
function retry(): void {
  const missing = groupMissing.value
  void groupsQuery.refetch()
  if (!missing) void membersQuery.refetch()
}

// T24-19 (PROMPT №638): tapping a row now ALWAYS opens the profile -- there
// is no competing row menu to route around anymore (the tag/add-to-group/
// remove-from-group/unblock actions all moved to that profile, T24-9/10/20).
function openProfile(member: GroupMemberItem): void {
  void router.push({
    name: 'master-student-profile',
    params: { id: member.id },
    query: { name: member.name },
  })
}

const toast = useToast()

// -- Invite (P4, PROMPT №593; empty-group CTA below AND the header menu,
//    G2 PROMPT №609 -- same action, two entry points now: the CTA only
//    shows for an actually-empty custom group, the header menu works for
//    any custom group). --
const inviting = ref(false)
async function onInviteClick(): Promise<void> {
  if (inviting.value) return
  inviting.value = true
  try {
    const res = await createGroupInvite(groupId.value)
    // Clipboard needs no backend — write the link straight to the
    // clipboard (B2, same pattern as MasterGroupsView's row invite).
    await navigator.clipboard.writeText(res.invite_url)
    toast.success(t('common.linkCopied'))
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.masterGroupDetail.toast.linkCreateFailed')))
  } finally {
    inviting.value = false
  }
}
/** Header-menu wrapper -- same B7-hook reasoning as the other close()
 *  wrappers in this file (a semicolon-joined inline handler can be
 *  reformatted across lines by prettier and lose its semicolon). */
function onHeaderInviteClick(close: () => void): void {
  void onInviteClick()
  close()
}

// -- Rename + description edit (G2, PROMPT №609 -- moved from
// MasterGroupsView's card menu; owner Q10, PROMPT №611 -- gained description) --
const renameOpen = ref(false)
const renameName = ref('')
const renameDescription = ref('')
function onRenameClick(close: () => void): void {
  renameName.value = groupName.value
  renameDescription.value = groupDescription.value
  renameOpen.value = true
  close()
}
async function onRenameSave(): Promise<void> {
  const name = renameName.value.trim()
  if (!name) return
  try {
    await renameGroup(groupId.value, name, renameDescription.value.trim())
    renameOpen.value = false
    // Owner Q12/Q10 (PROMPT №611): the screen is API-driven (groupMeta
    // above), not route.query -- the list is re-read instead of rewriting
    // the URL.
    await invalidateAfter(queryCache, 'renameGroup')
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.masterGroupDetail.toast.renameFailed')))
  }
}

// -- Delete (G2, PROMPT №609 -- moved from MasterGroupsView's card menu) --
const deleteConfirmOpen = ref(false)
const deleting = ref(false)
const deleteMessage = computed(() =>
  t('masterScreens.masterGroupDetail.rename.deleteConfirm', { name: groupName.value }),
)
function onDeleteClick(close: () => void): void {
  deleteConfirmOpen.value = true
  close()
}
async function onDeleteConfirm(): Promise<void> {
  deleting.value = true
  try {
    await deleteGroup(groupId.value)
    deleteConfirmOpen.value = false
    void invalidateAfter(queryCache, 'deleteGroup')
    // The group we were viewing no longer exists -- unlike
    // MasterGroupsView's own delete (which stays on the list and
    // reloads), this screen has nothing left to reload.
    void router.push({ name: 'master-groups' })
  } catch (e) {
    // Same group_in_use translation as MasterGroupsView's own delete
    // handler -- the backend's message names the blocking practice(s) in
    // English, not something to relay verbatim to a human.
    // B8 (PROMPT №746): phrase now lives in errorMessages.ts.
    if (e instanceof ApiResponseError && e.code === 'group_in_use') {
      toast.error(errorMessage('group_in_use'))
    } else {
      toast.error(extractApiError(e, t('masterScreens.masterGroupDetail.toast.deleteFailed')))
    }
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.group-detail {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.group-detail__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Owner Q4 (PROMPT №610): optional description, under the group name.
   Absent entirely (v-if) when empty -- no placeholder text, no reserved
   height, per the owner's own "no dead space" rule. */
.group-detail__description {
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin: 0;
}

.group-detail__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* Search: same DS pattern as MasterStudentsView (VInput glass pill). G4
   (PROMPT №609): the decorative magnifier button removed -- it was
   aria-hidden with no click handler, the field already self-triggers via
   its own watch()+debounce. */
.group-detail__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.group-detail__search-field {
  flex: 1;
  min-width: 0;
}

.group-detail__search-field :deep(.v-input) {
  margin-bottom: 0;
}

/* G5 (PROMPT №609): white glow via the existing --velo-shadow-glow token
   (measured from the owner's SVG as dilate 8.82 + blur 13.167 white --
   the token is the closest existing match, used here rather than the
   raw numbers). */
.group-detail__search-field :deep(.v-input__field) {
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  box-shadow: var(--velo-shadow-glow);
}

.group-detail__row-wrap {
  cursor: pointer;
}

.group-detail__row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
