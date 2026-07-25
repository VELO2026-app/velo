<!--
  VELO Frontend -- AddToGroupSheet (Master GROUPS P2, ПРОМТ №591)

  "Добавить в группу" -- add-access, NOT move (owner-settled: the title is
  deliberately "Добавить", never "Переместить"). Multi-select VChips over
  the master's CUSTOM groups; an optional "Удалить из текущей группы" toggle
  only shown when opened FROM a custom group (removal from «Ученики» is
  Block, P3 -- never offered here).

  POST /groups/{id}/members for every selected group, then (if the toggle
  is on) DELETE from currentGroupId. Errors from either step surface as a
  toast; a partial failure still calls `saved` so the parent reloads and
  shows the real resulting state.
-->

<template>
  <VBottomSheet
    :open="open"
    title="Добавить в группу"
    save-label="Добавить"
    @save="onSave"
    @close="$emit('close')"
  >
    <p class="add-to-group__name">{{ studentName }}</p>

    <p class="add-to-group__label">Выберите группу</p>
    <div v-if="customGroups.length" class="add-to-group__chips">
      <VChip
        v-for="g in customGroups"
        :key="g.id"
        size="md"
        clickable
        :active="selected.has(g.id)"
        @click="toggle(g.id)"
      >
        {{ g.name }}
      </VChip>
    </div>
    <p v-else class="add-to-group__empty">Пока нет ни одной группы</p>

    <label v-if="showRemoveToggle" class="add-to-group__toggle">
      <span>Удалить из текущей группы</span>
      <VSwitch v-model="removeFromCurrent" aria-label="Удалить из текущей группы" />
    </label>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { VBottomSheet, VChip, VSwitch } from '@/components/ui'
import { addGroupMember, removeGroupMember } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { GroupListItem } from '@/api/groups'

const props = defineProps<{
  open: boolean
  studentId: string
  studentName: string
  /** The master's custom groups only -- never the two virtuals. */
  customGroups: GroupListItem[]
  /** The custom group this sheet was opened FROM, if any (powers the
   *  optional removal toggle). Null/undefined when opened from «Ученики»
   *  or «Удалённые» -- no toggle in that case. */
  currentGroupId?: string | null
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const selected = ref<Set<string>>(new Set())
const removeFromCurrent = ref(false)

const showRemoveToggle = ref(false)
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selected.value = new Set()
      removeFromCurrent.value = false
      showRemoveToggle.value = !!props.currentGroupId
    }
  },
)

function toggle(groupId: string): void {
  const next = new Set(selected.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  selected.value = next
}

async function onSave(): Promise<void> {
  if (selected.value.size === 0) {
    toast.error('Выберите хотя бы одну группу')
    return
  }
  try {
    await Promise.all(
      Array.from(selected.value).map((groupId) => addGroupMember(groupId, props.studentId)),
    )
    if (removeFromCurrent.value && props.currentGroupId) {
      await removeGroupMember(props.currentGroupId, props.studentId)
    }
    toast.success('Добавлено')
    emit('saved')
    emit('close')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось добавить в группу'))
  }
}
</script>

<style scoped>
.add-to-group__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-4);
}

.add-to-group__label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-2);
}

.add-to-group__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.add-to-group__empty {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  margin: 0 0 var(--space-4);
}

.add-to-group__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}
</style>
