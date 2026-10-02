# Аналитика по практике — ТЗ с готовыми компонентами

Референс: изображение из задачи от 30 сентября 2026 года. Две его части — одна прокручиваемая страница.

Код подготовлен для текущего VELO: Vue 3, TypeScript, `<script setup>`, scoped CSS. Используются существующие `VCard`, `VHeader`, `VShowMore`, `VAvatar`, `VButton`, `VEmptyState`, `VLoader`, иконки и общая пятиступенчатая шкала эмоций. Фон, шрифт Marmelad и безопасные отступы предоставляет существующая оболочка приложения. Приближённые цвета диаграммы допускают уточнение через переменные `--velo-analytics-*`.

## Обязательное правило процентной шкалы

- Проценты всех ненулевых категорий ВСЕГДА находятся внутри цветных сегментов.
- Переносить подписи под диаграмму, скрывать их или заменять только всплывающей подсказкой нельзя.
- Разрешено нарушать визуальные пропорции: каждому сегменту оставляется минимум места под подпись и внутренние отступы. Остальное место распределяется с учётом числа ответов.
- Проценты и численность остаются математически верными. Меняется только ширина сегмента, не данные.
- Доля между 0 и 1% отображается как `<1%`; между 99 и 100% — как `>99%`; ровно 100% — `100%`. Остальные значения округляются до целого процента.
- Нулевые категории не занимают место на составной полосе, но присутствуют в раскрытой расшифровке с нулевыми значениями.
- Подписи не переносятся, не обрезаются и не уменьшаются специально ради точных пропорций.
- В подробной расшифровке подписи находятся над отдельными полосами, как в исходном макете; ширина этих полос соответствует точной доле.

Ключевая реализация:

```css
.distribution__segment {
  min-width: max-content;
  padding-inline: var(--space-1);
  white-space: nowrap;
}
```

## Структура и поведение

1. Заголовок «Аналитика по практике» с возвратом.
2. Карточка практики: иконка направления, название, автор и аватар, дата, ученики и чек-ины.
3. «До практики»: исходно свёрнута, раскрывается кнопкой «Расшифровка».
4. «После практики»: исходно раскрыта. Оба раскрытия независимы.
5. «Пришел → ушел»: только ученики с обеими действительными отметками, первые четыре строки, раскрытие остальных и сворачивание.
6. «Отзывы»: только непустые комментарии, отдельная карточка для каждого.
7. Загрузка, ошибка с повтором, пустые ответы, отсутствие пар и отсутствие отзывов обработаны отдельно.
8. При смене практики раскрытия возвращаются в исходное состояние.

## Данные и интеграция

Текущий экран приложения: `frontend/src/views/master/PracticeReviewsView.vue`, маршрут `/master/analytics/practice/:id`.

Текущий `PracticeInsightsResponse` содержит три группы состояний, а `ReviewItem.rating` — три группы оценок. Из этих агрегатов нельзя восстановить пять категорий и персональные пары. Новый компонент поэтому принимает отдельный UI-контракт `PracticeAnalyticsData`; существующий API автоматически к нему не приводится. Контракт ниже НЕ является уже существующим серверным ответом.

Для подключения сервер или слой получения данных должен передать:

- `practice`: действующий `PracticeResponse`.
- `participants`: общее число учеников того же состава участников, для которого возвращены ответы.
- `answers`: полный список, одна запись на ученика в данной практике; `userId` уникален; `before` и `after` — исходные целочисленные оценки 1–10 или `null`; `comment` — текст или `null`.

Ответы 1–2 → «Плохо», 3–4 → «Не очень», 5–6 → «Нормально», 7–8 → «Хорошо», 9–10 → «Огонь». Используется существующий `moodKeyFromScore`, без дублирования границ.

`null`, нечисловые, дробные и выходящие за диапазон оценки не считаются ответами. До и после имеют собственные знаменатели. В пары попадают только действительные ответы одного ученика на обоих этапах. Число отзывов — количество непустых текстовых комментариев, а не количество оценок. Частичную страницу ответов нельзя выдавать за полный список: иначе агрегаты будут неверными.

Количество чек-инов в шапке берётся из `practice.checkin_count` — существующей метрики уникальных PRE чек-инов. При `null` показатель не отображается. Значения на референсе не зашиты в код.

Компонент сообщает о действиях через события `back` и `retry`. Загрузку данных выполняет родительский экран. Переносить эти компоненты следует в `frontend/src/components/shared/practice-analytics/`, сохранив их рядом. Текущий маршрут в рамках подготовки этого ТЗ не изменён.

## Готовый код для вставки

### `frontend/src/components/shared/practice-analytics/analytics.ts`

```typescript
import type { PracticeResponse } from '@/api/types'
import { MOOD_SCALE_KEYS, moodKeyFromScore, type MoodScaleKey } from '@/utils/moodScale'

export type MoodCounts = Record<MoodScaleKey, number>

// UI-контракт: полный список, одна запись на ученика; null — нет ответа.
// Это НЕ текущий PracticeInsightsResponse, который содержит лишь три группы.
export interface PracticeAnswer {
  userId: string
  name: string
  before: number | null
  after: number | null
  comment: string | null
}

export interface PracticeAnalyticsData {
  practice: PracticeResponse
  participants: number
  answers: PracticeAnswer[]
}

export function isScore(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 10
}

export function countMoods(answers: PracticeAnswer[], stage: 'before' | 'after'): MoodCounts {
  const counts: MoodCounts = { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 }
  for (const answer of answers) {
    const score = answer[stage]
    if (isScore(score)) counts[moodKeyFromScore(score)] += 1
  }
  return counts
}

export function moodTotal(counts: MoodCounts): number {
  return MOOD_SCALE_KEYS.reduce((total, key) => total + counts[key], 0)
}

export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%'
  if (percent > 99 && percent < 100) return '>99%'
  return `${Math.round(percent)}%`
}
```

### `frontend/src/components/shared/practice-analytics/PracticeMoodDistribution.vue`

```vue
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { VCard } from '@/components/ui'
import { IconGroup } from '@/components/icons'
import VShowMore from '@/components/shared/VShowMore.vue'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import { formatPercent, moodTotal, type MoodCounts } from './analytics'

const props = withDefaults(
  defineProps<{
    title: string
    counts: MoodCounts
    participants: number
    initiallyExpanded?: boolean
  }>(),
  { initiallyExpanded: false },
)

const expanded = ref(props.initiallyExpanded)
const detailsId = useId()
const titleId = useId()
const total = computed(() => moodTotal(props.counts))
const bars = computed(() =>
  MOOD_SCALE_KEYS.map((key) => {
    const percent = total.value ? (props.counts[key] / total.value) * 100 : 0
    return {
      key,
      count: props.counts[key],
      percent,
      label: MOOD_SCALE_LABELS[key],
    }
  }),
)
const visibleBars = computed(() => bars.value.filter((bar) => bar.count > 0))
const details = computed(() => [...bars.value].reverse())
</script>

<template>
  <VCard class="distribution" role="region" :aria-labelledby="titleId">
    <div class="distribution__heading">
      <h2 :id="titleId">{{ title }}</h2>
      <span class="distribution__count">
        <IconGroup :size="18" aria-hidden="true" /> {{ total }} из
        {{ participants }}
      </span>
    </div>

    <p v-if="total === 0" class="distribution__empty">Пока нет отметок</p>
    <template v-else>
      <div class="distribution__stack" role="list" :aria-label="title">
        <div
          v-for="bar in visibleBars"
          :key="bar.key"
          class="distribution__segment"
          role="listitem"
          :class="`distribution--${bar.key}`"
          :style="{ flex: `${bar.count} 1 0` }"
          :aria-label="`${bar.label}: ${bar.count}, ${formatPercent(bar.percent)}`"
        >
          <span aria-hidden="true">{{ formatPercent(bar.percent) }}</span>
        </div>
      </div>

      <div :id="detailsId" v-show="expanded" class="distribution__details">
        <div v-for="bar in details" :key="bar.key" :class="`distribution--${bar.key}`">
          <div class="distribution__label">
            <component :is="MOOD_SCALE_ICON[bar.key]" :size="22" aria-hidden="true" />
            <span>{{ bar.label }}</span>
            <span class="distribution__value"
              >({{ bar.count }}) {{ formatPercent(bar.percent) }}</span
            >
          </div>
          <div class="distribution__track" aria-hidden="true">
            <div class="distribution__fill" :style="{ width: `${bar.percent}%` }" />
          </div>
        </div>
      </div>
      <VShowMore
        :label="expanded ? 'Скрыть' : 'Расшифровка'"
        :aria-expanded="expanded"
        :aria-controls="detailsId"
        @click="expanded = !expanded"
      />
    </template>
  </VCard>
</template>

<style scoped>
.distribution {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.distribution__heading,
.distribution__label,
.distribution__count {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.distribution__heading {
  justify-content: space-between;
  flex-wrap: wrap;
}
.distribution h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.distribution__count {
  white-space: nowrap;
  font-size: var(--text-xs);
}
.distribution__stack {
  display: flex;
  gap: 3px;
  height: 28px;
  font-size: var(--text-12);
}
.distribution__segment {
  /* Подпись важнее пропорций: узкий сегмент расширяется под текст. */
  min-width: max-content;
  padding-inline: var(--space-1);
  white-space: nowrap;
  display: grid;
  place-items: center;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-analytics-fill);
  font-size: var(--text-12);
}
.distribution__details {
  display: grid;
  gap: var(--space-3);
}
.distribution__label {
  margin-bottom: var(--space-1);
  font-size: var(--text-base);
  flex-wrap: wrap;
}
.distribution__label svg {
  flex-shrink: 0;
}
.distribution__value {
  margin-left: auto;
  color: var(--velo-text-secondary);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.distribution__track {
  height: 11px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
}
.distribution__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--velo-analytics-fill);
}
/* Приближённые цвета референса; переопределяются в variables.css. */
.distribution--bad {
  --velo-analytics-fill: var(--velo-analytics-bad, #ff8c98);
}
.distribution--low {
  --velo-analytics-fill: var(--velo-analytics-low, #ffad61);
}
.distribution--neutral {
  --velo-analytics-fill: var(--velo-analytics-neutral, #fbd10b);
}
.distribution--good {
  --velo-analytics-fill: var(--velo-analytics-good, #b5eb82);
}
.distribution--fire {
  --velo-analytics-fill: var(--velo-analytics-fire, #55b8fa);
}
.distribution__empty {
  margin: 0;
  color: var(--velo-text-secondary);
}
.distribution :deep(.v-show-more) {
  min-height: 44px;
}
.distribution :deep(.v-show-more:focus-visible) {
  outline: 2px solid var(--velo-primary);
  outline-offset: 3px;
}
</style>
```

### `frontend/src/components/shared/practice-analytics/PracticeAnalytics.vue`

```vue
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
```

## Подключение к экрану

После реализации загрузки `PracticeAnalyticsData` родительский экран передаёт состояние:

```vue
<PracticeAnalytics
  :data="analyticsData"
  :loading="analyticsLoading"
  :error="analyticsError"
  @back="router.back()"
  @retry="loadAnalytics"
/>
```

```typescript
import PracticeAnalytics from '@/components/shared/practice-analytics/PracticeAnalytics.vue'
import type { PracticeAnalyticsData } from '@/components/shared/practice-analytics/analytics'
```

`analyticsData: PracticeAnalyticsData | null`, `analyticsLoading: boolean`, `analyticsError: string | null` и `loadAnalytics` принадлежат экрану загрузки. Этот пример показывает подключение представления; `loadAnalytics` не выдаётся за существующую функцию API.

## Проверки

Код проверен `vue-tsc` с настройками текущего проекта. Шесть адресных тестов проверяют:

- граничное округление долей;
- исключение отсутствующих и некорректных ответов;
- наличие подписей внутри всех сегментов при распределении 1/9999 и 1/1/1/1/9996;
- отсутствие ответов и единственный сегмент на 100%;
- полные пары, отзывы, раскрытие списка и сброс при смене практики;
- загрузку и повтор после ошибки.

Тесты находятся рядом с компонентами: `docs/proposals/practice-analytics/analytics.test.ts`. При переносе рядом с компонентами в `src/` они запускаются штатным Vitest.

Проверка в браузере, сравнение с изображением и проверка в Telegram на физических устройствах ещё не выполнены. До интеграции нужно визуально проверить ширины 360, 390 и desktop, длинные названия и сочетания очень маленьких и больших долей. Проверка типов и тесты поведения не подтверждают точное визуальное совпадение.
