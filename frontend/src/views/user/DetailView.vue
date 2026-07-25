<!--
  VELO Frontend -- DetailView (Diary redesign, Batch 1b; screen 52)

  Read-only detail for a check-in or a feedback, opened by tapping the
  corresponding card in the diary feed (DiaryFeedView.onTap -> route
  user-diary-detail with :type = checkin|feedback and :id = the row id).

  The :type segment is constrained to checkin|feedback in the route regex,
  so an invalid type never reaches this component (it 404s at the router).

  Data flow (mirrors EntryView):
    - the row itself (mood/rating, full comment, created_at, practice_id)
      comes from getCheckin(id) / getFeedback(id);
    - the optional practice header is built from GET /practices/{practice_id}
      when the row is linked to a practice. The verified badge is omitted
      (PracticeResponse carries no verified flag -- same call as EntryView).

  No store: this is a one-shot read with no caching or mutations, loaded
  directly via the api wrappers (like getPractice).

  Relationships ("Найдена взаимосвязь", screens 53-55) is an AI feature
  outside the MVP and is deliberately NOT rendered here.
-->

<template>
  <div class="detail">
    <!-- Header: arrow-only back-pill (63×35) + left-aligned title (Figma "View entry") -->
    <header class="detail__header">
      <VBackButton aria-label="Назад" @click="goBack" />
      <h1 class="detail__title-bar">Запись</h1>
    </header>

    <!-- Body -->
    <div class="detail__body">
      <!-- Loading -->
      <div v-if="loading" class="detail__state">
        <VLoader size="lg" />
      </div>

      <!-- Error -->
      <VEmptyState
        v-else-if="loadError"
        icon="warning"
        title="Не удалось загрузить запись"
        :description="loadError"
      >
        <template #action>
          <VButton variant="primary" @click="reload">Повторить</VButton>
        </template>
      </VEmptyState>

      <template v-else-if="loaded">
        <!-- Linked practice summary (DS PracticeListCard, 336×104). -->
        <PracticeListCard
          v-if="practice"
          :practice="practice"
          :when="practiceTime"
          :duration="practiceDuration"
          :clickable="false"
          :show-verified="false"
        />

        <!-- The check-in / feedback pill -->
        <VCard class="detail__pill" padding="none">
          <span class="detail__pill-icon">
            <component :is="leadIcon" :size="32" />
          </span>
          <span class="detail__pill-title">{{ pillTitle }}</span>
        </VCard>

        <!-- The detail card -->
        <VCard class="detail__card">
          <p class="detail__date">{{ dateLine }}</p>
          <p v-if="comment" class="detail__content">{{ comment }}</p>
          <p v-else class="detail__empty">Без комментария</p>
          <p v-if="contextLine" class="detail__context">{{ contextLine }}</p>
        </VCard>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VLoader, VEmptyState, VButton, VBackButton, VCard } from '@/components/ui'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'
import { IconMoodMid, IconRatingGood } from '@/components/icons'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'
import { getCheckin, getFeedback } from '@/api/diary'
import { getPractice } from '@/api/practices'
import { formatFeedDateTime, formatDuration, formatTime } from '@/utils/format'
import {
  moodZoneFromScore,
  ratingZoneFromScore,
  moodLabelFromScore,
  ratingLabelFromScore,
} from '@/utils/displayHelpers'
import { MOOD_ICON, RATING_ICON } from '@/utils/ratingIcons'
import type { CheckinResponse, FeedbackResponse, PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const tz = computed(() => authStore.user?.timezone ?? 'UTC')
const detailType = computed<'checkin' | 'feedback'>(() =>
  route.params.type === 'feedback' ? 'feedback' : 'checkin',
)
const detailId = computed(() => String(route.params.id))

// -- loaded row + practice header --------------------------------------------

const checkin = ref<CheckinResponse | null>(null)
const feedback = ref<FeedbackResponse | null>(null)
const practice = ref<PracticeResponse | null>(null)

const loading = ref(false)
const loadError = ref<string | null>(null)
const loaded = computed(() => checkin.value !== null || feedback.value !== null)

// -- icon / label maps (kind|mood|rating -> component; .vue can't live in
//    displayHelpers, mirrors DiaryFeedCard) ----------------------------------

const leadIcon = computed<Component>(() => {
  if (detailType.value === 'checkin') {
    return MOOD_ICON[moodZoneFromScore(checkin.value?.mood ?? 6)] ?? IconMoodMid
  }
  return RATING_ICON[ratingZoneFromScore(feedback.value?.rating ?? 6)] ?? IconRatingGood
})

const pillTitle = computed(() => {
  if (detailType.value === 'checkin') {
    const mood = checkin.value?.mood
    const label = mood !== undefined ? moodLabelFromScore(mood) : ''
    return label ? `Check-in: ${label}` : 'Check-in'
  }
  const rating = feedback.value?.rating
  const label = rating !== undefined ? ratingLabelFromScore(rating) : ''
  return label ? `Feedback: ${label}` : 'Feedback'
})

const comment = computed(() => checkin.value?.comment ?? feedback.value?.comment ?? null)

const createdAt = computed(() => checkin.value?.created_at ?? feedback.value?.created_at ?? null)
const dateLine = computed(() =>
  createdAt.value ? formatFeedDateTime(createdAt.value, tz.value) : '',
)

// -- practice header (rendered by PracticeListCard) --------------------------

const practiceTime = computed(() =>
  practice.value ? formatTime(practice.value.scheduled_at, tz.value) : '',
)
const practiceDuration = computed(() =>
  practice.value ? formatDuration(practice.value.duration_minutes) : '',
)

// Context line under the comment: relates this check-in / feedback to the
// linked practice ("Перед практикой: X с Y" / "После практики: X с Y").
const contextLine = computed(() => {
  if (!practice.value) return ''
  const name = practice.value.master_name ?? 'Мастером'
  const rel = detailType.value === 'checkin' ? 'Перед практикой' : 'После практики'
  return `${rel}: ${practice.value.title} с ${name}`
})

// -- load --------------------------------------------------------------------

async function reload(): Promise<void> {
  loading.value = true
  loadError.value = null
  checkin.value = null
  feedback.value = null
  practice.value = null
  try {
    let practiceId: string | null = null
    if (detailType.value === 'checkin') {
      const row = await getCheckin(detailId.value)
      checkin.value = row
      practiceId = row.practice_id
    } else {
      const row = await getFeedback(detailId.value)
      feedback.value = row
      practiceId = row.practice_id
    }
    if (practiceId) {
      try {
        practice.value = await getPractice(practiceId)
      } catch {
        // Practice header is best-effort; degrade to no header.
        practice.value = null
      }
    }
  } catch (e) {
    loadError.value = extractApiError(e, 'Запись не найдена')
  } finally {
    loading.value = false
  }
}

onMounted(reload)

// -- navigation --------------------------------------------------------------

function goBack(): void {
  void router.push({ name: 'user-diary' })
}
</script>

<style scoped>
/* Read-only variant of EntryView's layout: fixed header + scrolling body,
   no menu / no save bar. Tokens only (variables.css). */
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* -- Header: arrow-only back-pill (63×35) + left-aligned title -- */
.detail__header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-8) var(--space-3);
}

.detail__title-bar {
  font-family: var(--font-heading);
  font-size: var(--text-base);
  letter-spacing: 0.36px;
  color: var(--velo-text-primary);
}

/* -- Body (scrolls) -- */
.detail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 0 var(--space-8) var(--space-4);
}

.detail__state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

/* (Practice header is now rendered by the shared PracticeListCard.) */

/* -- Check-in / feedback pill (lead icon + title) -- */
.detail__pill {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}

.detail__pill-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
}

.detail__pill-title {
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-primary);
}

/* -- Detail card (date + full comment) -- */
.detail__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.detail__date {
  font-size: var(--text-12);
  letter-spacing: 0.2475px;
  opacity: 0.6;
  color: var(--velo-text-primary);
}

.detail__content {
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--velo-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Muted context line linking the entry to its practice. */
.detail__context {
  font-size: var(--text-12);
  letter-spacing: 0.2475px;
  color: var(--velo-text-secondary);
}

.detail__empty {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  opacity: 0.7;
}
</style>
