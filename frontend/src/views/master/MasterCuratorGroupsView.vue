<!--
  VELO Frontend -- MasterCuratorGroupsView (schools FE-20 / GT P3)

  "Группы мастеров" -- the master zone's entry into SCHOOLS (route
  /master/curator-groups, dashboard row under «Мои группы»). Deliberately a
  different name from that row: «Мои группы» there means the master's CUSTOM
  STUDENT groups (master_group), a different entity entirely.

  Same GET /curator-groups/mine payload as the user list, but sectioned by
  MY relation: «Я куратор» first, «Я участник» second (backend order:
  curated first, then join time -- the split only groups it).

  BE-18: the «+» is visible ONLY with the admin-issued right to
  found a school. The flag rides on GET /masters/me/curator-groups
  (can_create_groups) -- fetched in parallel with /mine, which still feeds
  the rows (it alone knows transfer_offered and the member sections).
  Without the right the «+» disappears and the empty state explains who
  issues it; the create ROUTE stays honest too -- a direct visit answers
  403 group_creation_not_allowed, which that screen renders as a refusal.
-->

<template>
  <div class="mcg">
    <VHeader title="Группы мастеров" show-back @back="router.push({ name: 'master-dashboard' })">
      <template #action>
        <button
          v-if="canCreate"
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
        v-else-if="!groups.length && canCreate"
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

      <!-- BE-18: no schools and no right to found one -- the only way in is
           an invite link, and the screen says who issues the right instead
           of offering a button that would only ever answer 403. -->
      <VEmptyState
        v-else-if="!groups.length"
        icon="group"
        title="Пока нет групп"
        description="Вступите по ссылке от куратора. Создавать школы может мастер, которому администратор выдал это право."
      />

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

      <!-- Membership is untouched by the right -- rows render either way;
           only the founding offer is gated (BE-18). -->
      <p v-if="!loading && !error && groups.length && !canCreate" class="mcg__hint">
        Создавать школы может мастер, которому администратор выдал это право.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getCuratorGroups, getMyCuratorGroups } from '@/api/curatorGroups'
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
/** BE-18: the admin-issued right to found a school. False is the honest
 *  default on a failed flag fetch -- an offered «+» that only ever answers
 *  403 is worse than a missing one. */
const canCreate = ref(false)

const curated = computed(() => groups.value.filter((g) => g.relation === 'curator'))
const memberOnly = computed(() => groups.value.filter((g) => g.relation !== 'curator'))

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    // Two parallel calls, one payload split: /mine feeds the rows (it alone
    // carries relation + transfer_offered), the curator list carries only
    // the create right -- a property of the master, not of any one school.
    // allSettled, because the two calls are NOT equal: /mine failing means
    // there is no screen, while the flag call failing only means no «+» --
    // rows plus the honest no-right hint is strictly better than an error
    // state over data we already hold.
    const [mineRes, listRes] = await Promise.allSettled([getMyCuratorGroups(), getCuratorGroups()])
    if (mineRes.status === 'rejected') throw mineRes.reason
    groups.value = mineRes.value.items
    canCreate.value =
      listRes.status === 'fulfilled' ? (listRes.value.can_create_groups ?? false) : false
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

.mcg__hint {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin: 0;
  padding: 0 var(--space-1);
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
