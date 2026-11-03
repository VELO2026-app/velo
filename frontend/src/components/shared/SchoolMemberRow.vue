<!--
  VELO Frontend -- SchoolMemberRow (tz-curator.md §1.11)

  One roster row on the school participants screen (§1.11, the screen of
  i18n:user.screens.schoolMembers.title, both switcher tabs): avatar + display name, the whole row one touch
  target that opens the member's school-context profile. No per-row
  actions by the same rule T24-19 established on MasterGroupDetailView:
  the curator's offer/remove live on the profile screens, a row only
  navigates.

  is_visible=false (a suspended master-member, I-4) renders as a
  temporarily-unavailable subtitle (i18n:shared.components.temporarilyHidden)
  instead of dropping the row: the
  membership is real and returns by itself when the admin re-verifies.
  For students the flag is always true (they have no MasterProfile).

  TWO ROW TYPES, one component (BE-76): the curator's roster rows carry
  is_visible / master_offer (SchoolMemberItem); a school master's rows
  are the plain SchoolRosterItem without them -- the server leaves
  suspended masters out of that list instead. The row tells the two apart by
  the PRESENCE of the curator's fields and renders no subtitle without them.
-->
<template>
  <VListRow :title="member.name" :subtitle="subtitle" clickable @click="$emit('open', member)">
    <template #lead>
      <VAvatar :name="member.name" :url="member.avatar_url ?? undefined" size="md" />
    </template>
  </VListRow>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import type { SchoolMemberItem, SchoolRosterItem } from '@/api/types'
import { masterOfferLabel } from '@/utils/masterOffers'
import { VAvatar, VListRow } from '@/components/ui'

const props = defineProps<{
  member: SchoolRosterItem | SchoolMemberItem
}>()

defineEmits<{
  open: [member: SchoolRosterItem]
}>()

const subtitle = computed((): string | undefined => {
  const member = props.member
  // A school master's row has no curator fields: nothing to say under it.
  if (!('is_visible' in member)) return undefined
  return (
    masterOfferLabel(member.master_offer) ??
    (member.is_visible ? undefined : t('shared.components.temporarilyHidden'))
  )
})
</script>
