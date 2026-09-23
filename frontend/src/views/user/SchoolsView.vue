<!--
  VELO Frontend -- SchoolsView (tz-curator.md §1.2-1.4, curator flow)

  The «Школы» TAB's own screen (route /user/schools, name user-schools):
  the dock tab is visible only to curators (UserShell filters by the
  schoolsHub store), and this hub is where it lands.

  Per the owner's mockups (Design_prototype/mockups/schools-*.png):
    - no schools -> the default screen with the CTA «Создать школу»;
    - schools -> a FLAT list of cards (curated + participated in one run,
      backend /mine order: curated first, then join time). The sectioned
      lists of phase 1 (MasterCuratorGroupsView / UserCuratorGroupsView)
      keep their own shape -- different screens answer different questions.
    - the search pill is deliberately NOT rendered in v1 (no discovery
      backend; tz-curator.md §1.3 / захоронка §7.1 №1).

  States are the list canon: loader -> error + retry -> empty -> rows.
  /curator-groups/mine is unpaginated (whole list in one response), so the
  screen single-loads -- the same canon MasterCuratorGroupsView ships.
-->

<template>
  <div class="schools">
    <VHeader title="Школы">
      <template #action>
        <!-- BE-18: the «+» is the admin-issued founding right; false is the
             honest default on a failed flag fetch (no «+» beats a 403 «+»). -->
        <button
          v-if="canCreate"
          type="button"
          class="schools__add-btn"
          aria-label="Новая школа"
          @click="router.push({ name: 'master-curator-group-create' })"
        >
          <IconPlusFilled :size="20" />
        </button>
      </template>
    </VHeader>

    <div class="schools__content">
      <div v-if="loading" class="schools__state">
        <VLoader size="lg" />
      </div>

      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить школы"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="load">Повторить</VButton>
        </template>
      </VEmptyState>

      <!-- §1.3, the main curator-empty state: a QUIET screen -- the global
           background with ONE CTA in the visual centre. No VEmptyState, no
           invented illustration, no «Пока нет школ» copy, no search pill
           (v1 has no discovery backend; захоронка §7.1 №1). -->
      <div v-else-if="!schools.length && canCreate" class="schools__empty">
        <VButton
          variant="primary"
          block
          @click="router.push({ name: 'master-curator-group-create' })"
        >
          Создать школу
        </VButton>
      </div>

      <!-- Protective variant (§1.3: not the mockup's state): a settled
           non-curator here means the right was revoked after the tab probe --
           plain text: join by link, the right comes from the admin. -->
      <VEmptyState
        v-else-if="!schools.length"
        icon="group"
        title="Пока нет школ"
        description="Вступите по ссылке от куратора. Создавать школы может мастер, которому администратор выдал это право."
      />

      <template v-else>
        <CuratorGroupRow
          v-for="g in schools"
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
import { getCuratorGroups, getMyCuratorGroups } from '@/api/curatorGroups'
import type { CuratorGroupMineItem } from '@/api/types'
import CuratorGroupRow from '@/components/shared/CuratorGroupRow.vue'
import { IconPlusFilled } from '@/components/icons'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'

const router = useRouter()

const loading = ref(true)
const error = ref(false)
const schools = ref<CuratorGroupMineItem[]>([])
/** BE-18: the admin-issued right to found a school. False is the honest
 *  default on a failed flag fetch -- an offered «+» that only ever answers
 *  403 is worse than a missing one. */
const canCreate = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    // Two parallel calls, one payload split -- the MasterCuratorGroupsView
    // recipe verbatim: /mine feeds the rows (relation + transfer_offered ride
    // only here), the curator list carries the create right. allSettled,
    // because the two calls are NOT equal: /mine failing means there is no
    // screen, while the flag call failing only means no «+».
    const [mineRes, listRes] = await Promise.allSettled([getMyCuratorGroups(), getCuratorGroups()])
    if (mineRes.status === 'rejected') throw mineRes.reason
    schools.value = mineRes.value.items
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
.schools {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.schools__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.schools__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* §1.3 curator-empty: the CTA sits in the visual centre of the quiet
   background -- the empty space around it IS the state. */
.schools__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* Round header «+» -- the MasterCuratorGroupsView recipe verbatim. */
.schools__add-btn {
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

.schools__add-btn:active {
  opacity: 0.85;
}
</style>
