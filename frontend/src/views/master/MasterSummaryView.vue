<!--
  VELO Frontend -- MasterSummaryView (Master DS, 2026-06-11; E6 wiring ПРОМТ №420)

  "Саммари недели" — the master's weekly summary, reached from the dashboard
  summary card ("Подробнее"). Rendered inside MasterShell.

  E6 = three pieces (insight + key feedbacks + needs attention). Recon
  (ПРОМТ №420) found two of three already real, just not wired together on
  this one screen:
    - insight: HONEST STUB. No AI provider exists in this project (backend/
      app/modules/ai/ is a Protocol + MockAIService, explicitly out-of-MVP-
      scope) -- operator 2026-07-15: AI work is Zod's, once the infra exists.
    - key feedbacks: REAL as of this batch. GET /masters/me/reviews
      (MasterReviewItem) already carries a real reviewer user_id (E1
      "remainder", already shipped -- the roadmap doc calling this open was
      stale), so cards are fully navigable to the student profile. No new
      backend needed -- same endpoint AnalyticsView's «Требуют внимания»
      already calls, just without the attention=true filter (this section
      wants a highlight reel, not only the negative bucket).
    - needs attention: was ALREADY real (E5, GET /masters/me/students) before
      this batch -- untouched here.
-->

<template>
  <div class="summary">
    <VHeader title="Саммари недели" show-back @back="router.push({ name: 'master-dashboard' })" />

    <div class="summary__content">
      <!-- AI insight (honest placeholder — no AI provider exists in this
           project yet; Zod builds this once the infra lands). -->
      <h2 class="velo-section-title">AI-инсайты за неделю</h2>
      <VCard>
        <p class="summary__insight">{{ insight }}</p>
      </VCard>

      <!-- Key feedbacks (REAL: GET /masters/me/reviews, cross-practice named
           feed, E1's user_id makes each card navigable). -->
      <h2 class="velo-section-title">Ключевые отзывы</h2>
      <div v-if="feedbacksLoading" class="summary__attn-state">
        <VLoader />
      </div>
      <VEmptyState
        v-else-if="feedbacksError"
        icon="warning"
        title="Не удалось загрузить"
        :description="feedbacksError"
      >
        <VButton size="sm" variant="outline" @click="loadFeedbacks">Повторить</VButton>
      </VEmptyState>
      <template v-else>
        <div
          v-for="(item, i) in keyFeedbacks"
          :key="i"
          class="summary__feedback"
          role="button"
          tabindex="0"
          @click="goStudentFromReview(item)"
          @keydown.enter.space.prevent="goStudentFromReview(item)"
        >
          <component
            :is="RATING_ICON[item.rating as FeedbackRating]"
            :size="36"
            :style="{ color: RATING_ICON_COLOR[item.rating as FeedbackRating] }"
          />
          <div class="summary__feedback-body">
            <div class="summary__feedback-name">{{ item.reviewer_name }}</div>
            <div class="summary__feedback-practice">{{ item.practice_title }}</div>
            <div v-if="item.comment" class="summary__feedback-quote">«{{ item.comment }}»</div>
          </div>
        </div>
        <VEmptyState
          v-if="keyFeedbacks.length === 0"
          variant="note"
          title="Отзывы появятся здесь, когда будут собраны"
        />
      </template>

      <!-- Needs attention (REAL: the master's students with needs_attention).
           Each row taps through to the real student profile; the message button
           is @click.stop so it does not navigate. -->
      <h2 class="velo-section-title">Требуют внимания</h2>
      <div v-if="attnLoading" class="summary__attn-state">
        <VLoader />
      </div>
      <VEmptyState
        v-else-if="attnError"
        icon="warning"
        title="Не удалось загрузить"
        :description="attnError"
      >
        <VButton size="sm" variant="outline" @click="loadStudents">Повторить</VButton>
      </VEmptyState>
      <template v-else>
        <div
          v-for="student in needsAttention"
          :key="student.id"
          class="summary__attn summary__attn--clickable"
          role="button"
          tabindex="0"
          @click="openProfile(student)"
          @keydown.enter.space.prevent="openProfile(student)"
        >
          <VAvatar :name="student.name" size="md" />
          <div class="summary__attn-body">
            <div class="summary__attn-name">{{ student.name }}</div>
            <div class="summary__attn-meta">Практик: {{ student.practices_count }}</div>
            <span class="summary__attn-badge"><IconWarning :size="14" />Требует внимания</span>
          </div>
          <button
            class="summary__msg"
            aria-label="Написать сообщение"
            @click.stop="openMessage(student.name)"
          >
            <IconMessages :size="22" />
          </button>
        </div>
        <VEmptyState
          v-if="needsAttention.length === 0"
          icon="group"
          title="Все ученики в порядке"
          description="Здесь появятся те, кому нужно внимание"
        />
      </template>
    </div>

    <SendMessageModal :open="msgOpen" :name="msgName" @close="msgOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VCard, VAvatar, VLoader, VEmptyState, VButton } from '@/components/ui'
import { IconMessages, IconWarning } from '@/components/icons'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import { getStudents, getMasterReviews } from '@/api/masters'
import { RATING_ICON_COLOR } from '@/utils/displayHelpers'
import { RATING_ICON } from '@/utils/ratingIcons'
import type { StudentListItem, MasterReviewItem, FeedbackRating } from '@/api/types'

const router = useRouter()

// -- HONEST STUB: no AI provider exists in this project (backend/app/
//    modules/ai/ is a Protocol + MockAIService, explicitly out-of-MVP-scope)
//    -- operator 2026-07-15: AI work is Zod's, once that infra lands. --
const insight = ref('Сводка появится, когда подключится аналитика')

// -- Key feedbacks — REAL (E6, ПРОМТ №420): GET /masters/me/reviews, same
//    cross-practice named feed AnalyticsView's «Требуют внимания» uses, but
//    WITHOUT the attention=true filter -- this section is a highlight reel
//    (positive included), not only the negative bucket. Rating icon + color
//    via the shared utils/ratingIcons + RATING_ICON_COLOR. --
const FEEDBACKS_PAGE = 3
const keyFeedbacks = ref<MasterReviewItem[]>([])
const feedbacksLoading = ref(true)
const feedbacksError = ref('')

async function loadFeedbacks(): Promise<void> {
  feedbacksLoading.value = true
  feedbacksError.value = ''
  try {
    const res = await getMasterReviews(FEEDBACKS_PAGE, 0, false)
    keyFeedbacks.value = res.items
  } catch {
    feedbacksError.value = 'Попробуйте ещё раз'
  } finally {
    feedbacksLoading.value = false
  }
}

// user_id is real on MasterReviewItem (E1 remainder, already shipped) --
// mirrors AnalyticsView.goStudent.
function goStudentFromReview(item: MasterReviewItem): void {
  router.push({
    name: 'master-student-profile',
    params: { id: item.user_id },
    query: { name: item.reviewer_name },
  })
}

// -- «Требуют внимания» — REAL (E5: GET /masters/me/students). Same source as
//    MasterStudentsView; show only students flagged needs_attention. --
const students = ref<StudentListItem[]>([])
const attnLoading = ref(true)
const attnError = ref('')

async function loadStudents(): Promise<void> {
  attnLoading.value = true
  attnError.value = ''
  try {
    const res = await getStudents()
    students.value = res.items
  } catch {
    attnError.value = 'Попробуйте ещё раз'
  } finally {
    attnLoading.value = false
  }
}
onMounted(() => {
  void loadStudents()
  void loadFeedbacks()
})

const needsAttention = computed((): StudentListItem[] =>
  students.value.filter((s) => s.needs_attention),
)

// The detail endpoint carries no name → pass it forward (mirror MasterStudentsView).
function openProfile(student: StudentListItem): void {
  router.push({
    name: 'master-student-profile',
    params: { id: student.id },
    query: { name: student.name },
  })
}

const msgOpen = ref(false)
const msgName = ref('')
function openMessage(name: string): void {
  msgName.value = name
  msgOpen.value = true
}
</script>

<style scoped>
.summary {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.summary__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). */
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.summary__insight {
  margin: 0;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  line-height: 1.55;
}

/* -- Key feedbacks (tappable card → student profile; mirrors AnalyticsView's
   .analytics__attention shape, no message-button action here). -- */
.summary__feedback {
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  transition: opacity var(--transition-fast);
}

.summary__feedback:active {
  opacity: 0.85;
}

.summary__feedback-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.summary__feedback-name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.summary__feedback-practice {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.summary__feedback-quote {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  font-style: italic;
}

/* Loader while the students fetch is in flight. */
.summary__attn-state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* -- Needs-attention row (mirrors MasterStudentsView .students__row) -- */
.summary__attn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--space-4);
}

.summary__attn--clickable {
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.summary__attn--clickable:active {
  opacity: 0.85;
}

.summary__attn-body {
  flex: 1;
  min-width: 0;
}

.summary__attn-name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.summary__attn-meta {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-2);
}

/* «Требует внимания» chip — same DS treatment as MasterStudentsView. */
.summary__attn-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-card-gap-icon-title);
  margin-top: var(--velo-gap-6);
  padding: 3px 10px;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-warning-bg);
  color: var(--velo-peach-500);
  font-size: var(--text-xs);
}

.summary__attn-badge svg {
  color: var(--velo-warning);
}

.summary__msg {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.summary__msg:active {
  opacity: 0.85;
}
</style>
