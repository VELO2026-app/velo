<!--
  VELO Frontend -- CuratorGroupRow (schools FE-19/FE-20 / GT P3)

  One row of the "my schools" list, shared by BOTH zones' lists
  (UserCuratorGroupsView and MasterCuratorGroupsView -- same GET
  /curator-groups/mine payload, different sectioning around it).

  VListRow shell + the curator's avatar as the lead + two optional chips in
  the trailing slot:
    - relation chip: «Куратор» / «Мастер» (students get none -- the plain
      member is the default kind and a chip for everyone is noise);
    - transfer_offered chip: shown ONLY to the person being offered the
      school (the backend sends true only to them; the curator's own pending
      offer reads false here on purpose).
-->

<template>
  <VListRow clickable :title="group.name" :subtitle="subtitle" @click="$emit('open', group.id)">
    <template #lead>
      <VAvatar
        :name="group.curator.display_name || group.name"
        :url="group.curator.avatar_url ?? undefined"
      />
    </template>
    <template #trailing>
      <span class="cg-row__chips">
        <VChip v-if="relationChip" active>{{ relationChip }}</VChip>
        <VChip v-if="group.transfer_offered" class="cg-row__offer" active> Кураторство </VChip>
      </span>
    </template>
  </VListRow>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CuratorGroupMineItem } from '@/api/types'
import VAvatar from '@/components/ui/VAvatar.vue'
import VChip from '@/components/ui/VChip.vue'
import VListRow from '@/components/ui/VListRow.vue'

const props = defineProps<{
  group: CuratorGroupMineItem
}>()

defineEmits<{
  open: [id: string]
}>()

const subtitle = computed(() => {
  const parts = [`Куратор: ${props.group.curator.display_name || '—'}`]
  parts.push(`Мастеров: ${props.group.masters_count}`)
  parts.push(`Учеников: ${props.group.students_count}`)
  return parts.join(' · ')
})

/** Students are the unmarked default -- no chip. */
const relationChip = computed(() => {
  if (props.group.relation === 'curator') return 'Куратор'
  if (props.group.relation === 'master') return 'Мастер'
  return ''
})
</script>

<style scoped>
.cg-row__chips {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

/* The transfer-offer chip is the same shape as the relation chip but carries
   the peach attention tone -- it asks for a decision, not a label. Reuses
   the existing VBadge pair of tokens (glass-peach-40 / peach-700); the
   compound selector outspecifies VChip's own --active pair. */
.cg-row__chips :deep(.v-chip.cg-row__offer) {
  background: var(--velo-glass-peach-40);
  color: var(--velo-peach-700);
}
</style>
