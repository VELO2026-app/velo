<!--
  VELO Frontend -- MasterSchoolsView (schools FE-20 / GT P3)

  The schools screen (i18n:masterScreens.masterSchools.title) -- the master
  zone's entry into SCHOOLS (route /master/schools, dashboard row under
  i18n:masterScreens.masterDashboard.myGroups).

  Same GET /schools/mine payload as the user list, but sectioned by
  MY relation: the curator tab (i18n:masterScreens.masterSchools.tab.curator)
  first, the member tab (i18n:masterScreens.masterSchools.tab.member) second
  (backend order: curated first, then join time -- the split only groups it).

  BE-18: the «+» is visible ONLY with the admin-issued right to
  found a school. The flag rides on GET /masters/me/schools
  (can_create_schools) -- fetched in parallel with /mine, which still feeds
  the rows (it alone knows transfer_offered and the member sections).
  Without the right the «+» disappears and the empty state explains who
  issues it; the create ROUTE stays honest too -- a direct visit answers
  403 school_creation_not_allowed, which that screen renders as a refusal.
-->

<template>
  <div class="mcg">
    <VHeader
      :title="t('masterScreens.masterSchools.title')"
      show-back
      @back="router.push({ name: 'master-dashboard' })"
    >
      <template #action>
        <button
          v-if="canCreate"
          type="button"
          class="mcg__add-btn"
          :aria-label="t('masterScreens.masterSchools.createCta')"
          @click="router.push({ name: 'master-school-create' })"
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
        :title="t('school.loadFailed')"
        :description="t('masterScreens.masterSchools.loadFailedHint')"
      >
        <template #action>
          <VButton variant="outline" @click="load">{{ t('common.retry') }}</VButton>
        </template>
      </VEmptyState>

      <VEmptyState
        v-else-if="!schools.length && canCreate"
        icon="group"
        :title="t('masterScreens.masterSchools.empty.title')"
        :description="t('masterScreens.masterSchools.empty.text')"
      >
        <template #action>
          <VButton variant="primary" @click="router.push({ name: 'master-school-create' })">
            {{ t('masterScreens.masterSchools.create') }}
          </VButton>
        </template>
      </VEmptyState>

      <!-- BE-18: no schools and no right to found one -- the only way in is
           an invite link, and the screen says who issues the right instead
           of offering a button that would only ever answer 403. -->
      <VEmptyState
        v-else-if="!schools.length"
        icon="group"
        :title="t('masterScreens.masterSchools.empty.title')"
        :description="t('masterScreens.masterSchools.empty.joinHint')"
      />

      <template v-else>
        <template v-if="curated.length">
          <h2 class="velo-section-title mcg__section">
            {{ t('masterScreens.masterSchools.tab.curator') }}
          </h2>
          <SchoolRow
            v-for="school in curated"
            :key="school.id"
            :school="school"
            @open="router.push({ name: 'master-school', params: { id: $event } })"
          />
        </template>

        <template v-if="memberOnly.length">
          <h2 class="velo-section-title mcg__section">
            {{ t('masterScreens.masterSchools.tab.member') }}
          </h2>
          <SchoolRow
            v-for="school in memberOnly"
            :key="school.id"
            :school="school"
            @open="router.push({ name: 'master-school', params: { id: $event } })"
          />
        </template>
      </template>

      <!-- Membership is untouched by the right -- rows render either way;
           only the founding offer is gated (BE-18). -->
      <p v-if="!loading && !error && schools.length && !canCreate" class="mcg__hint">
        {{ t('masterScreens.masterSchools.masterOnlyNote') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { masterSchoolsQuery } from '@/composables/queries/schools'
import { screenQueryState } from '@/composables/queries/screenState'
import SchoolRow from '@/components/shared/SchoolRow.vue'
import { IconPlusFilled } from '@/components/icons'
import { VButton, VEmptyState } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'
import { VLoader } from '@/components/ui'

const router = useRouter()

// Tab screen: the list lives in the screen-data cache (Colada) -- a return
// through the dock renders the schools at once and refreshes them in the
// background (staleTime 0: a school created a moment ago is there on the
// next visit), no spinner on every visit.
const schoolsQuery = useQuery(() => masterSchoolsQuery())
/** Only an error with nothing to show (and no retry running) replaces the list. */
const { loading, failed: error } = screenQueryState(schoolsQuery)
const schools = computed(() => schoolsQuery.data.value?.schools ?? [])
/** BE-18: the admin-issued right to found a school. False is the honest
 *  default on a failed flag fetch -- an offered «+» that only ever answers
 *  403 is worse than a missing one. */
const canCreate = computed(() => schoolsQuery.data.value?.canCreate ?? false)

const curated = computed(() => schools.value.filter((school) => school.relation === 'curator'))
const memberOnly = computed(() => schools.value.filter((school) => school.relation !== 'curator'))

function load(): void {
  void schoolsQuery.refetch()
}
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
  font-size: var(--velo-fs-14);
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
