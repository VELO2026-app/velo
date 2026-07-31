<!--
  VELO Frontend -- ReflectionView

  Full-screen gentle reflection form shown to a User whose booking is
  «Не состоялась» (no_show). Sibling of FeedbackView: same FormShell layout,
  but NO rating slider — a no-show reflection only invites the user to share how
  they are (comment), it never rates a practice they didn't attend.

  Copy rotates per booking (utils/reflectionVariants, stable by practiceId).

  STUB (TD-REFLECTION, PROMPT №269): submit persists NOTHING — the backend
  `POST /api/v1/practices/{id}/reflection` endpoint does not exist yet (see
  VELO-Backend-Tasks.md). The flow completes honestly in the UI (thank-you
  screen, no "saved" claim) and the dashboard banner is dismissed client-side
  for the session.

  Route: /user/reflection/:practiceId
  Param: practiceId (practice UUID)
-->

<template>
  <FormShell
    back-label="Практика"
    :practice="practice"
    :practice-loading="practiceLoading"
    :load-error="practiceLoadError"
    :question-title="variant.screenTitle"
    :question-subtitle="variant.screenSubtitle"
    v-model:comment="comment"
    :submitting="diaryStore.reflectionSubmitting"
    :submit-disabled="false"
    submit-label="Отправить"
    :submitted="submitted"
    success-icon=""
    success-title="Спасибо, что поделились"
    success-text="Бережно к себе. Возвращайтесь, когда будете готовы."
    @back="onBack"
    @retry="loadPractice"
    @submit="onSubmit"
  >
    <!-- Practice meta — мастер | honest no-show статус (F1: «Не состоялась»). -->
    <template #practice-meta>
      <span class="form-shell__practice-meta-cell">
        с {{ practice?.master_name ?? 'Мастером' }}
      </span>
      <span class="form-shell__practice-meta-cell">
        <IconCalendar :size="14" /> Не состоялась
      </span>
    </template>

    <!-- No #selection slot: a no-show reflection has no rating slider. -->

    <!-- Success icon: teal heart (same gratitude motif as FeedbackView). -->
    <template #success-icon>
      <span class="reflection__success-heart">
        <IconHeart :size="80" />
      </span>
    </template>
    <template #success-actions>
      <VButton variant="primary" size="lg" block @click="goToDashboard"> На главную </VButton>
    </template>
  </FormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useBookingsStore } from '@/stores/bookings'
import { useDiaryStore } from '@/stores/diary'
import { useToast } from '@/composables/useToast'
import { platform } from '@/platform'
import { VButton } from '@/components/ui'
import { IconHeart, IconCalendar } from '@/components/icons'
import FormShell from '@/components/shared/FormShell.vue'
import { pickReflectionVariant } from '@/utils/reflectionVariants'

const route = useRoute()
const router = useRouter()
const practicesStore = usePracticesStore()
const bookingsStore = useBookingsStore()
const diaryStore = useDiaryStore()
const toast = useToast()

const practiceId = route.params.practiceId as string

// Stable per-booking copy — same booking always renders the same variant
// (no flicker on the dashboard's 60s re-eval; PROMPT №269 F5=А).
const variant = pickReflectionVariant(practiceId)

const practice = computed(() => practicesStore.selected)
const practiceLoading = computed(() => practicesStore.selectedLoading)
const practiceLoadError = computed(() => practicesStore.selectedError)

const comment = ref('')
const submitted = ref(false)

async function onSubmit(): Promise<void> {
  if (diaryStore.reflectionSubmitting) return

  const result = await diaryStore.submitReflection(practiceId, {
    comment: comment.value.trim() || null,
  })

  if (result.ok) {
    try {
      platform.hapticFeedback('medium')
    } catch {
      /* silent fallback */
    }
    // No backend `has_reflection` flag yet (TD-REFLECTION): dismiss client-side
    // so the dashboard no-show banner hides for this session.
    bookingsStore.dismissReflection(practiceId)
    submitted.value = true
  } else {
    toast.error(result.error)
  }
}

function onBack(): void {
  // Return to wherever the user came from (dashboard, bookings, ...). Fallback
  // to the dashboard on a direct link / reload with no history.
  const hasHistory = window.history.state?.back != null
  if (hasHistory) {
    router.back()
  } else {
    router.push({ name: 'user-dashboard' })
  }
}

function goToDashboard(): void {
  router.push({ name: 'user-dashboard' })
}

// Named so the error rung's «Повторить» can re-run exactly what onMounted ran.
// Unconditional: the guard below is a cache check for the mount path, but a retry
// means the last attempt FAILED, so there is nothing cached to skip for.
function loadPractice(): void {
  void practicesStore.fetchPractice(practiceId)
}

onMounted(() => {
  if (practicesStore.selected?.id !== practiceId) {
    loadPractice()
  }
})
</script>

<style scoped>
.reflection__success-heart {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-teal-400);
}
</style>
