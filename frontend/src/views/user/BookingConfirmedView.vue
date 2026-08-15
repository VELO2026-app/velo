<!--
  VELO Frontend -- BookingConfirmedView (Calendar iteration, frame 5)

  Full-screen confirmation shown AFTER a successful booking. Figma 541:2120:
    - Success card: celebration icon (IconSuccess) in a teal circle,
      "Практика забронирована!", "Ссылка на Zoom появится за 10 минут до
      начала." (static line).
    - "Ваш запрос мастеру (по желанию)" textarea + teal info banner.
      REAL since the chat landed (TD-ASK-MASTER retired): "Отправить запрос"
      opens-or-gets the eternal DM with THIS practice's master
      (POST /api/v1/chats is create-or-get, so a second tap lands in the same
      thread), posts the typed text as a message and navigates into the
      thread. Same shape as «Задать вопрос» on MasterPublicView, plus the
      message: the master id comes from the loaded practice (master_id is
      non-null on PracticeResponse), so nothing extra is fetched.
    - No in-page navigation buttons: the bottom tab bar handles it (this route
      highlights the Calendar tab via meta.activeTab).

  Reached via router.push from PracticeDetailView.onPurchased. The screen is
  self-contained: it loads the practice by id (survives reload / deep link).

  Route: /user/booking-confirmed/:practiceId (name: user-booking-confirmed)
-->

<template>
  <div class="booking-confirmed">
    <!-- Loading -->
    <div v-if="store.selectedLoading && !practice" class="booking-confirmed__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error / not found -->
    <VEmptyState
      v-else-if="store.selectedError || !practice"
      icon="warning"
      title="Практика не найдена"
      :description="store.selectedError ?? 'Не удалось загрузить практику'"
    >
      <VButton size="sm" @click="goToDashboard">На главную</VButton>
    </VEmptyState>

    <!-- Content -->
    <div v-else class="booking-confirmed__content">
      <!-- Success card -->
      <VCard class="booking-confirmed__card" padding="none">
        <span class="booking-confirmed__icon">
          <IconSuccess :size="56" />
        </span>
        <h1 class="booking-confirmed__title">Практика забронирована!</h1>
        <p class="booking-confirmed__text">Ссылка на Zoom появится за 10 минут до начала.</p>
      </VCard>

      <!-- Ask-master request — REAL: the text becomes the first message of the
           DM with this practice's master. The send button follows the chat
           composer's own rule (ChatThreadScreen.vue:94): disabled while a send
           is in flight AND while the field is blank — "Отправить запрос" with
           nothing to send would open a thread and post nothing. The field is
           still optional (the label says so): skipping it simply leaves the
           block untouched. maxlength mirrors the chat composer's own cap. -->
      <div class="booking-confirmed__ask">
        <VTextarea
          v-model="masterRequest"
          label="Ваш запрос мастеру (по желанию)"
          :rows="2"
          maxlength="4000"
          :disabled="sending"
        />
        <Banner
          variant="info"
          body="Оставляя запрос, вы помогаете мастеру подготовить практику с учётом ваших пожеланий"
        >
          <template #icon><IconSupport :size="28" /></template>
        </Banner>
        <VButton
          variant="secondary"
          size="lg"
          block
          :loading="sending"
          :disabled="sending || !masterRequest.trim()"
          @click="onSendRequest"
        >
          Отправить запрос
        </VButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useToast } from '@/composables/useToast'
import { VLoader, VEmptyState, VButton, VTextarea, VCard } from '@/components/ui'
import Banner from '@/components/shared/Banner.vue'
import { IconSuccess, IconSupport } from '@/components/icons'
import { openChat, sendChatMessage } from '@/api/chats'
import { extractApiError } from '@/composables/useApiError'
import { formatDate, cleanPracticeTitle } from '@/utils/format'
import { useViewerTimezone } from '@/composables/useViewerTimezone'

const route = useRoute()
const router = useRouter()
const store = usePracticesStore()
const toast = useToast()

const practiceId = route.params.practiceId as string

// usePracticesStore is a session-lifetime singleton: store.selected can still
// hold a DIFFERENT practice left over from an earlier screen while this
// screen's own fetch for `practiceId` is in flight (or has failed). Without
// this id check, that stale value satisfies "we have a practice" and the
// loading guard (.vue:26) is skipped, letting the success card flash before
// the real fetch settles -- same guard class as CalendarView's weekPractices
// bug (fixed e5003b4): trusting that ANY data present is the RIGHT data for
// what is currently on screen.
const practice = computed(() => (store.selected?.id === practiceId ? store.selected : null))
const viewerTz = useViewerTimezone()

// The first message of the DM with this practice's master.
const masterRequest = ref('')
const sending = ref(false)

// The thread is ONE eternal DM per (client, master) pair, not one per
// practice -- so a bare question arrives with no indication of which practice
// prompted it, and a master running several cannot tell. Owner-ruled: prefix
// the practice, separated by a blank line so it reads as a caption rather than
// as the person's own words. Time is rendered in the VIEWER's timezone, the
// same one the rest of this screen's practice data is shown in.
function composeRequest(body: string): string {
  const p = practice.value
  if (!p) return body
  const when = formatDate(p.scheduled_at, viewerTz.value)
  return `Практика: ${cleanPracticeTitle(p.title)}, ${when}\n\n${body}`
}

async function onSendRequest(): Promise<void> {
  // Two calls, in order: open-or-get the thread, then post the text into it.
  // Both are guarded by ONE in-flight flag (same shape as MasterPublicView's
  // onAsk, plus the send). A failure anywhere leaves the text in the field and
  // toasts -- the retry is safe because POST /chats dedups on the pair, so a
  // second attempt re-uses the same thread instead of making another.
  const body = masterRequest.value.trim()
  const masterId = practice.value?.master_id
  if (!body || !masterId || sending.value) return
  sending.value = true
  try {
    const thread = await openChat(masterId)
    await sendChatMessage(thread.id, composeRequest(body))
    masterRequest.value = ''
    // B43: replace, not push -- this screen must not remain in history once
    // the thread opens, or `router.back()` from ChatThreadScreen (UserChatView.vue)
    // pops back here (the request screen) instead of the practice screen this
    // screen was itself reached from (PracticeDetailView.onPurchased, :19 above).
    await router.replace({ name: 'user-chat', params: { id: thread.id } })
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить запрос'))
  } finally {
    sending.value = false
  }
}

function goToDashboard(): void {
  router.push({ name: 'user-dashboard' })
}

onMounted(() => {
  // Load the practice so the title can be shown. Self-contained: works on
  // direct navigation / reload, not only via the booking redirect.
  store.fetchPractice(practiceId)
})
</script>

<style scoped>
.booking-confirmed {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.booking-confirmed__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.booking-confirmed__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* Horizontal rail comes from MobileLayout (--velo-rail-pad-x); vertical only
     here so content sits on the single 24px rail (no double inset). */
  padding: var(--space-4) 0;
}

/* Success card */
.booking-confirmed__card {
  padding: var(--space-5) var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-3);
}

.booking-confirmed__icon {
  width: 88px;
  height: 88px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

.booking-confirmed__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.booking-confirmed__text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
  margin: 0;
}

/* Ask-master block */
.booking-confirmed__ask {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Field + info banner are now the DS VTextarea + Banner components (own styles). */
</style>
