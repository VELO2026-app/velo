<!--
  VELO Frontend -- SchoolAnalyticsView (tz-curator.md §6)

  The school's analytics screen, rebuilt per the owner's brief of
  2026-10-02. Part 1: a period slider (Неделя / Месяц / Квартал) over four
  white metric cards -- practices conducted, people who came out of the
  school's members, came-again rate, joined-but-never-came. Part 2: the
  «Процент фидбеков» block under the cards -- reviewers (users who left a
  review in the period) out of the school's students on the heading line,
  the FIVE-scale feedback strip (Плохо .. Огонь, tz-mood-scale) below, via
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
    <VHeader title="Аналитика школы" show-back @back="goBack" />

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
        title="Школа недоступна"
        description="Возможно, она была удалена или вы больше не её куратор."
      >
        <template #action>
          <VButton variant="primary" @click="goBack">К школе</VButton>
        </template>
      </VEmptyState>

      <!-- Transient failure: honest retry, no fake data. -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить аналитику"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="refresh">Повторить</VButton>
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
          aria-label="Период статистики"
        />

        <!-- Interim scaffold (owner 2026-10-02: «бек доедет»): every
             engagement read is fault-tolerant, so a payload from a backend
             that has not shipped the contract yet renders the honest zero
             scaffold instead of crashing the screen. When the real backend
             lands, the numbers appear with no FE change. -->
        <div class="school-analytics__stats">
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.practices_conducted ?? 0 }}
            </span>
            <span class="school-analytics__stat-label">Практик проведено</span>
          </div>
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.attendees ?? 0 }}
            </span>
            <span class="school-analytics__stat-label">
              Человек приходило из {{ data.members.students }} в школе
            </span>
          </div>
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.repeat_pct ?? 0 }}%
            </span>
            <span class="school-analytics__stat-label">
              Пришли еще раз, {{ data.engagement?.repeat_attendees ?? 0 }} из
              {{ data.engagement?.attendees ?? 0 }}
            </span>
          </div>
          <div class="school-analytics__stat">
            <span class="school-analytics__stat-value">
              {{ data.engagement?.joined_never_came ?? 0 }}
            </span>
            <span class="school-analytics__stat-label">Вступили и не пришли</span>
          </div>
        </div>

        <!-- Part 2: the feedback share. Heading line + the colored strip,
             one server aggregate per selected period; the percent divides
             reviewers by members.students (the roster number, card 2). -->
        <DistributionCard
          class="school-analytics__feedback"
          title="Процент фидбеков"
          :count-label="feedbackCountLabel"
          :bars="feedbackBars"
          empty-text="Пока нет отзывов"
        />

        <!-- Part 3: every practice of the selected period, newest first --
             one line (date · students · feedbacks) over a bare five-color
             strip: no title, no percentages, no details -- the labeled
             scales live in the blocks above. -->
        <section class="school-analytics__period-practices">
          <h2 class="velo-section-title">{{ periodSectionTitle }}</h2>
          <template v-if="periodPractices.length">
            <VCard
              v-for="p in periodPractices"
              :key="p.practice_id"
              class="school-analytics__practice"
            >
              <div class="school-analytics__practice-head">
                <component :is="practiceIconFor(p)" :size="40" aria-hidden="true" />
                <div class="school-analytics__practice-main">
                  <span class="school-analytics__practice-title">{{ p.title }}</span>
                  <span class="school-analytics__practice-meta">{{ p.master_name }}</span>
                </div>
              </div>
              <div class="school-analytics__practice-counts">
                <span>{{ formatShortDate(p.scheduled_at, p.timezone) }}</span>
                <span>Ученики: {{ p.attendees_count }}</span>
                <span>Фидбеки: {{ p.reviews_count }}</span>
              </div>
              <!-- Bare five-color strip: proportional fills only. -->
              <div
                v-if="p.reviews_count > 0"
                class="school-analytics__practice-strip"
                aria-hidden="true"
              >
                <div
                  v-for="segment in moodStripBars(p.rating).filter((bar) => bar.count > 0)"
                  :key="segment.key"
                  :style="{ flex: `${segment.count} 1 0`, background: segment.fill }"
                />
              </div>
            </VCard>
          </template>
          <VEmptyState
            v-else
            variant="note"
            title="Пока нет практик за этот период"
            description="Карточки появятся после первой проведённой практики."
          />
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiResponseError } from '@/api/client'
import { getCuratorGroupAnalytics, type SchoolAnalyticsPeriod } from '@/api/curatorGroups'
import type { CuratorGroupAnalyticsResponse } from '@/api/types'
import { VButton, VCard, VEmptyState, VLoader, VSegmentTrack } from '@/components/ui'
import DistributionCard from '@/components/shared/DistributionCard.vue'
import VHeader from '@/components/layout/VHeader.vue'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_FILLS, practiceIconFor } from '@/utils/displayHelpers'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import { formatShortDate } from '@/utils/format'

const route = useRoute()
const router = useRouter()

const groupId = computed(() => String(route.params.id ?? ''))
// Same zone pick as the school page and the roster screen: the route name's
// prefix. It decides the back target only.
const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))

// -- Period slider (part 1). Same vocabulary + default as the master
//    dashboard's toggle; the backend bounds the window over the curator's
//    own calendar, the slider only names it. --
const period = ref<SchoolAnalyticsPeriod>('week')
const PERIOD_OPTIONS: ReadonlyArray<{ value: SchoolAnalyticsPeriod; label: string }> = [
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: 'Квартал' },
]

// -- The feedback block (part 2). «Процент фидбеков» = reviewers (users who
//    left a review in the period) out of the school's USERS -- the same
//    students count card 2 shows; the denominator rides the payload, so the
//    percent is derived, never a second server copy of one number. The
//    strip is the FIVE mood-scale gradations («Плохо» .. «Огонь») with the
//    shared mood palette + faces -- visually the same segments the practice
//    strips render, and since BE-77 the same five zones every feed and
//    distribution carries. Every read is fault-tolerant: an older
//    payload (no rating / reviewers yet) degrades to the empty scaffold,
//    never a crash -- the «бек доедет» ruling. --
const feedbackReviewPct = computed((): number => {
  const students = data.value?.members.students ?? 0
  const reviewers = data.value?.engagement?.reviewers ?? 0
  if (students <= 0) return 0
  return Math.round((reviewers / students) * 100)
})
const feedbackCountLabel = computed(
  (): string =>
    `${feedbackReviewPct.value}% · ${data.value?.engagement?.reviewers ?? 0} из ${
      data.value?.members.students ?? 0
    }`,
)
const feedbackBars = computed(() => moodStripBars(data.value?.engagement?.rating))

// -- Part 3: the period's conducted practices, newest first. Every card
//    reads the same aggregates the totals use; its own strip is the bare
//    five-color fill. Fault-tolerant like the cards: an older payload (no
//    conducted_practices) renders the section's empty state. --

const periodSectionTitle = computed(
  (): string =>
    ({
      week: 'Практики недели',
      month: 'Практики месяца',
      quarter: 'Практики квартала',
    })[period.value],
)
const periodPractices = computed(() => data.value?.engagement?.conducted_practices ?? [])

function moodStripBars(counts?: Partial<Record<MoodScaleKey, number>>) {
  return MOOD_SCALE_KEYS.map((key) => ({
    key,
    label: MOOD_SCALE_LABELS[key],
    count: counts?.[key] ?? 0,
    fill: MOOD_SCALE_FILLS[key],
    icon: MOOD_SCALE_ICON[key],
  }))
}

const loading = ref(true)
// A period-switch refetch keeps the grid mounted (no full-screen flash);
// the root carries aria-busy while it runs.
const refetching = ref(false)
const error = ref(false)
const notFound = ref(false)
const data = ref<CuratorGroupAnalyticsResponse | null>(null)

// Out-of-order guard: rapid slider taps race their responses; the numbers
// on screen must always answer the LAST selected period.
let requestSeq = 0

async function refresh(): Promise<void> {
  const seq = ++requestSeq
  if (data.value === null) {
    loading.value = true
  } else {
    refetching.value = true
  }
  error.value = false
  notFound.value = false
  try {
    const fresh = await getCuratorGroupAnalytics(groupId.value, period.value)
    if (seq === requestSeq) data.value = fresh
  } catch (e) {
    if (seq !== requestSeq) return
    if (e instanceof ApiResponseError && e.status === 404) {
      notFound.value = true
    } else {
      error.value = true
    }
  } finally {
    if (seq === requestSeq) {
      loading.value = false
      refetching.value = false
    }
  }
}

// The slider drives the fetch.
watch(period, () => {
  void refresh()
})

// Router reuse: navigating between this school's screens reuses the mounted
// instance, so re-read for the new id instead of waiting for a remount.
// A NEW school also drops the previous school's numbers: showing them under
// the new route (even briefly) is the stale-data state this screen forbids.
watch(groupId, () => {
  if (groupId.value) {
    data.value = null
    void refresh()
  }
})

onMounted(() => {
  void refresh()
})

function goBack(): void {
  void router.push({
    name: inMasterZone.value ? 'master-curator-group' : 'user-curator-group',
    params: { id: groupId.value },
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
   run two lines («Человек приходило из 27 в школе»), so it wraps instead
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
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  letter-spacing: 0.64px;
  line-height: 1.1;
}

.school-analytics__stat-label {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.35;
}

/* Part 3: the period's practice card (compact hero). */
.school-analytics__practice {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.school-analytics__practice-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.school-analytics__practice-head > svg {
  flex-shrink: 0;
  color: var(--velo-text-primary);
}

.school-analytics__practice-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.school-analytics__practice-title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.school-analytics__practice-meta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.school-analytics__practice-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* Bare five-color strip: proportional fills, no labels (the labeled
   scales live in the blocks above). */
.school-analytics__practice-strip {
  display: flex;
  gap: 3px;
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
}

.school-analytics__practice-strip > div {
  min-width: 4px;
}
</style>
