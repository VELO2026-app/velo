<!--
  VELO Frontend -- SchoolMemberRow (tz-curator.md §1.11)

  One roster row on the school participants screen (§1.11 «Участники», both
  switcher tabs): avatar + display name, the whole row one touch
  target that opens the member's school-context profile. No per-row
  actions by the same rule T24-19 established on MasterGroupDetailView:
  the curator's offer/remove live on the profile screens, a row only
  navigates.

  is_visible=false (a suspended master-member, I-4) renders as a
  «Временно недоступен» subtitle instead of dropping the row: the
  membership is real and returns by itself when the admin re-verifies.
  For students the flag is always true (they have no MasterProfile).
-->
<template>
  <VListRow :title="member.name" :subtitle="subtitle" clickable @click="$emit('open', member)">
    <template #lead>
      <VAvatar :name="member.name" :url="member.avatar_url ?? undefined" size="md" />
    </template>
  </VListRow>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CuratorGroupMemberItem } from '@/api/types'
import { masterOfferLabel } from '@/utils/masterOffers'
import { VAvatar, VListRow } from '@/components/ui'

const props = defineProps<{
  member: CuratorGroupMemberItem
}>()

defineEmits<{
  open: [member: CuratorGroupMemberItem]
}>()

const subtitle = computed(
  () =>
    masterOfferLabel(props.member.master_offer) ??
    (props.member.is_visible ? undefined : 'Временно недоступен'),
)
</script>
