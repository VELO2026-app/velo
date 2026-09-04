<!--
  VELO Frontend -- UserCuratorGroupsView (schools FE-19 / GT P3)

  "Мои группы" for the user zone (route /user/groups, entry row in
  UserProfileView's «Аккаунт» section). A FLAT list of GET /curator-groups/mine
  -- curated first, then by join time, exactly as the backend orders it; no
  sectioning here (that is the master list's own distinction). Rows are the
  shared CuratorGroupRow; tap -> the school page in this zone.

  The honest empty state names the only way in: an invite link from a curator
  -- there is no catalogue and no search (v1 non-goal, owner-ruled).
-->

<template>
  <div class="ucg">
    <VHeader title="Мои группы" show-back @back="router.push({ name: 'user-profile' })" />

    <div class="ucg__content">
      <div v-if="loading" class="ucg__state">
        <VLoader size="lg" />
      </div>

      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить группы"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="load">Повторить</VButton>
        </template>
      </VEmptyState>

      <VEmptyState
        v-else-if="!groups.length"
        icon="group"
        title="Пока нет групп"
        description="Вступить в группу можно по ссылке от куратора."
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
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getMyCuratorGroups } from '@/api/curatorGroups'
import type { CuratorGroupMineItem } from '@/api/types'
import CuratorGroupRow from '@/components/shared/CuratorGroupRow.vue'
import VButton from '@/components/ui/VButton.vue'
import VEmptyState from '@/components/ui/VEmptyState.vue'
import VHeader from '@/components/layout/VHeader.vue'
import VLoader from '@/components/ui/VLoader.vue'

const router = useRouter()

const loading = ref(true)
const error = ref(false)
const groups = ref<CuratorGroupMineItem[]>([])

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    const res = await getMyCuratorGroups()
    groups.value = res.items
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
