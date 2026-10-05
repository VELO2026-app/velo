<!--
  VELO Frontend -- CuratorGroupRow (schools FE-19/FE-20 / GT P3; §1.4 rework)

  One school row of the lists, shared by BOTH zones' sectioned lists
  (UserCuratorGroupsView / MasterCuratorGroupsView) and, since tz-curator.md
  §1.4, by the «Школы» tab hub (SchoolsView).

  The §1.4 contract (schools-list.png, text contract in tz-curator.md):
    - a SQUARE school logo (rounded corners, NOT a round avatar) as the lead:
      the generated SchoolMandalaBadge once the branding hash resolves (§5),
      an uploaded avatar_url over it, VAvatar initials in the interim;
    - the name on one line, and under it EXACTLY ONE compact line of two
      icon+number pairs -- students (IconUsers) first, then masters
      (IconMeditation). The numbers are NOT duplicated on the right and NOT
      spelled out as words;
    - the mockup has no relation chip and no chevron; the one surviving
      badge is transfer_offered («Кураторство», compact, peach) -- it must
      not displace the counters line (§1.4);
    - the right third carries the light branding crop (SchoolBrandBanner
      variant="row") that fades into the white card (§5).
-->

<template>
  <button type="button" class="cg-row" @click="$emit('open', group.id)">
    <!-- The branding crop fades into the white card behind the text column. -->
    <SchoolBrandBanner
      v-if="brandingHash"
      :hash="brandingHash"
      variant="row"
      class="cg-row__brand"
    />
    <VAvatar
      v-if="group.avatar_url"
      class="cg-row__logo"
      square
      size="lg"
      :name="group.name"
      :url="group.avatar_url"
    />
    <SchoolMandalaBadge
      v-else-if="brandingHash"
      class="cg-row__logo"
      :hash="brandingHash"
      :size="64"
    />
    <VAvatar v-else class="cg-row__logo" square size="lg" :name="group.name" />
    <span class="cg-row__text">
      <span class="cg-row__name">{{ group.name }}</span>
      <span class="cg-row__stats">
        <span class="cg-row__stat">
          <IconUsers :size="13" />
          {{ group.students_count }}
        </span>
        <span class="cg-row__stat">
          <IconMeditation :size="13" />
          {{ group.masters_count }}
        </span>
      </span>
    </span>
    <VChip v-if="group.transfer_offered" class="cg-row__offer" active> Кураторство </VChip>
  </button>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { CuratorGroupMineItem } from '@/api/types'
import { schoolHashFromName } from '@/utils/schoolBranding'
import { IconMeditation, IconUsers } from '@/components/icons'
import { VAvatar, VChip } from '@/components/ui'
import SchoolBrandBanner from '@/components/shared/SchoolBrandBanner.vue'
import SchoolMandalaBadge from '@/components/shared/SchoolMandalaBadge.vue'

const props = defineProps<{
  group: CuratorGroupMineItem
}>()

defineEmits<{
  open: [id: string]
}>()

// §5.2: no branding_hash field on the payload yet -- variant A, the client
// derives it from the name (async: one microtask after mount).
const brandingHash = ref<string | null>(null)
onMounted(() => {
  void schoolHashFromName(props.group.name).then((h) => {
    brandingHash.value = h
  })
})
</script>

<style scoped>
/* The §1.4 card: same white plate recipe as VListRow (tokens only), fully
   clickable, no chevron. Relative -- the branding crop is pinned inside. */
.cg-row {
  position: relative;
  overflow: hidden;
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  text-align: left;
  font-family: var(--font-body);
  cursor: pointer;
}

.cg-row:active {
  opacity: 0.85;
}

/* The light branding crop stays behind the content (§1.4: it must not read
   as a photo and never catches taps -- both are baked into the component). */
.cg-row__brand {
  z-index: 0;
}

.cg-row__logo {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
}

.cg-row__text {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.cg-row__name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The one counters line: students then masters, icon+number pairs, no words. */
.cg-row__stats {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}

.cg-row__stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  white-space: nowrap;
}

/* The transfer-offer chip is the same shape as the old relation chip but
   carries the peach attention tone -- it asks for a decision, not a label.
   Reuses the existing VBadge pair of tokens (glass-peach-40 / peach-700); the
   compound selector outspecifies VChip's own --active pair. */
.cg-row :deep(.v-chip.cg-row__offer) {
  background: var(--velo-glass-peach-40);
  color: var(--velo-peach-700);
}
</style>
