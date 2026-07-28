<!--
  VELO Frontend -- MasterGroupDetailView (Master GROUPS P2, ПРОМТ №591)

  One component parametrised by :id -- a real custom group's UUID, or the
  system slugs "students" / "deleted". GET /masters/me/groups/:id/members
  handles all three the same way server-side; this screen only varies the
  per-row «⋯» action set by `kind` (derived from :id itself -- no extra
  fetch needed to know whether we're on a system slug).

  Reuses VListRow (member rows) + VMenu/VMenuItem (per-row «⋯») + VInput
  (search) + VTag (the student's tag, if any). Tapping a row navigates to
  the EXISTING student profile screen (master-student-profile) -- not
  rebuilt here.

  G2 (ПРОМТ №609, owner-ruled): invite/rename/delete MOVED here from
  MasterGroupsView's per-card buttons -- reachable from this header's own
  «⋯» menu for ANY custom group, empty or not (the old per-card buttons
  only worked when the group already had ≥1 member visible in the list).
  Same VMenu/VMenuItem idiom the per-member rows on this exact screen
  already use, just one level up (the group itself, not a member). Virtual
  groups («Ученики»/«Удалённые») get none of the three -- matches the
  backend's 400-on-system-slug.

  Owner Q8 (ПРОМТ №610): the empty-state's own "Пригласить в группу" CTA
  -- a leftover from before the header menu existed (P4, ПРОМТ №593) --
  removed as a duplicate of that same header menu action, now the single
  invite entry point. `onInviteClick`'s "Ссылка скопирована" toast already
  lives on THIS screen (it always has, since the header menu invite calls
  the same function) -- nothing to move.
-->

<template>
  <div class="group-detail">
    <VHeader :title="headerTitle" show-back @back="router.push({ name: 'master-groups' })">
      <template v-if="kind === 'custom'" #action>
        <VMenu ariaLabel="Меню группы">
          <template #default="{ close }">
            <VMenuItem
              :icon="IconShare"
              ariaLabel="Пригласить в группу"
              @click="onHeaderInviteClick(close)"
            />
            <VMenuItem :icon="IconPen" ariaLabel="Изменить" @click="onRenameClick(close)" />
            <VMenuItem
              :icon="IconTrash"
              ariaLabel="Удалить группу"
              danger
              @click="onDeleteClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <div class="group-detail__content">
      <!-- Owner Q4 (ПРОМТ №610): description under the group name (the
           header title above). No description -> renders nothing, no
           reserved space (v-if on a falsy empty string). -->
      <p v-if="groupDescription" class="group-detail__description">{{ groupDescription }}</p>

      <div class="group-detail__search">
        <div class="group-detail__search-field">
          <VInput
            v-model="search"
            placeholder="Искать ученика..."
            aria-label="Искать ученика"
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
        title="Не удалось загрузить участников"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="retry">Повторить</VButton>
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
              <div class="group-detail__row-actions" @click.stop>
                <VTag v-if="member.tag">{{ member.tag }}</VTag>
                <VMenu v-if="kind !== 'deleted'" ariaLabel="Меню участника">
                  <template #default="{ close }">
                    <VMenuItem
                      :icon="IconPlus"
                      ariaLabel="Добавить в группу"
                      @click="onAddToGroupClick(member, close)"
                    />
                    <VMenuItem
                      :icon="IconPen"
                      ariaLabel="Добавить тег"
                      @click="onAddTagClick(member, close)"
                    />
                    <VMenuItem
                      v-if="kind === 'custom'"
                      :icon="IconTrash"
                      ariaLabel="Удалить из группы"
                      danger
                      @click="onRemoveFromGroupClick(member, close)"
                    />
                  </template>
                </VMenu>
                <!-- «Удалённые» (P3, ПРОМТ №592): the one action here is
                     Unblock -- everything else (add to group / tag) is
                     meaningless for a blocked student. -->
                <VMenu v-else ariaLabel="Меню участника">
                  <template #default="{ close }">
                    <VMenuItem
                      :icon="IconCheck"
                      ariaLabel="Разблокировать"
                      @click="onUnblockClick(member, close)"
                    />
                  </template>
                </VMenu>
              </div>
            </template>
          </VListRow>
        </div>

        <VEmptyState
          v-if="members.length === 0"
          icon="group"
          :title="search ? 'Никого не найдено' : 'Участников пока нет'"
          :description="search ? 'Попробуйте изменить запрос' : emptyDescription"
        />
        <!-- Empty-group invite CTA REMOVED here (owner Q8, ПРОМТ №610): the
             header's own «⋯» menu (line ~30 above, kind==='custom') is now
             the SINGLE invite entry point for any custom group, empty or
             not -- this button duplicated it (G2, ПРОМТ №609, already made
             the header menu path universal; this CTA just hadn't been
             cleaned up yet). `onInviteClick`/`inviting` stay -- still used
             by `onHeaderInviteClick` above. -->
      </template>
    </div>

    <AddTagSheet
      v-if="tagTarget"
      :open="!!tagTarget"
      :student-id="tagTarget.id"
      :student-name="tagTarget.name"
      :current-tag="tagTarget.tag"
      @close="tagTarget = null"
      @saved="load"
    />

    <AddToGroupSheet
      v-if="addTarget"
      :open="!!addTarget"
      :student-id="addTarget.id"
      :student-name="addTarget.name"
      :custom-groups="customGroups"
      :current-group-id="kind === 'custom' ? groupId : null"
      @close="addTarget = null"
      @saved="load"
    />

    <RemoveFromGroupSheet
      v-if="removeTarget && kind === 'custom'"
      :open="!!removeTarget"
      :student-id="removeTarget.id"
      :student-name="removeTarget.name"
      :current-group-id="groupId"
      :custom-groups="customGroups"
      @close="removeTarget = null"
      @saved="load"
    />

    <!-- Unblock confirm («Удалённые» rows only, P3 ПРОМТ №592) -->
    <VConfirmDialog
      :open="!!unblockTarget"
      :title="unblockTitle"
      :message="unblockMessage"
      confirm-label="Разблокировать"
      :loading="unblocking"
      @confirm="onUnblockConfirm"
      @cancel="unblockTarget = null"
    />

    <!-- Rename + description edit (G2, ПРОМТ №609 -- moved from
         MasterGroupsView's card menu; owner Q10, ПРОМТ №611 -- gained the
         description field, same dialog). -->
    <VBottomSheet
      :open="renameOpen"
      title="Изменить название и описание"
      save-label="Сохранить"
      @save="onRenameSave"
      @close="renameOpen = false"
    >
      <VInput v-model="renameName" label="Название" placeholder="Название группы" />
      <VTextarea
        v-model="renameDescription"
        label="Описание"
        placeholder="Описание"
        :rows="3"
        autogrow
      />
    </VBottomSheet>

    <!-- Delete confirm (G2, ПРОМТ №609 -- moved from MasterGroupsView's card menu) -->
    <VConfirmDialog
      :open="deleteConfirmOpen"
      :message="deleteMessage"
      confirm-label="Удалить"
      danger
      :loading="deleting"
      @confirm="onDeleteConfirm"
      @cancel="deleteConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
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
import { IconShare, IconPlus, IconPen, IconCheck } from '@/components/icons'
// IconTrash is not re-exported from the icons barrel (same pattern as
// EntryView.vue's delete action) -- import the component file directly.
import IconTrash from '@/components/icons/IconTrash.vue'
import AddTagSheet from '@/components/shared/AddTagSheet.vue'
import AddToGroupSheet from '@/components/shared/AddToGroupSheet.vue'
import RemoveFromGroupSheet from '@/components/shared/RemoveFromGroupSheet.vue'
import {
  getGroupMembers,
  getGroups,
  unblockStudent,
  createGroupInvite,
  renameGroup,
  deleteGroup,
} from '@/api/groups'
import { ApiResponseError } from '@/api/client'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { GroupMemberItem, GroupListItem, GroupKind } from '@/api/groups'

const route = useRoute()
const router = useRouter()
const { onFieldFocus } = useKeyboardFieldScroll()

const groupId = computed(() => String(route.params.id))

// Owner Q12 (ПРОМТ №611): route.query is now only a FIRST-PAINT HINT so the
// header doesn't flash empty while getGroups() is in flight -- it never
// wins once the API has answered, even if the API's own value is empty/
// null (a Mini App reload has NO query at all: the app is reopened, not
// navigated, so the old query-only design rendered a permanently blank
// «Группа ""» header on every reload). `groupMeta` is set by loadGroups()
// below, matched by this screen's own id.
const groupMeta = ref<GroupListItem | null>(null)
const groupName = computed(() =>
  groupMeta.value ? groupMeta.value.name : String(route.query.name ?? ''),
)
const headerTitle = computed(() => `Группа "${groupName.value}"`)
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
  kind.value === 'deleted' ? 'Никого не заблокировали' : 'Добавьте первого ученика',
)

const members = ref<GroupMemberItem[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')

// This master's custom groups -- feeds AddToGroupSheet / RemoveFromGroupSheet's
// chip palette. Loaded once; independent of the members list/search. Also
// where THIS group's own name/description come from now (owner Q12,
// ПРОМТ №611) -- getGroups() already returns every group, custom AND the
// two virtuals, so one fetch covers both needs instead of two.
const allGroups = ref<GroupListItem[]>([])
const customGroups = computed(() => allGroups.value.filter((g) => g.kind === 'custom'))

async function loadGroups(): Promise<void> {
  try {
    const res = await getGroups()
    allGroups.value = res.items
    const match = res.items.find((g) => g.id === groupId.value)
    if (match) {
      groupMeta.value = match
    } else if (kind.value !== 'deleted') {
      // list_master_groups omits "deleted" ENTIRELY when its count is 0 --
      // that absence is a normal empty state (zero blocked students right
      // now), not a not-found. Every other id (a real custom UUID, or
      // "students" which the backend always includes unconditionally)
      // being absent means genuinely gone or invalid -- reuse this
      // screen's own existing error state rather than leaving a blank
      // header (owner Q12's own explicit warning).
      error.value = 'Группа не найдена'
    }
  } catch {
    // Best-effort: load() below (members) has its own independent error
    // handling and is the authoritative failure signal for this screen --
    // a metadata-fetch hiccup alone doesn't need a separate message, and
    // customGroups above degrades to [] on its own via the empty allGroups
    // fallback, matching the old loadCustomGroups()'s catch behavior.
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await getGroupMembers(groupId.value, search.value)
    members.value = res.items
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}

// Server-side search (?search=) -- lightly debounced so it doesn't refetch
// on every keystroke.
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 300)
})

// Sequenced (not parallel with load() below): a genuinely deleted/invalid
// group must be caught BEFORE attempting the members fetch, so the error
// state renders once, from one source, instead of racing two independent
// writers of `error`. The retry button (template) calls this, not load()
// alone, so a retry also re-validates the group still exists.
async function retry(): Promise<void> {
  loading.value = true
  error.value = ''
  await loadGroups()
  if (error.value) {
    loading.value = false
    return
  }
  await load()
}

onMounted(retry)

function openProfile(member: GroupMemberItem): void {
  router.push({
    name: 'master-student-profile',
    params: { id: member.id },
    query: { name: member.name },
  })
}

const tagTarget = ref<GroupMemberItem | null>(null)
function openAddTag(member: GroupMemberItem): void {
  tagTarget.value = member
}

const addTarget = ref<GroupMemberItem | null>(null)
function openAddToGroup(member: GroupMemberItem): void {
  addTarget.value = member
}

const removeTarget = ref<GroupMemberItem | null>(null)
function openRemoveFromGroup(member: GroupMemberItem): void {
  removeTarget.value = member
}

// Single-expression wrappers for the VMenu default-slot's `close` (a
// semicolon-joined inline handler here would be reformatted across lines
// by prettier and lose its semicolon, breaking the Vue template compiler
// -- one function call per @click avoids that entirely).
function onAddToGroupClick(member: GroupMemberItem, close: () => void): void {
  openAddToGroup(member)
  close()
}
function onAddTagClick(member: GroupMemberItem, close: () => void): void {
  openAddTag(member)
  close()
}
function onRemoveFromGroupClick(member: GroupMemberItem, close: () => void): void {
  openRemoveFromGroup(member)
  close()
}

// -- Unblock («Удалённые» rows only, P3 ПРОМТ №592) --
const toast = useToast()
const unblockTarget = ref<GroupMemberItem | null>(null)
const unblocking = ref(false)
const unblockTitle = computed(() =>
  unblockTarget.value ? `Разблокировать ${unblockTarget.value.name}?` : '',
)
const unblockMessage = computed(() =>
  unblockTarget.value
    ? `${unblockTarget.value.name} вернется в группу «Ученики» и снова сможет видеть и бронировать ваши практики.`
    : '',
)
function openUnblock(member: GroupMemberItem): void {
  unblockTarget.value = member
}
function onUnblockClick(member: GroupMemberItem, close: () => void): void {
  openUnblock(member)
  close()
}
// -- Invite (P4, ПРОМТ №593; empty-group CTA below AND the header menu,
//    G2 ПРОМТ №609 -- same action, two entry points now: the CTA only
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
    toast.success('Ссылка скопирована')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось создать ссылку'))
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

async function onUnblockConfirm(): Promise<void> {
  const target = unblockTarget.value
  if (!target) return
  unblocking.value = true
  try {
    await unblockStudent(target.id)
    toast.success('Пользователь разблокирован')
    unblockTarget.value = null
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось разблокировать'))
  } finally {
    unblocking.value = false
  }
}

// -- Rename + description edit (G2, ПРОМТ №609 -- moved from
// MasterGroupsView's card menu; owner Q10, ПРОМТ №611 -- gained description) --
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
    // Owner Q12/Q10 (ПРОМТ №611): the screen is now API-driven (groupMeta
    // above), not route.query -- re-read from getGroups() instead of
    // rewriting the URL, same source of truth loadGroups() already is.
    await loadGroups()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось переименовать группу'))
  }
}

// -- Delete (G2, ПРОМТ №609 -- moved from MasterGroupsView's card menu) --
const deleteConfirmOpen = ref(false)
const deleting = ref(false)
const deleteMessage = computed(
  () => `Удалить группу «${groupName.value}»? Участники вернутся в группу «Ученики».`,
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
    // The group we were viewing no longer exists -- unlike
    // MasterGroupsView's own delete (which stays on the list and
    // reloads), this screen has nothing left to reload.
    router.push({ name: 'master-groups' })
  } catch (e) {
    // Same group_in_use translation as MasterGroupsView's own delete
    // handler -- the backend's message names the blocking practice(s) in
    // English, not something to relay verbatim to a human.
    if (e instanceof ApiResponseError && e.code === 'group_in_use') {
      toast.error(
        'Эта группа — единственная аудитория одной из практик. Сначала измените аудиторию практики, затем удалите группу.',
      )
    } else {
      toast.error(extractApiError(e, 'Не удалось удалить группу'))
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

/* Owner Q4 (ПРОМТ №610): optional description, under the group name.
   Absent entirely (v-if) when empty -- no placeholder text, no reserved
   height, per the owner's own "no dead space" rule. */
.group-detail__description {
  font-family: var(--font-body);
  font-size: var(--text-xs);
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
   (ПРОМТ №609): the decorative magnifier button removed -- it was
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

/* G5 (ПРОМТ №609): white glow via the existing --velo-shadow-glow token
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
