<!--
  VELO Frontend -- MasterPublicView (Calendar iteration, S-4)

  Public master profile shown to users who tap "Подробнее" on a practice's
  master card (frame 4). Figma node 541:2065:
    - Hero card: avatar, name, "check Верифицирован" badge + "N лет опыта" pill, bio
    - Two stat cards: practices_count "Практик" / reviews_count "Отзывов"
    - "Методы" accordion (method chips)
    - "Ближайшие практики": upcoming practices by this master (reuses
      getPractices with master_id -- no new endpoint, no dedicated store)
    - "Задать вопрос" button -> ask-master flow (frame 6, not built yet:
      toast placeholder, V2)

  Backend: GET /api/v1/masters/:id (MasterPublicResponse). Only verified
  masters resolve; 404 otherwise -> "Мастер не найден" (no retry, nothing to
  retry). A 5xx/network failure is a DIFFERENT empty state -- "Не удалось
  загрузить" with a "Повторить" retry -- since the master may well exist
  (B11 item 2, ПРОМТ №587; before this both collapsed into "не найден").

  Route: /user/masters/:id  (name: user-master-public)
-->

<template>
  <div class="master-public">
    <VHeader title="Мастер" show-back @back="router.back()" />

    <!-- Loading -->
    <div v-if="loading" class="master-public__loader">
      <VLoader size="lg" />
    </div>

    <!-- Not found (404): the master genuinely doesn't exist / isn't verified. -->
    <VEmptyState
      v-else-if="notFound"
      icon="warning"
      title="Мастер не найден"
      :description="error ?? undefined"
    >
      <VButton size="sm" @click="router.back()">Назад</VButton>
    </VEmptyState>

    <!-- Server/network error (B11 item 2): distinct from "not found" -- this
         master may well exist, the load just failed and is worth retrying. -->
    <VEmptyState
      v-else-if="error || !profile"
      icon="warning"
      title="Не удалось загрузить"
      :description="error ?? undefined"
    >
      <VButton size="sm" @click="loadMaster(masterId)">Повторить</VButton>
    </VEmptyState>

    <!-- Content -->
    <div v-else class="master-public__content">
      <!-- Hero -->
      <VCard class="master-public__hero" padding="none">
        <VAvatar :url="profile.avatar_url ?? ''" :name="displayName" size="xl" />

        <h1 class="master-public__name">{{ displayName }}</h1>

        <div class="master-public__pills">
          <span class="master-public__pill master-public__pill--verified">
            <IconCheck :size="14" /> Верифицирован
          </span>
          <span v-if="profile.experience_years != null" class="master-public__pill">
            {{ profile.experience_years }} {{ pluralYears(profile.experience_years) }} опыта
          </span>
        </div>

        <p v-if="profile.bio" class="master-public__bio">{{ profile.bio }}</p>
      </VCard>

      <!-- Stats -->
      <div class="master-public__stats">
        <VStatCard
          layout="row"
          :value="profile.practices_count"
          :label="pluralPractices(profile.practices_count)"
        />
        <VStatCard
          layout="row"
          :value="profile.reviews_count"
          :label="pluralReviews(profile.reviews_count)"
        />
      </div>

      <!-- Methods accordion -->
      <VAccordion v-if="profile.methods?.length" title="Методы">
        <div class="master-public__chips">
          <VTag
            v-for="(method, i) in profile.methods || []"
            :key="method"
            :variant="TAG_VARIANTS[i % TAG_VARIANTS.length]"
          >
            {{ method }}
          </VTag>
        </div>
      </VAccordion>

      <!-- Ближайшие практики: СВЁРНУТЫЙ по умолчанию аккордеон (operator
           2026-06-05) — чтобы кнопка «Задать вопрос» была сразу видна, без
           скролла мимо всех практик. Заголовок = белая плашка (консистентно с
           «Методы»); тело прозрачное -> карточки лежат отдельными прямоугольниками
           на фоне (не сливаются бело-на-белом). show-date: практики идут в разные
           дни — карточка показывает дату под иконкой + время в мета-линии. -->
      <div v-if="upcoming.length" class="master-public__upcoming">
        <VAccordion title="Ближайшие практики">
          <div class="master-public__practices">
            <CalendarPracticeCard
              v-for="p in upcoming"
              :key="p.id"
              :practice="p"
              show-date
              @click="goToPractice"
            />
          </div>
        </VAccordion>
      </div>

      <!-- Ask a question (frame 6 -- not built yet) -->
      <div class="master-public__actions">
        <VButton variant="primary" size="lg" block @click="onAsk"> Задать вопрос </VButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VLoader,
  VEmptyState,
  VButton,
  VAccordion,
  VTag,
  VAvatar,
  VStatCard,
  VCard,
} from '@/components/ui'
import { VHeader } from '@/components/layout'
import { IconCheck } from '@/components/icons'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import { getPublicMaster } from '@/api/masters'
import { getPractices } from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { plural } from '@/utils/plural'
import type { MasterPublicResponse, PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const profile = ref<MasterPublicResponse | null>(null)
const upcoming = ref<PracticeResponse[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
/** B11 item 2: 404 (master genuinely doesn't exist) is a DIFFERENT state
 *  from a 5xx/network failure (server down, worth retrying) -- collapsing
 *  them both into "Мастер не найден" told the user to give up on a master
 *  who might well exist. Derived from the caught error's own status, no
 *  backend field added. */
const notFound = ref(false)

const masterId = computed(() => String(route.params.id))

const displayName = computed(() => profile.value?.display_name ?? 'Мастер')

// Method tags cycle through three tints (same as MasterCard).
const TAG_VARIANTS = ['blue', 'pink', 'sand'] as const

// -- Russian pluralization helpers (SW14: canonical impl in utils/plural.ts) --
function pluralYears(n: number): string {
  return plural(n, 'год', 'года', 'лет')
}
function pluralPractices(n: number): string {
  return plural(n, 'Практика', 'Практики', 'Практик')
}
function pluralReviews(n: number): string {
  return plural(n, 'Отзыв', 'Отзыва', 'Отзывов')
}

function goToPractice(id: string): void {
  router.push({ name: 'practice-detail', params: { id } })
}

function onAsk(): void {
  // Ask-master flow (Figma frame 6) is a separate iteration with its own
  // backend endpoint. Placeholder until then (V2).
  toast.info('Вопрос мастеру -- скоро')
}

async function loadMaster(id: string): Promise<void> {
  loading.value = true
  error.value = null
  notFound.value = false
  try {
    profile.value = await getPublicMaster(id)
    // Upcoming practices by this master: reuse the public feed with a
    // master_id filter + scheduled status. One small page is enough.
    try {
      const res = await getPractices(
        {
          master_id: id,
          status: 'scheduled',
          sort_by: 'scheduled_at',
          sort_order: 'asc',
        },
        10,
        0,
      )
      upcoming.value = res.items
    } catch {
      // Non-fatal: the profile still renders without the upcoming list.
      upcoming.value = []
    }
  } catch (e) {
    const is404 = e instanceof ApiResponseError && e.status === 404
    notFound.value = is404
    error.value = extractApiError(e, is404 ? 'Профиль недоступен' : 'Попробуйте позже')
    profile.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMaster(masterId.value)
})

// B11 item 2: Vue Router reuses this component instance when a navigation
// only changes route params under the same matched record (master A's
// public page -> master B's), so onMounted alone never re-fires.
watch(masterId, (id) => {
  void loadMaster(id)
})
</script>

<style scoped>
.master-public {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.master-public__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.master-public__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* Горизонтальный отступ раздаёт шелл (--velo-rail-pad-x=24), как на всех
   * экранах; локально только vertical — иначе был двойной padding и контент
   * у́же других экранов (operator 2026-06-04). */
  padding: var(--space-4) 0;
}

/* Hero */
.master-public__hero {
  padding: var(--space-5) var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.master-public__name {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.master-public__pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.master-public__pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.master-public__pill--verified {
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

.master-public__bio {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
  margin: var(--space-1) 0 0;
}

/* Stats — two compact baseline-row VStatCards (layout="row"), each flexes equally. */
.master-public__stats {
  display: flex;
  gap: var(--space-3);
}

.master-public__stats > * {
  flex: 1;
}

/* Sections */
.master-public__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

/* «Ближайшие практики» — свёрнутый аккордеон. Контейнер прозрачный (чтобы тело
 * не было белой плашкой), заголовок = белая плашка как «Методы», тело прозрачное
 * -> карточки лежат на фоне отдельными прямоугольниками (без «слитности»). */
.master-public__upcoming :deep(.v-accordion) {
  background: transparent;
  border: none;
  border-radius: 0;
  overflow: visible;
}

.master-public__upcoming :deep(.v-accordion__header) {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
}

.master-public__upcoming :deep(.v-accordion__body) {
  padding: var(--space-2) 0 0;
}

.master-public__practices {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.master-public__actions {
  margin-top: var(--space-2);
}

/* Аккордеон «Методы»: белая card-плашка (тот же приём, что аккордеоны на
   экране практики; локально, без правки общего VAccordion). */
:deep(.v-accordion) {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  border-bottom: none;
  overflow: hidden;
}

:deep(.v-accordion__header) {
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

:deep(.v-accordion__body) {
  padding: 0 var(--space-4) var(--space-3);
}

:deep(.v-accordion__arrow) {
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
}
</style>
