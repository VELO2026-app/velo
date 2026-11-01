<!--
  VELO Frontend -- UserCuratorGroupsView (schools FE-19 / GT P3)

  «Мои школы» for the user zone (route /user/groups, entry row in
  UserProfileView's «Аккаунт» section). A FLAT list of GET /curator-groups/mine
  -- the schools I PARTICIPATE in, by join time. FE-93: /mine's curated rows
  are the master list's «Я куратор» section and every management surface
  behind them 403s outside master mode, so this zone lists memberships only
  (a curator switched to user mode reads as an ordinary member). Rows are
  the shared CuratorGroupRow; tap -> the school page in this zone.

  The honest empty state names the only way in: an invite link from a curator
  -- there is no catalogue and no search (v1 non-goal, owner-ruled).
-->

<template>
  <div class="ucg">
    <VHeader
      :title="t('user.screens.userCuratorGroups.title')"
      show-back
      @back="router.push({ name: 'user-profile' })"
    />

    <div class="ucg__content">
      <div v-if="loading" class="ucg__state">
        <VLoader size="lg" />
      </div>

      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="t('school.loadFailed')"
        :description="t('user.screens.userCuratorGroups.loadFailedHint')"
      >
        <template #action>
          <VButton variant="outline" @click="load">{{ t('common.retry') }}</VButton>
        </template>
      </VEmptyState>

      <VEmptyState
        v-else-if="!groups.length"
        icon="group"
        :title="t('user.screens.userCuratorGroups.empty.title')"
        :description="t('user.screens.userCuratorGroups.empty.text')"
      />

      <template v-else>
        <CuratorGroupRow
          v-for="g in groups"
          :key="g.id"
          :group="g"
          @open="router.push({ name: 'user-curator-group', params: { id: $event } })"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getMyCuratorGroups } from '@/api/curatorGroups'
import type { CuratorGroupMineItem } from '@/api/types'
import CuratorGroupRow from '@/components/shared/CuratorGroupRow.vue'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'

const router = useRouter()

const loading = ref(true)
const error = ref(false)
const groups = ref<CuratorGroupMineItem[]>([])

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    const res = await getMyCuratorGroups()
    // FE-93: this zone lists the schools I PARTICIPATE in -- the curated
    // rows /mine still returns (relation is role-independent) are the
    // master list's «Я куратор» section.
    groups.value = res.items.filter((g) => g.relation !== 'curator')
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ucg {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.ucg__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ucg__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}
</style>
