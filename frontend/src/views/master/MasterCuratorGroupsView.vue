<!--
  VELO Frontend -- MasterCuratorGroupsView (schools FE-20 / GT P3)

  "Группы мастеров" -- the master zone's entry into SCHOOLS (route
  /master/curator-groups, dashboard row under «Мои группы»). Deliberately a
  different name from that row: «Мои группы» there means the master's CUSTOM
  STUDENT groups (master_group), a different entity entirely.

  Same GET /curator-groups/mine payload as the user list, but sectioned by
  MY relation: «Я куратор» first, «Я участник» second (backend order:
  curated first, then join time -- the split only groups it).

  The «+» in the header is ALWAYS visible: any verified master can create a
  school -- that is the whole grant mechanism (creating the row IS becoming
  a curator; no admin issues the right). The route's masterStatusGuard has
  already verified the viewer by the time this mounts.
-->

<template>
  <div class="mcg">
    <VHeader title="Группы мастеров" show-back @back="router.push({ name: 'master-dashboard' })">
      <template #action>
        <button
          type="button"
          class="mcg__add-btn"
          aria-label="Новая школа"
          @click="router.push({ name: 'master-curator-group-create' })"
        >
          <IconPlusFilled :size="20" />
        </button>
      </template>
    </VHeader>

    <div class="mcg__content">
      <div v-if="loading" class="mcg__state">
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
        description="Создайте группу или вступите по ссылке от куратора."
      >
        <template #action>
          <VButton variant="primary" @click="router.push({ name: 'master-curator-group-create' })">
            Создать группу
          </VButton>
        </template>
      </VEmptyState>

      <template v-else>
        <template v-if="curated.length">
          <h2 class="velo-section-title mcg__section">Я куратор</h2>
          <CuratorGroupRow
            v-for="g in curated"
            :key="g.id"
            :group="g"
            @open="router.push({ name: 'master-curator-group', params: { id: $event } })"
          />
        </template>

        <template v-if="memberOnly.length">
          <h2 class="velo-section-title mcg__section">Я участник</h2>
          <CuratorGroupRow
            v-for="g in memberOnly"
            :key="g.id"
            :group="g"
            @open="router.push({ name: 'master-curator-group', params: { id: $event } })"
          />
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getMyCuratorGroups } from '@/api/curatorGroups'
import type { CuratorGroupMineItem } from '@/api/types'
import CuratorGroupRow from '@/components/shared/CuratorGroupRow.vue'
import IconPlusFilled from '@/components/icons/IconPlusFilled.vue'
import VButton from '@/components/ui/VButton.vue'
import VEmptyState from '@/components/ui/VEmptyState.vue'
import VHeader from '@/components/layout/VHeader.vue'
import VLoader from '@/components/ui/VLoader.vue'

const router = useRouter()

const loading = ref(true)
const error = ref(false)
const groups = ref<CuratorGroupMineItem[]>([])

const curated = computed(() => groups.value.filter((g) => g.relation === 'curator'))
const memberOnly = computed(() => groups.value.filter((g) => g.relation !== 'curator'))

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
.mcg {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.mcg__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mcg__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.mcg__section {
  margin-top: var(--space-2);
}

/* Same top-right add control MasterGroupsView uses (G3, PROMPT №609): a 40px
   primary circle flush with the header row's right edge. */
.mcg__add-btn {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.mcg__add-btn:active {
  opacity: 0.85;
}
</style>
