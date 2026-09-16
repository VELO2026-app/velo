<!--
  VELO Frontend -- FeedbackView

  Full-screen post-practice feedback form.
  Uses FormShell for shared layout/CSS. Only rating-specific logic stays here.

  Route: /user/feedback/:practiceId
  Param: practiceId (practice UUID)
-->

<template>
  <FormShell
    v-model:comment="comment"
    back-label="Feedback"
    :practice="practice"
    :practice-loading="practiceLoading"
    :load-error="practiceLoadError"
    question-title="Как прошла практика?"
    question-subtitle="Оцените своё состояние после"
    :submitting="diaryStore.feedbackSubmitting"
    :submit-disabled="false"
    submit-label="Отправить feedback"
    :submitted="submitted"
    success-icon=""
    success-title="Спасибо за feedback!"
    success-text="Ваш отзыв поможет нам улучшить практики"
    @back="onBack"
    @retry="loadPractice"
    @submit="onSubmit"
  >
    <!-- Practice meta — две колонки (Figma 2266:2988): мастер | статус. -->
    <template #practice-meta>
      <span class="form-shell__practice-meta-cell">
        с {{ practice?.master_name ?? 'Мастером' }}
      </span>
      <span class="form-shell__practice-meta-cell"> <IconCalendar :size="14" /> Завершена </span>
    </template>

    <!-- Rating slider -->
    <template #selection>
      <div class="feedback__rating">
        <MoodSlider
          v-model="ratingScore"
          :zones="RATING_ZONES"
          aria-label="Оценка практики от 1 до 10"
        />
      </div>
    </template>

    <!-- Success icon: teal heart (Figma 2266:2305, 93x87 native viewBox) -->
    <template #success-icon>
      <span class="feedback__success-heart">
        <IconHeart :size="80" />
      </span>
    </template>

    <!-- Success actions: primary "В дневник" + text link "На главную" (Figma 2266:2296) -->
    <template #success-actions>
      <VButton variant="primary" size="lg" block @click="goToDiary"> В дневник </VButton>
      <button type="button" class="feedback__success-link" @click="goToDashboard">
        На главную
      </button>
    </template>
  </FormShell>
</template>

<script setup lang="ts">
import { historyHasBack } from '@/platform/history'
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useBookingsStore } from '@/stores/bookings'
import { useDiaryStore } from '@/stores/diary'
import { useToast } from '@/composables/useToast'
import { platform } from '@/platform'
import { VButton } from '@/components/ui'
import {
  IconRatingConfused,
  IconRatingGood,
  IconRatingFire,
  IconHeart,
  IconCalendar,
} from '@/components/icons'
import FormShell from '@/components/shared/FormShell.vue'
import MoodSlider from '@/components/shared/MoodSlider.vue'
import { RATING_ICON_COLOR } from '@/utils/displayHelpers'

// Three slider zones (low -> high), passed to MoodSlider. Icons are .vue
// components so they stay in the view. Per-zone color keeps the Figma tint
// (confused = brand blue, good = rose, fire = peach) via --velo-rating-*.
const RATING_ZONES = [
  { icon: IconRatingConfused, label: 'Есть вопросы', color: RATING_ICON_COLOR.confused },
  { icon: IconRatingGood, label: 'Хорошо', color: RATING_ICON_COLOR.good },
  { icon: IconRatingFire, label: 'Огонь!', color: RATING_ICON_COLOR.fire },
]

const route = useRoute()
const router = useRouter()
const practicesStore = usePracticesStore()
const bookingsStore = useBookingsStore()
const diaryStore = useDiaryStore()
const toast = useToast()

const practiceId = route.params.practiceId as string

const practice = computed(() => practicesStore.selected)
const practiceLoading = computed(() => practicesStore.selectedLoading)
const practiceLoadError = computed(() => practicesStore.selectedError)

const ratingScore = ref<number>(6)
const comment = ref('')
const submitted = ref(false)

// One feedback per practice -- OUR product decision, NOT an API constraint. The
// endpoint is an upsert and would accept a second one, overwriting the rating
// already recorded. We block it because the overwrite is SILENT: it happens by
// navigating back into this screen, and the person never learns they erased their
// own earlier review. Feedback also feeds the master's analytics, so a "three
// stars" a master already read can quietly become five with no trace.
//
// So this is a UI gate over a permissive API and the backend will NOT catch a bug
// here -- its tests are the only thing holding it. Revisable reviews, if we ever
// want them, are a deliberate feature with an honest "edit your review" button and
// a warning, not a side effect of pressing back.
//
// Mirrors CheckinView:148 exactly, down to reading the flag off the already-loaded
// booking list rather than an extra request. Sibling screens diverging is the habit
// that has bitten this repo four times; matching the shape IS the fix.
const alreadyGaveFeedback = computed<boolean>(() =>
  bookingsStore.bookings.some((b) => b.practice_id === practiceId && b.has_feedback),
)

async function onSubmit(): Promise<void> {
  if (diaryStore.feedbackSubmitting || alreadyGaveFeedback.value) return

  const result = await diaryStore.submitFeedback(practiceId, {
    rating: ratingScore.value,
    comment: comment.value.trim() || null,
  })

  if (result.ok) {
    try {
      platform.hapticFeedback('medium')
    } catch {
      /* silent fallback */
    }
    submitted.value = true
    // Refresh bookings so `has_feedback` is up to date this session -- the
    // dashboard feedback banner and the practice-detail button read it.
    void bookingsStore.refreshBookings()
  } else {
    toast.error(result.error)
  }
}

function onBack(): void {
  // Возврат на тот экран, с которого пришёл пользователь (дашборд, детали
  // практики, ...). Fallback на дашборд, если истории нет — например, после
  // релоада или прямой ссылки в Telegram.
  const hasHistory = historyHasBack()
  if (hasHistory) {
    router.back()
  } else {
    void router.push({ name: 'user-dashboard' })
  }
}

function goToDiary(): void {
  void router.push({ name: 'user-diary' })
}

function goToDashboard(): void {
  void router.push({ name: 'user-dashboard' })
}

// Named so the error rung's «Повторить» can re-run exactly what onMounted ran.
// Unconditional: the guard below is a cache check for the mount path, but a retry
// means the last attempt FAILED, so there is nothing cached to skip for.
function loadPractice(): void {
  void practicesStore.fetchPractice(practiceId)
}

// If the flag flips while the form is open -- another screen refreshes the list,
// or the post-submit refreshBookings lands -- swap to the success screen rather
// than leave a live form over a review that already exists. Mirrors CheckinView:216.
watch(alreadyGaveFeedback, (done) => {
  if (done) submitted.value = true
})

onMounted(async () => {
  if (practicesStore.selected?.id !== practiceId) {
    loadPractice()
  }
  // Ensure bookings are loaded so `has_feedback` is available -- this screen did
  // not load them at all before, which is why it had no gate to build on.
  // fetchMyBookings is a no-op when the list is already populated (arriving from
  // the dashboard); on a direct deep-link it performs the initial load
  // (bookings.ts:132). Mirrors CheckinView:234.
  await bookingsStore.fetchMyBookings()
  if (alreadyGaveFeedback.value) {
    submitted.value = true
  }
})
</script>

<style scoped>
/* Rating slider wrapper -- the slider carries its own styles. */
.feedback__rating {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
}

.feedback__success-heart {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-teal-400);
}

.feedback__success-link {
  background: none;
  border: none;
  padding: 0;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  cursor: pointer;
}

.feedback__success-link:hover {
  opacity: 0.7;
}

.feedback__success-link:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 4px;
  border-radius: var(--radius-md);
}
</style>
