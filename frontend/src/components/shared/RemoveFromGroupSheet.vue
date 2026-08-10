<!--
  VELO Frontend -- RemoveFromGroupSheet (Master GROUPS P2, PROMPT №591)

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

  T24-25/26/27 (PROMPT №634): smaller title (VBottomSheet's own compactTitle,
  PROMPT №609 -- already existed, just unused here) + hairline-stroke weight
  (the app-wide .velo-text-strong utility) + the student on the shared
  TargetUserCard plinth (was a plain name paragraph) + an explicit "Отмена"
  beside "Удалить" (VBottomSheet's cancelLabel, PROMPT №610 -- its default
  paired-row colours are ALREADY blue-cancel/coral-save, which is exactly
  Rule 2's position-based colour rule; no colour override needed here).

  T24-10 (PROMPT №638): `currentGroupId` widened to optional -- the student
  PROFILE'S own "..." menu (MasterStudentProfileView) opens this same sheet
  with no single-group context to be "current" (the profile isn't scoped to
  any one group the way a member row is). The "current" radio option is
  simply omitted when there is none; "selected" / "all" cover the profile
  case fully. The row usage (MasterGroupDetailView) is untouched -- it still
  always passes a real id, so its default mode ('current') and behaviour are
  byte-identical to before.
-->

<template>
  <VBottomSheet
    :open="open"
    title="Удалить из группы"
    compact-title
    title-strong
    save-label="Удалить"
    cancel-label="Отмена"
    @save="onSave"
    @close="$emit('close')"
  >
    <TargetUserCard :name="studentName" :avatar-url="avatarUrl" class="remove-from-group__card" />

    <VRadioGroup v-model="mode" :options="modeOptions" />

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
import { computed, ref, watch } from 'vue'
import { VBottomSheet, VRadioGroup, VChip } from '@/components/ui'
import TargetUserCard from './TargetUserCard.vue'
import { removeGroupMember } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { GroupListItem } from '@/api/groups'

const props = defineProps<{
  open: boolean
  studentId: string
  studentName: string
  avatarUrl?: string | null
  /** The group this sheet was opened from, when there is one -- a member
   *  row always has a real custom group id. T24-10: the student profile's
   *  own menu opens this sheet with no single-group context, so this is
   *  optional; the "current" radio option is omitted when absent. */
  currentGroupId?: string | null
  customGroups: GroupListItem[]
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()

const ALL_MODE_OPTIONS = [
  { value: 'current', label: 'Удалить из текущей группы' },
  { value: 'selected', label: 'Удалить из выбранных групп' },
  { value: 'all', label: 'Удалить из всех групп' },
]

// No currentGroupId (profile menu, T24-10) -- drop the "current" option,
// there is no group to call it. Row usage always has an id, so this stays
// the full three-option list there, unchanged.
const modeOptions = computed(() =>
  props.currentGroupId ? ALL_MODE_OPTIONS : ALL_MODE_OPTIONS.filter((o) => o.value !== 'current'),
)

const mode = ref<'current' | 'selected' | 'all'>('current')
const selected = ref<Set<string>>(new Set())

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      mode.value = props.currentGroupId ? 'current' : 'selected'
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
      // Reachable only when currentGroupId is set: modeOptions omits
      // "current" without it, and the open-watcher above never selects it.
      if (!props.currentGroupId) return
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
.remove-from-group__card {
  margin-bottom: var(--space-4);
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
