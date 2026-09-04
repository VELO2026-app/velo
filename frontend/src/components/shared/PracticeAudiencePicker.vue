<!--
  VELO Frontend -- PracticeAudiencePicker (FE-24 / GT P5)

  The «Для кого практика» selector, extracted from the audience block that
  used to live (twice, drifting) in CreatePracticeView and EditPracticeView:
  a VRadioGroup of kinds plus, for the two targeted kinds, a VChip
  multi-select of this master's own targets.

  The fourth kind appears in the radio ONLY when `schools` is non-empty
  (audienceOptions, practiceOptions.ts) -- a master who belongs to no school
  sees the exact three options they always saw. Selecting A and B means
  "anyone in at least one of them", the same multiplicity group_ids has.

  Layout-neutral on purpose: the caller owns headings and wrappers (Create
  wraps this in its VCard section, Edit renders it flat under a field label)
  -- this component owns only the audience MECHANICS: kind, two id arrays,
  their empty states, and the single validation-error line.

  v-model:kind / v-model:groupIds / v-model:curatorGroupIds -- arrays are
  replaced immutably (a fresh array per toggle), never mutated in place, so
  the caller's reactivity and its own change-detection stay honest.
-->

<template>
  <div class="pap">
    <VRadioGroup v-model="kindModel" :options="options" />

    <template v-if="kindModel === 'groups'">
      <div v-if="groups.length" class="pap__chips">
        <VChip
          v-for="g in groups"
          :key="g.id"
          size="md"
          clickable
          :active="groupIds.includes(g.id)"
          @click="toggleGroup(g.id)"
        >
          {{ g.name }}
        </VChip>
      </div>
      <p v-else class="pap__empty">
        Пока нет ни одной группы. Создайте группу на экране «Мои группы».
      </p>
    </template>

    <template v-else-if="kindModel === 'curator_groups'">
      <div v-if="schools.length" class="pap__chips">
        <VChip
          v-for="s in schools"
          :key="s.id"
          size="md"
          clickable
          :active="curatorGroupIds.includes(s.id)"
          @click="toggleSchool(s.id)"
        >
          {{ s.name }}
        </VChip>
      </div>
      <!-- Defensive: the option is only offered when schools exist, so this
           is reachable only if the list emptied AFTER the kind was chosen
           (left the school in another tab). Honest text, no invented targets. -->
      <p v-else class="pap__empty">Нет школ, доступных для выбора.</p>
    </template>

    <!-- Review fix: the error belongs to the ACTIVE targeted kind only --
         after «Выберите хотя бы одну группу» a switch to «Публичная» clears
         the message instead of lying until the next submit. -->
    <span
      v-if="error && (kindModel === 'groups' || kindModel === 'curator_groups')"
      class="pap__error"
      >{{ error }}</span
    >
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { GroupListItem } from '@/api/groups'
import type { PracticeAudienceKind } from '@/api/types'
import { audienceOptions } from '@/utils/practiceOptions'
import VChip from '@/components/ui/VChip.vue'
import VRadioGroup from '@/components/ui/VRadioGroup.vue'

/** A school the master may target: id + display name only (from
 *  GET /curator-groups/mine filtered to relation curator|master upstream). */
export interface AudienceSchoolOption {
  id: string
  name: string
}

const props = defineProps<{
  /** The master's own custom student groups (kind === 'groups' targets). */
  groups: GroupListItem[]
  /** Eligible schools (kind === 'curator_groups' targets). */
  schools: AudienceSchoolOption[]
  /** Single validation-error line, shown for whichever kind is active. */
  error?: string
  /** T24-24 (PROMPT №639): Create relabels the 'students' option to «Все мои
   *  ученики» LOCALLY; Edit keeps the shared «Все ученики». A narrow seam,
   *  not a second options list -- everything else is identical. */
  studentsLabel?: string
}>()

const kindModel = defineModel<PracticeAudienceKind>('kind', { required: true })
const groupIds = defineModel<string[]>('groupIds', { required: true })
const curatorGroupIds = defineModel<string[]>('curatorGroupIds', { required: true })

const options = computed(() => {
  const base = audienceOptions(props.schools.length > 0)
  if (!props.studentsLabel) return base
  return base.map((o) => (o.value === 'students' ? { ...o, label: props.studentsLabel! } : o))
})

function toggleGroup(id: string): void {
  groupIds.value = groupIds.value.includes(id)
    ? groupIds.value.filter((x) => x !== id)
    : [...groupIds.value, id]
}

function toggleSchool(id: string): void {
  curatorGroupIds.value = curatorGroupIds.value.includes(id)
    ? curatorGroupIds.value.filter((x) => x !== id)
    : [...curatorGroupIds.value, id]
}
</script>

<style scoped>
.pap {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Inside Create's padding="none" VCard the radio brings its own padding;
   the chips below need the rail's horizontal inset to line up with it. */
.pap__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-1);
}

.pap__empty {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0;
  padding: 0 var(--space-3) var(--space-1);
}

.pap__error {
  font-size: var(--text-xs);
  color: var(--velo-error);
  padding: 0 var(--space-3);
}
</style>
