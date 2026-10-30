<!--
  VELO Frontend -- SchoolsView (tz-curator.md §1.2-1.4, curator flow)

  The «Школы» TAB's own screen (route /user/schools, name user-schools):
  the dock tab is visible only to curators (UserShell filters by the
  schoolsHub store), and this hub is where it lands.

  Per the owner's mockups (Design_prototype/mockups/schools-*.png):
    - no schools -> the default screen with the CTA «Создать школу»;
    - schools -> a FLAT list of cards (the schools I PARTICIPATE in --
      FE-93: /mine's curated rows are the master list's «Я куратор» section
      and every management surface behind them 403s outside master mode, so
      the user zone lists memberships only, backend join order). The
      sectioned list of the master zone (MasterCuratorGroupsView) keeps its
      own shape -- different screens answer different questions.
    - the search pill is deliberately NOT rendered in v1 (no discovery
      backend; tz-curator.md §1.3 / захоронка §7.1 №1).

  States are the list canon: loader -> error + retry -> empty -> rows.
  /curator-groups/mine is unpaginated (whole list in one response), so the
  screen single-loads -- the same canon MasterCuratorGroupsView ships.
-->

<template>
  <div class="schools">
    <VHeader :title="t('user.screens.schools.title')">
      <template #action>
        <!-- BE-18: the «+» is the admin-issued founding right; false is the
             honest default on a failed flag fetch (no «+» beats a 403 «+»). -->
        <button
          v-if="canCreate"
          type="button"
          class="schools__add-btn"
          :aria-label="t('user.screens.schools.create.title')"
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
        :title="t('school.loadFailed')"
        :description="t('user.screens.schools.loadFailedHint')"
      >
        <template #action>
          <VButton variant="outline" @click="load">{{ t('common.retry') }}</VButton>
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
          {{ t('user.screens.schools.create.title') }}
        </VButton>
      </div>

      <!-- Protective variant (§1.3: not the mockup's state): a settled
           non-curator here means the right was revoked after the tab probe --
           plain text: join by link, the right comes from the admin. -->
      <VEmptyState
        v-else-if="!schools.length"
        icon="group"
        :title="t('user.screens.schools.empty.title')"
        :description="t('user.screens.schools.empty.text')"
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
import { t } from '@/locales'
import { computed, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useQuery } from '@/composables/useQuery'
import { userSchoolsQuery } from '@/composables/queries'
import CuratorGroupRow from '@/components/shared/CuratorGroupRow.vue'
import { IconPlusFilled } from '@/components/icons'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'

const router = useRouter()
const authStore = useAuthStore()

// Tab screen: the list lives in the screen-data cache (useQuery), so a
// return through the dock renders the schools at once and refreshes them in
// the background (staleTime 0 -- a just-joined school shows up on the next
// visit) instead of a spinner on every visit.
const schoolsQuery = useQuery(userSchoolsQuery(authStore.role ?? ''))
// Kept alive as a tab root (TabRouterView): a return revalidates quietly
// (the shown data stays). The first activation is the mount itself.
let activations = 0
onActivated(() => {
  if (activations++ > 0) void schoolsQuery.revalidate()
})
const loading = schoolsQuery.isPending
/** Only an error with nothing to show replaces the list. */
const error = computed(() => schoolsQuery.error.value != null && !schoolsQuery.data.value)
const schools = computed(() => schoolsQuery.data.value?.schools ?? [])
/** BE-18: the admin-issued right to found a school. False is the honest
 *  default on a failed flag fetch -- an offered «+» that only ever answers
 *  403 is worse than a missing one. */
const canCreate = computed(() => schoolsQuery.data.value?.canCreate ?? false)

function load(): void {
  void schoolsQuery.refresh()
}
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
