<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { VAvatar, VButton, VCard, VEmptyState, VLoader } from '@/components/ui'
import { VHeader } from '@/components/layout'
import { IconCalendar, IconCheckin, IconGroup } from '@/components/icons'
import VShowMore from '@/components/shared/VShowMore.vue'
import MoodAvatar from '@/components/shared/MoodAvatar.vue'
import { formatShortDate } from '@/utils/format'
import { practiceIconFor } from '@/utils/displayHelpers'
import { moodLabelFromScore } from '@/utils/moodScale'
import PracticeMoodDistribution from './PracticeMoodDistribution.vue'
import { countMoods, isScore, type PracticeAnalyticsData } from './analytics'

const props = withDefaults(
  defineProps<{
    data: PracticeAnalyticsData | null
    loading?: boolean
    error?: string | null
  }>(),
  { loading: false, error: null },
)

defineEmits<{ back: []; retry: [] }>()
const expandedPairs = ref(false)
const answers = computed(() => props.data?.answers ?? [])
const before = computed(() => countMoods(answers.value, 'before'))
const after = computed(() => countMoods(answers.value, 'after'))
const pairs = computed(() =>
  answers.value.flatMap((answer) => {
    if (!isScore(answer.before) || !isScore(answer.after)) return []
    return [{ ...answer, before: answer.before, after: answer.after }]
  }),
)
const visiblePairs = computed(() => (expandedPairs.value ? pairs.value : pairs.value.slice(0, 4)))
const remainingPairs = computed(() => Math.max(0, pairs.value.length - 4))
const morePairsLabel = computed(() => {
  const n = remainingPairs.value
  const noun =
    n % 100 >= 11 && n % 100 <= 14
      ? 'пар'
      : n % 10 === 1
        ? 'пару'
        : n % 10 >= 2 && n % 10 <= 4
          ? 'пары'
          : 'пар'
  return `+ еще ${n} ${noun}`
})
const reviews = computed(() => answers.value.filter((answer) => answer.comment?.trim()))
watch(
  () => props.data?.practice.id,
  () => {
    expandedPairs.value = false
  },
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

    <template v-else-if="data">
      <VCard class="practice-analytics__hero">
        <div class="practice-analytics__identity">
          <component :is="practiceIconFor(data.practice)" :size="46" aria-hidden="true" />
          <div class="practice-analytics__identity-text">
            <h2>{{ data.practice.title }}</h2>
            <div v-if="data.practice.master_name" class="practice-analytics__author">
              <VAvatar
                :name="data.practice.master_name"
                :url="data.practice.master_avatar_url ?? undefined"
                size="sm"
              />
              <span>{{ data.practice.master_name }}</span>
            </div>
          </div>
        </div>
        <div class="practice-analytics__meta">
          <span
            ><IconCalendar :size="16" aria-hidden="true" />
            {{ formatShortDate(data.practice.scheduled_at, data.practice.timezone) }}
          </span>
          <span><IconGroup :size="16" aria-hidden="true" />Ученики: {{ data.participants }}</span>
          <span v-if="data.practice.checkin_count != null">
            <IconCheckin :size="16" aria-hidden="true" />Чек-ины:
            {{ data.practice.checkin_count }}
          </span>
        </div>
      </VCard>

      <PracticeMoodDistribution
        :key="`${data.practice.id}-before`"
        title="До практики"
        :counts="before"
        :participants="data.participants"
      />
      <PracticeMoodDistribution
        :key="`${data.practice.id}-after`"
        title="После практики"
        :counts="after"
        :participants="data.participants"
        initially-expanded
      />

      <VCard class="practice-analytics__pairs">
        <div class="practice-analytics__heading">
          <h2>Пришел → ушел</h2>
          <span
            ><IconGroup :size="18" aria-hidden="true" />{{ pairs.length }} из
            {{ data.participants }}</span
          >
        </div>
        <p v-if="!pairs.length" class="practice-analytics__empty">Пока нет пар для сравнения</p>
        <ul v-else class="practice-analytics__pair-list">
          <li v-for="pair in visiblePairs" :key="pair.userId" class="practice-analytics__pair">
            <div class="practice-analytics__faces" aria-hidden="true">
              <MoodAvatar :mood="pair.before" :size="22" />
              <span>→</span>
              <MoodAvatar :mood="pair.after" :size="22" />
            </div>
            <span class="practice-analytics__name">{{ pair.name }}</span>
            <span class="practice-analytics__transition">
              {{ moodLabelFromScore(pair.before) }} →
              {{ moodLabelFromScore(pair.after) }}
            </span>
          </li>
        </ul>
        <VShowMore
          v-if="remainingPairs > 0"
          :label="expandedPairs ? 'Скрыть' : morePairsLabel"
          :aria-expanded="expandedPairs"
          @click="expandedPairs = !expandedPairs"
        />
      </VCard>

      <section class="practice-analytics__reviews" aria-label="Отзывы">
        <div class="practice-analytics__heading">
          <h2>Отзывы</h2>
          <span
            ><IconGroup :size="18" aria-hidden="true" />{{ reviews.length }} из
            {{ data.participants }}</span
          >
        </div>
        <VCard v-for="review in reviews" :key="review.userId" class="practice-analytics__review">
          <h3>{{ review.name }}</h3>
          <p>«{{ review.comment?.trim() }}»</p>
        </VCard>
        <VCard v-if="!reviews.length"
          ><p class="practice-analytics__empty">Отзывов пока нет</p></VCard
        >
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
