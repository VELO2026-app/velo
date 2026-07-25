<!--
  VELO Frontend -- RemoveFromGroupSheet (Master GROUPS P2, ПРОМТ №591)

  "Удалить из группы" -- CUSTOM groups only (removal from «Ученики» is
  Block, P3; «Удалённые» is Unblock, P3 -- neither is offered here). Three
  modes (VRadioGroup, single choice):
    current  -- this one group only
    selected -- expands custom-group VChips, multi-select
    all      -- every custom group; note the student falls back to
                «Ученики» automatically (the derived group, nothing to do)

  "all" has no "list this student's groups" endpoint to call (P1 doesn't
  have one) -- it loops EVERY custom group and calls DELETE on each.
  removeGroupMember is idempotent-safe (a no-op 204 if the student isn't a
  member of a given group), so this reaches the exact same end state as a
  hypothetical dedicated endpoint would, without inventing one.
-->

<template>
  <VBottomSheet
    :open="open"
    title="Удалить из группы"
    save-label="Удалить"
    @save="onSave"
    @close="$emit('close')"
  >
    <p class="remove-from-group__name">{{ studentName }}</p>

    <VRadioGroup v-model="mode" :options="MODE_OPTIONS" />

    <template v-if="mode === 'selected'">
      <div class="remove-from-group__chips">
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
    </template>

    <p v-if="mode === 'all'" class="remove-from-group__note">
      Участник автоматически переносится в группу «Ученики»
    </p>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { VBottomSheet, VRadioGroup, VChip } from '@/components/ui'
import { removeGroupMember } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { GroupListItem } from '@/api/groups'

const props = defineProps<{
  open: boolean
  studentId: string
  studentName: string
  /** The group this sheet was opened from -- always a real custom group id
   *  (this sheet is only ever offered on a custom group's member row). */
  currentGroupId: string
  customGroups: GroupListItem[]
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()

const MODE_OPTIONS = [
  { value: 'current', label: 'Удалить из текущей группы' },
  { value: 'selected', label: 'Удалить из выбранных групп' },
  { value: 'all', label: 'Удалить из всех групп' },
]

const mode = ref<'current' | 'selected' | 'all'>('current')
const selected = ref<Set<string>>(new Set())

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      mode.value = 'current'
      selected.value = new Set()
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
  try {
    if (mode.value === 'current') {
      await removeGroupMember(props.currentGroupId, props.studentId)
    } else if (mode.value === 'selected') {
      if (selected.value.size === 0) {
        toast.error('Выберите хотя бы одну группу')
        return
      }
      await Promise.all(
        Array.from(selected.value).map((groupId) => removeGroupMember(groupId, props.studentId)),
      )
    } else {
      await Promise.all(props.customGroups.map((g) => removeGroupMember(g.id, props.studentId)))
    }
    toast.success('Удалено')
    emit('saved')
    emit('close')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить из группы'))
  }
}
</script>

<style scoped>
.remove-from-group__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-4);
}

.remove-from-group__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.remove-from-group__note {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: var(--space-3) 0 0;
}
</style>
