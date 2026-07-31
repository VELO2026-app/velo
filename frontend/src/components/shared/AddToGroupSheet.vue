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

  T24-32..37 (ПРОМТ №634): smaller title (VBottomSheet's compactTitle) +
  hairline-stroke weight (.velo-text-strong) + TargetUserCard plinth +
  bolder "Выберите группу" heading (bumped --text-sm -> --text-base, PLUS
  the same stroke) + chips KEPT (RULE 1 -- the owner's words win over the
  design file's checkbox-list drawing) with a new darker "already a member"
  VChip state (T24-35) + the optional removal toggle rebuilt as a REAL
  VCheckbox (T24-36 -- the written item + the measured spec both say
  checkbox; it was a VSwitch) + Rule 2's ONE deliberate exception: cancel
  CORAL on the left, save (still labelled "Добавить", never "Переместить" --
  owner-settled, see the module docstring above) BLUE on the right.
-->

<template>
  <VBottomSheet
    :open="open"
    title="Добавить в группу"
    compact-title
    title-strong
    save-label="Добавить"
    cancel-label="Отмена"
    cancel-variant="danger"
    save-variant="primary"
    @save="onSave"
    @close="$emit('close')"
  >
    <TargetUserCard :name="studentName" :avatar-url="avatarUrl" class="add-to-group__card" />

    <p class="add-to-group__label">Выберите группу</p>
    <div v-if="customGroups.length" class="add-to-group__chips">
      <VChip
        v-for="g in customGroups"
        :key="g.id"
        size="md"
        clickable
        :active="selected.has(g.id)"
        :existing="existingGroupIds.includes(g.id)"
        @click="toggle(g.id)"
      >
        {{ g.name }}
      </VChip>
    </div>
    <p v-else class="add-to-group__empty">Пока нет ни одной группы</p>

    <VCheckbox
      v-if="showRemoveToggle"
      v-model="removeFromCurrent"
      label="Удалить из текущей группы"
      class="add-to-group__toggle"
    />
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { VBottomSheet, VChip, VCheckbox } from '@/components/ui'
import TargetUserCard from './TargetUserCard.vue'
import { addGroupMember, removeGroupMember } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { GroupListItem } from '@/api/groups'

const props = withDefaults(
  defineProps<{
    open: boolean
    studentId: string
    studentName: string
    avatarUrl?: string | null
    /** The master's custom groups only -- never the two virtuals. */
    customGroups: GroupListItem[]
    /** Group ids the student is ALREADY a member of, among `customGroups`
     *  (T24-35) -- drives VChip's darker "existing" state. Best-effort:
     *  an empty array (the default) just means no chip gets the darker
     *  mark, never a broken sheet. */
    existingGroupIds?: string[]
    /** The custom group this sheet was opened FROM, if any (powers the
     *  optional removal toggle). Null/undefined when opened from «Ученики»
     *  or «Удалённые» -- no toggle in that case. */
    currentGroupId?: string | null
  }>(),
  {
    existingGroupIds: () => [],
  },
)

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const selected = ref<Set<string>>(new Set())
const removeFromCurrent = ref(false)

// T24-36 (ПРОМТ №634, real bug found while wiring the checkbox): this was a
// ref reset by the watcher below, but `v-if="addTarget"` at the call site
// (MasterGroupDetailView.vue) means the parent DESTROYS and RECREATES this
// whole component on every open -- a plain (non-immediate) watch on `open`
// never fires for a freshly mounted instance whose `open` prop starts at
// `true` (there is no false->true TRANSITION within this instance's
// lifetime to observe). `selected`/`removeFromCurrent` never showed this --
// their "reset" value already equals their ref's own initial default -- but
// showRemoveToggle's reset (`!!props.currentGroupId`) can differ from its
// `false` initial value, so the toggle silently never appeared. A computed
// derived straight from the prop has no reset-timing question at all.
const showRemoveToggle = computed(() => !!props.currentGroupId)

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
.add-to-group__card {
  margin-bottom: var(--space-4);
}

/* T24-34: bumped --text-sm (15px) -> --text-base (18px, the measured spec)
   + the same hairline-stroke faux-bold as the title. */
.add-to-group__label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
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

/* T24-36: was a VSwitch in a manual space-between label row; VCheckbox owns
   its own internal box+label layout, so only spacing is needed here now. */
.add-to-group__toggle {
  margin-top: var(--space-3);
}
</style>
