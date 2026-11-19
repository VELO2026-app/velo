<!--
  VELO Frontend -- AdminSchoolsView (schools FE-23 / GT P4)

  Read-only list of EVERY school, including frozen ones -- the only place in
  the system where an inactive school is visible at all (for its own members
  it is indistinguishable from a deleted one, I-6). is_active is rendered as
  a badge, NOT offered as a filter: the admin is the person being asked
  "why has my school gone quiet", and both kinds belong in one answer.

  No delete/edit actions live here on purpose -- the ONE moderation lever
  for schools is the existing master-verification revoke, which freezes all
  of a curator's schools at once; a tap opens the curator's own review page
  where that lever already is.

  The list is a Pinia Colada infinite query (composables/queries/
  adminCatalogs.ts, FE-181); a revoke elsewhere invalidates it.
-->

<template>
  <div class="admin-list">
    <header class="admin-list__top">
      <VBackButton @click="router.push({ name: 'admin-masters' })" />
      <h1 class="admin-list__title">{{ t('adminScreens.adminSchools.title') }}</h1>
      <span class="admin-list__count">{{ total || '—' }}</span>
    </header>

    <div v-if="loading && !schools.length" class="admin-list__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('school.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="retry">{{ t('common.retry') }}</VButton></template
      >
    </VEmptyState>

    <template v-else-if="schools.length">
      <div class="admin-list__items">
        <button
          v-for="school in schools"
          :key="school.id"
          type="button"
          class="sg-card"
          @click="
            router.push({ name: 'admin-master-review', params: { id: school.curator.user_id } })
          "
        >
          <div class="sg-card__head">
            <span class="sg-card__name">{{ school.name }}</span>
            <VBadge :variant="school.is_active ? 'success' : 'muted'">
              {{
                school.is_active
                  ? t('adminScreens.adminSchools.active')
                  : t('adminScreens.adminSchools.frozen')
              }}
            </VBadge>
          </div>
          <span class="sg-card__curator">{{
            t('school.curator', {
              name: school.curator.display_name || '—',
            })
          }}</span>
          <span class="sg-card__meta">
            {{
              t('adminScreens.adminSchools.countsLine', {
                masters: school.masters_count,
                students: school.students_count,
                since: createdLabel(school.created_at),
              })
            }}
          </span>
        </button>
      </div>

      <div v-if="hasMore" class="admin-list__more">
        <VButton variant="outline" :loading="loading" @click="loadMore">{{
          t('common.showMore')
        }}</VButton>
      </div>
    </template>

    <VCard v-else>
      <p class="admin-list__empty">
        {{ t('adminScreens.adminSchools.emptyNote') }}
      </p>
    </VCard>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useInfiniteQuery } from '@pinia/colada'
import { VBackButton, VBadge, VButton, VCard, VEmptyState, VLoader } from '@/components/ui'
import type { AdminSchoolListItem } from '@/api/types'
import { adminSchoolsQuery } from '@/composables/queries/adminCatalogs'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

const schoolsQuery = useInfiniteQuery(adminSchoolsQuery)
const schools = computed<AdminSchoolListItem[]>(
  () => schoolsQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const total = computed(() => schoolsQuery.data.value?.pages.at(-1)?.total ?? 0)
const loading = computed(() => schoolsQuery.asyncStatus.value === 'loading')
// W12 discipline: only a failed FIRST page is an error state; a failed
// loadMore keeps the loaded pages and toasts.
const error = computed(
  () => schoolsQuery.data.value === undefined && !loading.value && schoolsQuery.error.value != null,
)
const hasMore = schoolsQuery.hasNextPage

watch(schoolsQuery.error, (e) => {
  if (e) toast.error(t('school.loadFailed'))
})

function retry(): void {
  void schoolsQuery.refetch()
}

function loadMore(): void {
  // cancelRefetch false: a tap during a reload waits for it.
  void schoolsQuery.loadNextPage({ cancelRefetch: false })
}

// school creation month, from created_at (UTC).
function createdLabel(iso: string): string {
  const d = new Date(iso)
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '')
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${d.getUTCFullYear()}`
}
</script>

<style scoped>
.admin-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Same admin-list chrome as AdminParticipantsView (back + title + count). */
.admin-list__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.admin-list__title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-48);
  color: var(--velo-text-primary);
  margin: 0;
  flex: 1;
}

.admin-list__count {
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-secondary);
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  padding: var(--velo-gap-2) var(--velo-inset-12);
}

.admin-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.admin-list__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.admin-list__more {
  display: flex;
  justify-content: center;
}

.admin-list__empty {
  margin: 0;
  color: var(--velo-text-secondary);
  text-align: center;
}

/* School card: name + frozen/active badge, curator, counts, creation. */
.sg-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-align: left;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  font-family: var(--font-body);
}

.sg-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.sg-card__name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
}

.sg-card__curator {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
}

.sg-card__meta {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
