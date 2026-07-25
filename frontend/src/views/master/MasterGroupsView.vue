<!--
  VELO Frontend -- MasterGroupsView (Master GROUPS P2, ПРОМТ №591)

  "Мои группы" -- replaces "Мои ученики" as the dashboard entry. Lists the
  two virtual groups («Ученики» always first, «Удалённые» last and omitted
  when empty) plus every custom group, in the order the backend returns
  (GET /masters/me/groups).

  Reuses VListRow (row shell), VMenu+VMenuItem (the per-custom-group «⋯»),
  VBottomSheet (rename), VConfirmDialog (delete confirm), VShowMore (the
  "+ ещё N групп" expander) -- no bespoke visual component, DS tokens only.

  Invite (P4, ПРОМТ №593): each row's «Пригласить в группу» calls POST
  .../invite, copies the returned link to the clipboard (B2 pattern, same as
  AdminMasterInviteView/MasterPromocodesView), and toasts. CUSTOM groups only
  -- the two virtual groups never render this action (see the v-if guard
  below), matching the backend's 400-on-system-slug.
-->

<template>
  <div class="groups">
    <VHeader title="Мои группы" show-back @back="router.push({ name: 'master-dashboard' })" />

    <div class="groups__content">
      <!-- Loading -->
      <div v-if="loading" class="groups__state">
        <VLoader size="lg" />
      </div>

      <!-- Error -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить группы"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>

      <template v-else>
        <div
          v-for="group in visibleGroups"
          :key="group.id"
          class="groups__row-wrap"
          role="button"
          tabindex="0"
          @click="openDetail(group)"
          @keydown.enter.space.prevent="openDetail(group)"
        >
          <VListRow :title="group.name" :subtitle="`Участников: ${group.members_count}`">
            <template #trailing>
              <div class="groups__row-actions" @click.stop>
                <button
                  v-if="group.kind === 'custom'"
                  type="button"
                  class="groups__invite-btn"
                  aria-label="Пригласить в группу"
                  :disabled="invitingId === group.id"
                  @click="copyGroupInvite(group.id)"
                >
                  <IconShare :size="20" />
                </button>
                <VMenu v-if="group.kind === 'custom'" ariaLabel="Меню группы">
                  <template #default="{ close }">
                    <VMenuItem
                      :icon="IconPen"
                      ariaLabel="Переименовать"
                      @click="onRenameClick(group, close)"
                    />
                    <VMenuItem
                      :icon="IconTrash"
                      ariaLabel="Удалить группу"
                      danger
                      @click="onDeleteClick(group, close)"
                    />
                  </template>
                </VMenu>
              </div>
            </template>
          </VListRow>
        </div>

        <VShowMore
          v-if="!expanded && hiddenCount > 0"
          :count="hiddenCount"
          :noun="plural(hiddenCount, 'группа', 'группы', 'групп')"
          @click="expanded = true"
        />

        <VEmptyState
          v-if="groups.length === 0"
          icon="group"
          title="Групп пока нет"
          description="Создайте первую группу учеников"
        />

        <button type="button" class="groups__add-btn" aria-label="Новая группа" @click="onCreate">
          <IconPlus :size="24" />
        </button>
      </template>
    </div>

    <!-- Rename (custom groups only) -->
    <VBottomSheet
      :open="!!renameTarget"
      title="Переименовать группу"
      save-label="Сохранить"
      @save="onRenameSave"
      @close="renameTarget = null"
    >
      <VInput v-model="renameName" label="Название" placeholder="Название группы" />
    </VBottomSheet>

    <!-- Delete confirm (custom groups only) -->
    <VConfirmDialog
      :open="!!deleteTarget"
      :message="deleteMessage"
      confirm-label="Удалить"
      danger
      :loading="deleting"
      @confirm="onDeleteConfirm"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VLoader,
  VEmptyState,
  VButton,
  VListRow,
  VMenu,
  VMenuItem,
  VBottomSheet,
  VInput,
  VConfirmDialog,
} from '@/components/ui'
import { IconShare, IconPen, IconPlus } from '@/components/icons'
// IconTrash is not re-exported from the icons barrel (same pattern as
// EntryView.vue's delete action) -- import the component file directly.
import IconTrash from '@/components/icons/IconTrash.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import { getGroups, renameGroup, deleteGroup, createGroupInvite } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { plural } from '@/utils/plural'
import type { GroupListItem } from '@/api/groups'

const router = useRouter()
const toast = useToast()

const groups = ref<GroupListItem[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await getGroups()
    groups.value = res.items
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Show the first 10; the rest hide behind "+ ещё N групп" (mirrors
// MasterStudentsView's identical STUDENTS_PREVIEW pattern).
const GROUPS_PREVIEW = 10
const expanded = ref(false)
const visibleGroups = computed((): GroupListItem[] =>
  expanded.value ? groups.value : groups.value.slice(0, GROUPS_PREVIEW),
)
const hiddenCount = computed((): number => Math.max(0, groups.value.length - GROUPS_PREVIEW))

function openDetail(group: GroupListItem): void {
  router.push({
    name: 'master-group-detail',
    params: { id: group.id },
    query: { name: group.name },
  })
}

function onCreate(): void {
  router.push({ name: 'master-group-create' })
}

// -- Invite (P4, ПРОМТ №593) --
const invitingId = ref<string | null>(null)
async function copyGroupInvite(groupId: string): Promise<void> {
  if (invitingId.value) return
  invitingId.value = groupId
  try {
    const res = await createGroupInvite(groupId)
    // Clipboard needs no backend — write the link straight to the
    // clipboard (B2, same pattern as AdminMasterInviteView/
    // MasterPromocodesView; no shared clipboard composable exists yet).
    await navigator.clipboard.writeText(res.invite_url)
    toast.success('Ссылка скопирована')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось создать ссылку'))
  } finally {
    invitingId.value = null
  }
}

// -- Rename --
const renameTarget = ref<GroupListItem | null>(null)
const renameName = ref('')
function openRename(group: GroupListItem): void {
  renameTarget.value = group
  renameName.value = group.name
}
/** Single-expression wrapper for the VMenu default-slot's `close` (a
 *  semicolon-joined inline handler here would be reformatted across
 *  lines by prettier and lose its semicolon, breaking the Vue template
 *  compiler -- one function call per @click avoids that entirely). */
function onRenameClick(group: GroupListItem, close: () => void): void {
  openRename(group)
  close()
}
async function onRenameSave(): Promise<void> {
  const target = renameTarget.value
  if (!target || !renameName.value.trim()) return
  try {
    await renameGroup(target.id, renameName.value.trim())
    renameTarget.value = null
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось переименовать группу'))
  }
}

// -- Delete --
const deleteTarget = ref<GroupListItem | null>(null)
const deleting = ref(false)
const deleteMessage = computed((): string =>
  deleteTarget.value
    ? `Удалить группу «${deleteTarget.value.name}»? Участники вернутся в группу «Ученики».`
    : '',
)
function openDelete(group: GroupListItem): void {
  deleteTarget.value = group
}
function onDeleteClick(group: GroupListItem, close: () => void): void {
  openDelete(group)
  close()
}
async function onDeleteConfirm(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    await deleteGroup(target.id)
    deleteTarget.value = null
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить группу'))
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.groups {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.groups__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.groups__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.groups__row-wrap {
  cursor: pointer;
}

.groups__row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* Round icon action button -- same recipe as MasterStudentsView's
   .students__msg / VMenuItem (size-46, primary fill, white glyph). No new
   visual component, just the established token recipe reused inline. */
.groups__invite-btn {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.groups__invite-btn:active {
  opacity: 0.85;
}

.groups__invite-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.groups__add-btn {
  align-self: center;
  margin-top: var(--space-2);
  width: var(--velo-size-56);
  height: var(--velo-size-56);
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--velo-shadow-glow);
  transition: opacity var(--transition-fast);
}

.groups__add-btn:active {
  opacity: 0.85;
}
</style>
