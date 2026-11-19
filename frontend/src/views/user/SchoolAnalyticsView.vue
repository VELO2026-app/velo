<!--
  VELO Frontend -- SchoolAnalyticsView (tz-curator.md §6)

  The school's analytics screen, rebuilt per the owner's brief of
  2026-10-02. Part 1: a period slider (week i18n:common.periodWeek, month
  i18n:common.periodMonth, quarter
  i18n:user.screens.schoolAnalytics.period.quarter) over four
  white metric cards -- practices conducted, people who came out of the
  school's members, came-again rate, joined-but-never-came. Part 2: the
  feedback-percent block (i18n:user.screens.schoolAnalytics.feedbackPercent)
  under the cards -- the period's reviews out of
  its visits (BE-107: the server computes reviews_pct and sends both
  numbers; the screen does no arithmetic) on the heading line,
  the FIVE-scale feedback strip (i18n:mood.bad .. i18n:mood.fire,
  tz-mood-scale) below, via
  the shared DistributionCard. The slider refetches in place, and the last
  requested period wins (an earlier response never lands under a newer
  label).

  Curator-only surface: the server answers everyone else with the same
  masked 404 as every school surface (P-08). ONE component mounted by BOTH
  zones (SchoolMembersView precedent) -- the zone picks the back target
  only; every number keys off the server aggregate, never the zone.

  The response also carries the school's all-time groups (mood
  distribution, top practices) -- the raw material for the screen's later
  parts, not rendered yet. A transient failure while switching periods
  swaps the screen for the honest retry state: stale numbers under a new
  period label are the one thing this screen must never show.
-->

<template>
  <div class="school-analytics" :aria-busy="loading || refetching">
    <VHeader :title="t('user.screens.schoolAnalytics.title')" show-back @back="goBack" />

    <div class="school-analytics__content">
      <!-- Loading (first load only; a period switch refetches in place) -->
      <div v-if="loading" class="school-analytics__state">
        <VLoader size="lg" />
      </div>

      <!-- 404: not the curator of this school any more (or ever were not) --
           masked like every school surface. -->
      <VEmptyState
        v-else-if="notFound"
        icon="notfound"
        :title="t('user.screens.schoolAnalytics.unavailable')"
        :description="t('user.screens.schoolAnalytics.unavailableHint')"
      >
        <template #action>
          <VButton variant="primary" @click="goBack">{{
            t('user.screens.schoolAnalytics.backToSchool')
          }}</VButton>
        </template>
      </VEmptyState>

      <!-- Transient failure: honest retry, no fake data. -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="t('user.screens.schoolAnalytics.loadFailed')"
        :description="t('user.screens.schoolAnalytics.loadFailedHint')"
      >
        <template #action>
          <VButton variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
        </template>
      </VEmptyState>

      <template v-else-if="data">
        <!-- Full-width period slider: variant="tabs" is the DS idiom for a
             stretched track with equal segments (the compact "toggle" is the
             dashboard-header shape and would sit content-sized here). -->
        <VSegmentTrack
          v-model="period"
          class="school-analytics__period"
          :options="PERIOD_OPTIONS"
          variant="tabs"
          :aria-label="t('analytics.statsPeriod')"
        />

        <!-- Interim scaffold (owner 2026-10-02: the backend will catch
             up): every engagement read is fault-tolerant, so a payload from
             a backend that has not shipped the contract yet renders the
             honest zero scaffold instead of crashing the screen. When the
             real backend lands, the numbers appear with no FE change. -->
        <div class="school-analytics__stats">
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.practices_conducted ?? 0 }}
            </span>
            <span class="school-analytics__stat-label">{{
              t('user.screens.schoolAnalytics.practicesHeld')
            }}</span>
          </div>
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.attendees ?? 0 }}
            </span>
            <span class="school-analytics__stat-label">
              {{ t('user.screens.schoolAnalytics.membersLine', { n: data.members.students }) }}
            </span>
          </div>
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.repeat_pct ?? 0 }}%
            </span>
            <span class="school-analytics__stat-label">
              {{
                t('user.screens.schoolAnalytics.repeatLine', {
                  n: data.engagement?.repeat_attendees ?? 0,
                  total: data.engagement?.attendees ?? 0,
                })
              }}
            </span>
          </div>
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.joined_never_came ?? 0 }}
            </span>
            <span class="school-analytics__stat-label">{{
              t('user.screens.schoolAnalytics.joinedAndMissed')
            }}</span>
          </div>
        </div>

        <!-- Part 2: the feedback share. Heading line + the colored strip,
             one server aggregate per selected period; the percent and both
             numbers (reviews out of visits) come ready from the server. -->
        <DistributionCard
          class="school-analytics__feedback"
          :title="t('user.screens.schoolAnalytics.feedbackPercent')"
          :count-label="feedbackCountLabel"
          :bars="feedbackBars"
          :empty-text="t('user.screens.schoolAnalytics.noFeedbacks')"
        />

        <!-- Part 3: every practice of the selected period, newest first --
             one line (date · students · feedbacks) over a bare five-color
             strip: no title, no percentages, no details -- the labeled
             scales live in the blocks above. -->
        <section class="school-analytics__period-practices">
          <h2 class="velo-section-title">{{ periodSectionTitle }}</h2>
          <template v-if="periodPractices.length">
            <ConductedPracticeCard
              v-for="p in periodPractices"
              :key="p.practice_id"
              class="school-analytics__practice"
              :practice="p"
              :clickable="inMasterZone"
              @open="openPractice"
            />
          </template>
          <VEmptyState
            v-else
            variant="note"
            :title="t('user.screens.schoolAnalytics.noPractices')"
            :description="t('user.screens.schoolAnalytics.cardsAfterFirst')"
          />
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { schoolAnalyticsQuery } from '@/composables/queries/schools'
import { screenQueryState } from '@/composables/queries/screenState'
import { useRoute, useRouter } from 'vue-router'
import { ApiResponseError } from '@/api/client'
import type { SchoolAnalyticsPeriod } from '@/api/schools'
import type { SchoolAnalyticsResponse } from '@/api/types'
import { VButton, VEmptyState, VLoader, VSegmentTrack } from '@/components/ui'
import ConductedPracticeCard from '@/components/shared/ConductedPracticeCard.vue'
import { moodStripBars } from '@/components/shared/conductedPractice'
import DistributionCard from '@/components/shared/DistributionCard.vue'
import VHeader from '@/components/layout/VHeader.vue'

const route = useRoute()
const router = useRouter()

const schoolId = computed(() => String(route.params.id ?? ''))
// Same zone pick as the school page and the roster screen: the route name's
// prefix. It decides the back target only.
const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))

// -- Period slider (part 1). Same vocabulary + default as the master
//    dashboard's toggle; the backend bounds the window over the curator's
//    own calendar, the slider only names it. --
const period = ref<SchoolAnalyticsPeriod>('week')
const PERIOD_OPTIONS: ReadonlyArray<{ value: SchoolAnalyticsPeriod; label: string }> = [
  { value: 'week', label: t('common.periodWeek') },
  { value: 'month', label: t('common.periodMonth') },
  { value: 'quarter', label: t('user.screens.schoolAnalytics.period.quarter') },
]

// -- The feedback block (part 2). The feedback-percent heading
//    (i18n:user.screens.schoolAnalytics.feedbackPercent) = the period's
//    reviews out of its visits, everyone who came (BE-107, owner decision
//    3). The SERVER computes reviews_pct and sends reviews and visits beside
//    it; the screen renders them as they come and divides nothing. reviews
//    is the sum of the strip's zones, so the line and the strip agree. The
//    strip is the FIVE mood-scale gradations (i18n:mood.bad .. i18n:mood.fire) with the
//    shared mood palette + faces -- visually the same segments the practice
//    strips render, and since BE-77 the same five zones every feed and
//    distribution carries. --
const feedbackCountLabel = computed((): string => {
  const e = data.value?.engagement
  return t('user.screens.schoolAnalytics.conversion', {
    pct: e?.reviews_pct ?? 0,
    reviews: e?.reviews ?? 0,
    visits: e?.visits ?? 0,
  })
})
const feedbackBars = computed(() => moodStripBars(data.value?.engagement?.rating))

// -- Part 3: the period's conducted practices, newest first. Every card
//    reads the same aggregates the totals use; its own strip is the bare
//    five-color fill. Fault-tolerant like the cards: an older payload (no
//    conducted_practices) renders the section's empty state. --

const periodSectionTitle = computed(
  (): string =>
    ({
      week: t('user.screens.schoolAnalytics.practicesOfWeek'),
      month: t('user.screens.schoolAnalytics.practicesOfMonth'),
      quarter: t('user.screens.schoolAnalytics.practicesOfQuarter'),
    })[period.value],
)
const periodPractices = computed(() => data.value?.engagement?.conducted_practices ?? [])

// -- The analytics (Pinia Colada, FE-166 step 6: schoolAnalyticsQuery) --
//
// One entry per (school, period): rapid slider taps race their responses,
// but each lands in its own period's entry, so the numbers on screen always
// answer the LAST selected period (the hand-kept request counter before).
// A period switch keeps the previous period's grid mounted (no full-screen
// flash) while the new one loads -- the root carries aria-busy; a NEW
// school (router reuse) starts from the loader, never from the previous
// school's numbers.
const analyticsQuery = useQuery(() =>
  schoolAnalyticsQuery({ schoolId: schoolId.value, period: period.value }),
)
const analyticsState = screenQueryState(analyticsQuery)

// Only from a settled request: an entry keeps its error while it refetches,
// and a school answering again must not read as unavailable meanwhile.
const notFound = computed(() => {
  const e = analyticsQuery.error.value
  return (
    e instanceof ApiResponseError && e.status === 404 && analyticsQuery.asyncStatus.value === 'idle'
  )
})
const data = computed<SchoolAnalyticsResponse | null>(() =>
  notFound.value ? null : (analyticsQuery.data.value ?? null),
)
/** Nothing to show yet and an answer awaited (the first load, a new school, a retry). */
const loading = computed(
  () => !notFound.value && data.value === null && !analyticsState.failed.value,
)
/** The previous period's numbers stand in while the selected one loads. */
const refetching = computed(() => analyticsQuery.isPlaceholderData.value)
const error = computed(() => !notFound.value && analyticsState.failed.value)

function retry(): void {
  void analyticsQuery.refetch()
}

// BE-78 (2): in the MASTER zone a practice card opens the practice
// analytics screen (i18n:shared.analytics.title; its back is
// router.back() -> here). The user-zone mount stays
// inert -- FE-93 removes it: the card is `clickable` only in the master zone,
// and VCard emits no click otherwise, so this runs in the master zone only.
function openPractice(practiceId: string): void {
  void router.push({ name: 'master-practice-reviews', params: { id: practiceId } })
}

function goBack(): void {
  void router.push({
    name: 'master-school',
    params: { id: schoolId.value },
  })
}
</script>

<style scoped>
.school-analytics {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.school-analytics__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.school-analytics__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* The track is a flex child of the column content, so it stretches to the
   full content width; stated explicitly so the slider stays wide even if
   the parent's alignment changes. */
.school-analytics__period {
  width: 100%;
}

/* The four metric cards: white rectangles, value over caption. Same white
   surface tokens as VStatCard (the dashboards' stat card); the caption may
   run two lines (the members line,
   i18n:user.screens.schoolAnalytics.membersLine), so it wraps instead
   of VStatCard's single-line nowrap label. */
.school-analytics__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.school-analytics__stat {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  text-align: center;
}

.school-analytics__stat-value {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  letter-spacing: 0.64px;
  line-height: 1.1;
}

.school-analytics__stat-label {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  line-height: 1.35;
}
</style>
