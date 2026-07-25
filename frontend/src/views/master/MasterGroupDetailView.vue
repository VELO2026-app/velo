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
-->

<template>
  <div class="group-detail">
    <VHeader :title="headerTitle" show-back @back="router.push({ name: 'master-groups' })" />

    <div class="group-detail__content">
      <div class="group-detail__search">
        <div class="group-detail__search-field">
          <VInput
            v-model="search"
            placeholder="Искать ученика..."
            aria-label="Искать ученика"
            @focus="onFieldFocus"
          />
        </div>
        <span class="group-detail__search-btn" aria-hidden="true"><IconSearch :size="20" /></span>
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
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
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
        >
          <!-- Empty-group invite CTA (P4, ПРОМТ №593): only for an actually
               empty CUSTOM group (no search filter active, kind==='custom')
               -- matches the backend's 400-on-system-slug, and a search-empty
               state should offer "clear the search", not "invite someone". -->
          <VButton
            v-if="!search && kind === 'custom'"
            size="sm"
            variant="outline"
            :loading="inviting"
            @click="onInviteClick"
          >
            Пригласить в группу
          </VButton>
        </VEmptyState>
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
  VAvatar,
  VListRow,
  VMenu,
  VMenuItem,
  VTag,
  VConfirmDialog,
} from '@/components/ui'
import { IconSearch, IconPlus, IconPen, IconCheck } from '@/components/icons'
// IconTrash is not re-exported from the icons barrel (same pattern as
// EntryView.vue's delete action) -- import the component file directly.
import IconTrash from '@/components/icons/IconTrash.vue'
import AddTagSheet from '@/components/shared/AddTagSheet.vue'
import AddToGroupSheet from '@/components/shared/AddToGroupSheet.vue'
import RemoveFromGroupSheet from '@/components/shared/RemoveFromGroupSheet.vue'
import { getGroupMembers, getGroups, unblockStudent, createGroupInvite } from '@/api/groups'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { GroupMemberItem, GroupListItem, GroupKind } from '@/api/groups'

const route = useRoute()
const router = useRouter()
const { onFieldFocus } = useKeyboardFieldScroll()

const groupId = computed(() => String(route.params.id))
const groupName = computed(() => String(route.query.name ?? ''))
const headerTitle = computed(() => `Группа "${groupName.value}"`)

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

// This master's custom groups -- feeds AddToGroupSheet / RemoveFromGroupSheet's
// chip palette. Loaded once; independent of the members list/search.
const customGroups = ref<GroupListItem[]>([])
async function loadCustomGroups(): Promise<void> {
  try {
    const res = await getGroups()
    customGroups.value = res.items.filter((g) => g.kind === 'custom')
  } catch {
    customGroups.value = []
  }
}

onMounted(() => {
  load()
  loadCustomGroups()
})

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
// -- Invite (P4, ПРОМТ №593; empty-group CTA) --
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

.group-detail__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* Search: same DS pattern as MasterStudentsView (VInput glass pill + magnifier). */
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

.group-detail__search-field :deep(.v-input__field) {
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
}

.group-detail__search-btn {
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
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
