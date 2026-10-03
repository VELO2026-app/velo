<script setup lang="ts">
// BE-78: presentational. The container (PracticeReviewsView) owns the three
// requests and the paging; every number here is the server's -- zones
// included (ScoreZone, BE-24: never a raw 1..10). Every "X из N" uses
// N = summary.attended.
import { computed } from 'vue'
import { VAvatar, VButton, VCard, VEmptyState, VLoader } from '@/components/ui'
import { VHeader } from '@/components/layout'
import { IconCalendar, IconCheckin, IconGroup } from '@/components/icons'
import VShowMore from '@/components/shared/VShowMore.vue'
import { formatShortDate } from '@/utils/format'
import { practiceIconFor } from '@/utils/displayHelpers'
import { MOOD_SCALE_LABELS } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import type {
  PracticeAnalyticsPair,
  PracticeAnalyticsResponse,
  PracticeAnalyticsReview,
} from '@/api/types'
import PracticeMoodDistribution from './PracticeMoodDistribution.vue'
import { moodTotal } from './analytics'

const props = withDefaults(
  defineProps<{
    summary: PracticeAnalyticsResponse | null
    pairs?: PracticeAnalyticsPair[]
    reviews?: PracticeAnalyticsReview[]
    loading?: boolean
    error?: string | null
    loadingMorePairs?: boolean
    loadingMoreReviews?: boolean
  }>(),
  {
    pairs: () => [],
    reviews: () => [],
    loading: false,
    error: null,
    loadingMorePairs: false,
    loadingMoreReviews: false,
  },
)

defineEmits<{ back: []; retry: []; morePairs: []; moreReviews: [] }>()

// «Чек-инов до» is the «до» distribution's total: one population (attended).
const checkedIn = computed(() => (props.summary ? moodTotal(props.summary.before) : 0))
const hasMorePairs = computed(
  () => !!props.summary && props.pairs.length < props.summary.pairs_total,
)
const hasMoreReviews = computed(
  () => !!props.summary && props.reviews.length < props.summary.reviews_total,
)
</script>

<template>
  <div class="practice-analytics" :aria-busy="loading">
    <VHeader title="Аналитика по практике" show-back @back="$emit('back')" />

    <div v-if="loading" class="practice-analytics__loading" role="status">
      <VLoader /> <span>Загружаем аналитику…</span>
    </div>

    <VEmptyState v-else-if="error" icon="warning" title="Не удалось загрузить аналитику">
      <p>{{ error }}</p>
      <VButton type="button" size="sm" @click="$emit('retry')">Повторить</VButton>
    </VEmptyState>

    <template v-else-if="summary">
      <VCard class="practice-analytics__hero">
        <div class="practice-analytics__identity">
          <component :is="practiceIconFor(summary)" :size="46" aria-hidden="true" />
          <div class="practice-analytics__identity-text">
            <h2>{{ summary.title }}</h2>
            <div class="practice-analytics__author">
              <VAvatar
                :name="summary.master_name"
                :url="summary.master_avatar_url ?? undefined"
                size="sm"
              />
              <span>{{ summary.master_name }}</span>
            </div>
          </div>
        </div>
        <div class="practice-analytics__meta">
          <span
            ><IconCalendar :size="16" aria-hidden="true" />
            {{ formatShortDate(summary.scheduled_at, summary.timezone) }}
          </span>
          <span><IconGroup :size="16" aria-hidden="true" />Пришли: {{ summary.attended }}</span>
          <span><IconCheckin :size="16" aria-hidden="true" />Чек-ины: {{ checkedIn }}</span>
        </div>
      </VCard>

      <PracticeMoodDistribution
        :key="`${summary.practice_id}-before`"
        title="До практики"
        :counts="summary.before"
        :participants="summary.attended"
      />
      <PracticeMoodDistribution
        :key="`${summary.practice_id}-after`"
        title="После практики"
        :counts="summary.after"
        :participants="summary.attended"
        initially-expanded
      />

      <VCard class="practice-analytics__pairs">
        <div class="practice-analytics__heading">
          <h2>Пришел → ушел</h2>
          <span
            ><IconGroup :size="18" aria-hidden="true" />{{ summary.pairs_total }} из
            {{ summary.attended }}</span
          >
        </div>
        <p v-if="!pairs.length" class="practice-analytics__empty">Пока нет пар для сравнения</p>
        <ul v-else class="practice-analytics__pair-list">
          <li v-for="pair in pairs" :key="pair.user_id" class="practice-analytics__pair">
            <VAvatar :name="pair.name" :url="pair.avatar_url ?? undefined" size="sm" />
            <span class="practice-analytics__name">{{ pair.name }}</span>
            <span class="practice-analytics__faces" aria-hidden="true">
              <component :is="MOOD_SCALE_ICON[pair.before_zone]" :size="22" />
              <span>→</span>
              <component :is="MOOD_SCALE_ICON[pair.after_zone]" :size="22" />
            </span>
            <span class="practice-analytics__transition">
              {{ MOOD_SCALE_LABELS[pair.before_zone] }} →
              {{ MOOD_SCALE_LABELS[pair.after_zone] }}
            </span>
          </li>
        </ul>
        <VShowMore
          v-if="hasMorePairs"
          :label="loadingMorePairs ? 'Загружаем…' : 'Показать ещё'"
          @click="!loadingMorePairs && $emit('morePairs')"
        />
      </VCard>

      <section class="practice-analytics__reviews" aria-label="Отзывы">
        <div class="practice-analytics__heading">
          <h2>Отзывы</h2>
          <span
            ><IconGroup :size="18" aria-hidden="true" />{{ summary.reviews_total }} из
            {{ summary.attended }}</span
          >
        </div>
        <VCard
          v-for="review in reviews"
          :key="`${review.user_id}-${review.created_at}`"
          class="practice-analytics__review"
        >
          <div class="practice-analytics__review-top">
            <VAvatar :name="review.name" :url="review.avatar_url ?? undefined" size="sm" />
            <h3>{{ review.name }}</h3>
            <time class="practice-analytics__review-date" :datetime="review.created_at">
              {{ formatShortDate(review.created_at, summary.timezone) }}
            </time>
          </div>
          <p>«{{ review.comment.trim() }}»</p>
        </VCard>
        <VCard v-if="!reviews.length"
          ><p class="practice-analytics__empty">Отзывов пока нет</p></VCard
        >
        <VShowMore
          v-if="hasMoreReviews"
          :label="loadingMoreReviews ? 'Загружаем…' : 'Показать ещё'"
          @click="!loadingMoreReviews && $emit('moreReviews')"
        />
      </section>
    </template>

    <VEmptyState v-else variant="note" title="Данные аналитики недоступны" />
  </div>
</template>

<style scoped>
/* Фон, safe area и горизонтальные поля уже задаёт MobileLayout. */
.practice-analytics {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}
.practice-analytics h2,
.practice-analytics h3 {
  margin: 0;
  font-size: var(--text-lg);
}
.practice-analytics__hero {
  margin-bottom: var(--space-3);
}
.practice-analytics__identity {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.practice-analytics__identity > svg {
  flex-shrink: 0;
}
.practice-analytics__identity-text {
  min-width: 0;
}
.practice-analytics__identity h2 {
  font-weight: 400;
}
.practice-analytics__author {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
  color: var(--velo-text-secondary);
  font-size: var(--text-xs);
}
.practice-analytics__author :deep(.v-avatar) {
  width: 18px;
  height: 18px;
  font-size: 8px;
}
.practice-analytics__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-3);
  color: var(--velo-text-secondary);
  font-size: var(--text-12);
}
.practice-analytics__meta > span,
.practice-analytics__heading > span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.practice-analytics__meta svg {
  flex-shrink: 0;
}
.practice-analytics__heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.practice-analytics__heading > span {
  font-size: var(--text-xs);
  white-space: nowrap;
}
.practice-analytics__pairs,
.practice-analytics__reviews {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.practice-analytics__pair-list {
  padding: 0;
  margin: 0;
  list-style: none;
}
.practice-analytics__pair {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--velo-border);
}
.practice-analytics__faces {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.practice-analytics__faces > span {
  color: var(--velo-border);
}
.practice-analytics__name {
  font-size: var(--text-sm);
}
.practice-analytics__transition {
  text-align: right;
  color: var(--velo-text-secondary);
  font-size: var(--text-12);
}
.practice-analytics__reviews {
  margin-top: var(--space-3);
}
.practice-analytics__review-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.practice-analytics__review-date {
  margin-left: auto;
  color: var(--velo-text-secondary);
  font-size: var(--text-sm);
}
.practice-analytics__review h3 {
  font-weight: 400;
}
.practice-analytics__review p {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  white-space: pre-wrap;
  line-height: 1.4;
}
.practice-analytics__empty {
  margin: 0;
  color: var(--velo-text-secondary);
}
.practice-analytics__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-5);
}
.practice-analytics :deep(.v-show-more) {
  min-height: 44px;
}
.practice-analytics :deep(button:focus-visible) {
  outline: 2px solid var(--velo-primary);
  outline-offset: 3px;
}
@media (max-width: 380px) {
  .practice-analytics__pair {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .practice-analytics__transition {
    grid-column: 2;
    text-align: left;
  }
}
</style>
